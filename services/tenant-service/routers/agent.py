import logging
from typing import List, Optional
import os

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from google import genai

from database import get_session

log = logging.getLogger(__name__)
router = APIRouter(prefix="/agent", tags=["agent"])

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
