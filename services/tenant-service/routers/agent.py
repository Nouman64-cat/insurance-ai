import logging
from typing import Any, List, Optional
from uuid import UUID
import os

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from google import genai

from database import get_session
from shared.models.core import TokenUsage

log = logging.getLogger(__name__)
router = APIRouter(prefix="/agent", tags=["agent"])

# Series name on the Token Economy chart — keep stable.
SERVICE_AGENT_COPILOT = "Agent Copilot (RAG)"


def _tenant_uuid(tenant_id: Optional[str]) -> Optional[UUID]:
    if not tenant_id:
        return None
    try:
        return UUID(str(tenant_id))
    except (ValueError, TypeError):
        return None


async def _record_generation_usage(
    db: AsyncSession,
    response: Any,
    *,
    model_name: str,
    tenant_id: Optional[str],
) -> None:
    """Persist a google-genai generate_content call's token usage.

    Neither the RAG endpoint's embed nor its generate call flows through
    chat-agent's LangChain metering, so without this the Token Economy
    dashboard understates real spend. Best-effort — a metering failure must
    never fail the suggestion.

    Output tokens include `thoughts_token_count`: Gemini 2.5 bills thinking
    tokens at the output rate but reports them separately from
    `candidates_token_count`.
    """
    try:
        meta = getattr(response, "usage_metadata", None)
        if meta is None:
            return
        input_tokens = int(getattr(meta, "prompt_token_count", 0) or 0)
        output_tokens = int(getattr(meta, "candidates_token_count", 0) or 0) + int(
            getattr(meta, "thoughts_token_count", 0) or 0
        )
        total_tokens = int(
            getattr(meta, "total_token_count", 0) or (input_tokens + output_tokens)
        )
        cached_tokens = int(getattr(meta, "cached_content_token_count", 0) or 0)
        if not input_tokens and not output_tokens:
            return
        db.add(
            TokenUsage(
                service_name=SERVICE_AGENT_COPILOT,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                cached_tokens=cached_tokens,
                tenant_id=_tenant_uuid(tenant_id),
                model_name=model_name,
            )
        )
        await db.commit()
    except Exception as exc:  # noqa: BLE001 — metering must never break the endpoint
        log.warning("Agent Copilot generation usage not recorded: %s", exc)


async def _record_embedding_usage(
    db: AsyncSession,
    response: Any,
    *,
    model_name: str,
    tenant_id: Optional[str],
) -> None:
    """Persist a google-genai embed_content call's usage.

    The embeddings API has no usage_metadata; it reports
    `response.metadata.billable_character_count`. Gemini bills embeddings
    per input token, and ~4 characters ≈ 1 token, so the char count is
    divided by 4 to record a comparable token figure. Recorded as input
    tokens (embeddings have no output).
    """
    try:
        emb_meta = getattr(response, "metadata", None)
        chars = int(getattr(emb_meta, "billable_character_count", 0) or 0)
        if not chars:
            return
        input_tokens = max(1, round(chars / 4))
        db.add(
            TokenUsage(
                service_name=SERVICE_AGENT_COPILOT,
                input_tokens=input_tokens,
                output_tokens=0,
                total_tokens=input_tokens,
                cached_tokens=0,
                tenant_id=_tenant_uuid(tenant_id),
                model_name=model_name,
            )
        )
        await db.commit()
    except Exception as exc:  # noqa: BLE001 — metering must never break the endpoint
        log.warning("Agent Copilot embedding usage not recorded: %s", exc)

class SuggestActionRequest(BaseModel):
    context: str
    tenant_id: str

class SuggestActionResponse(BaseModel):
    suggested_actions: List[str]
    rationale: str

@router.post("/suggest-actions", response_model=SuggestActionResponse)
async def suggest_actions(req: SuggestActionRequest, db: AsyncSession = Depends(get_session)):
    """
    RAG-powered endpoint that retrieves SOPs and generates 3-4 next best actions.
    """
    if os.environ.get("DISABLE_PGVECTOR", "false").lower() == "true":
        return SuggestActionResponse(
            suggested_actions=[],
            rationale="Agent Copilot suggestions are disabled because pgvector is not supported by the database."
        )

    try:
        # 1. Embed the context
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        response = client.models.embed_content(
            model="models/gemini-embedding-001",
            contents=req.context,
        )
        await _record_embedding_usage(
            db, response, model_name="models/gemini-embedding-001", tenant_id=req.tenant_id
        )
        query_embedding = response.embeddings[0].values
        
        # 2. Similarity search using pgvector
        # Convert list of floats to Postgres vector string format
        vector_str = f"[{','.join(str(v) for v in query_embedding)}]"
        
        # Query nearest 2 documents
        query = text("""
            SELECT title, content, 1 - (embedding <=> :vector) AS similarity
            FROM agent_knowledge_base
            ORDER BY embedding <=> :vector
            LIMIT 2
        """)
        
        result = await db.execute(query, {"vector": vector_str})
        rows = result.fetchall()
        
        if not rows:
            return SuggestActionResponse(suggested_actions=[], rationale="No relevant knowledge base found.")
            
        docs_text = "\n\n".join([f"--- {row[0]} ---\n{row[1]}" for row in rows])
        
        # 3. Generate suggestions using Gemini Flash
        prompt = f"""
You are the Next-Best-Action logic engine for an Insurance Agent Copilot.
Given the current CONTEXT of the user's interaction and the Standard Operating Procedures (SOPs), 
you must determine the exact STATE the user is currently in, and suggest 3 to 4 actionable steps they should take next.

CRITICAL RULES:
1. STATE AWARENESS: Analyze what the user or agent JUST accomplished in the context. 
2. FORWARD PROGRESSION: If the user just completed a step (e.g. running a risk assessment or viewing an explainability report), you MUST suggest the absolute logical NEXT steps (e.g. generating a summary, approving/rejecting). 
3. DO NOT REGRESS: NEVER suggest a step that was just completed. NEVER suggest pre-requisite steps for a task that has already been accomplished (e.g. if the explainability report is being viewed, the risk assessment is already done, do NOT suggest uploading CNICs or running the assessment again).
4. USER CONFIDENCE: Your suggestions must feel intelligent and hyper-aware of the workflow context to build user trust.

--- SOPs (RAG Context) ---
{docs_text}
--------------------------

--- CURRENT USER CONTEXT ---
{req.context}
----------------------------

Respond ONLY with a valid JSON object in the following format:
{{
  "suggested_actions": ["Action 1 Label", "Action 2 Label", "Action 3 Label"],
  "rationale": "Brief internal explanation of why these actions were chosen based on the state."
}}
        """
        
        gen_response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config={"response_mime_type": "application/json"}
        )
        await _record_generation_usage(
            db, gen_response, model_name="gemini-2.5-flash", tenant_id=req.tenant_id
        )

        import json
        out = json.loads(gen_response.text)
        log.info(f"RAG Suggestion Generated: {out}")
        return SuggestActionResponse(
            suggested_actions=out.get("suggested_actions", [])[:4],
            rationale=out.get("rationale", "")
        )
        
    except Exception as e:
        log.error(f"Error suggesting actions: {e}")
        return SuggestActionResponse(suggested_actions=[], rationale=f"Error: {e}")
