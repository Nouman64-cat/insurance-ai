import json
import os
import asyncio
import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx

import llm_provider
from llm_provider import NoProviderConfigured

log = logging.getLogger("text-summarizer")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")


async def _record_token_usage(usage_dict: dict, model_name: str = "unknown"):
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{TENANT_SERVICE_URL}/tokens/usage",
                json={
                    "service_name": "Text Summarizer",
                    "model_name": model_name,
                    "input_tokens": usage_dict["input"],
                    "output_tokens": usage_dict["output"],
                    "total_tokens": usage_dict["total"],
                },
                timeout=5.0,
            )
    except Exception as e:
        print(f"Failed to record token usage: {e}")


app = FastAPI(
    title="Text Summarizer Service",
    description="Summarizes OCR-extracted text using the platform's configured LLM (primary + fallback).",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://localhost:3003",
        "http://localhost:3004",
        "http://localhost:3005",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SummarizeRequest(BaseModel):
    documents: list[str]
    max_words: int | None = None


class UnderwriterNoteRequest(BaseModel):
    """Structured case context used to draft a concise underwriter note.
    The frontend assembles `context` from the customer, policy, risk scores,
    AI decision, and explainability reasons already on screen."""
    context: str
    max_words: int | None = 90


class TokenUsage(BaseModel):
    input: int
    output: int
    total: int


class SummarizeResponse(BaseModel):
    summary: str
    token_usage: TokenUsage


def _build_prompt(request: SummarizeRequest) -> str:
    prompt = (
        f"You are an expert insurance document analyst. You have exactly {len(request.documents)} distinct documents "
        f"extracted via OCR from an insurance underwriting platform. These may include medical images (X-rays, MRIs), "
        f"accident scene photos, crime scene photos, damage assessments, or standard insurance documents.\n"
        f"You MUST provide a distinct, structured summary for EVERY single document. Do not skip any.\n\n"
        f"FORMAT RULES (strictly follow):\n"
        f"- Use markdown formatting throughout your response\n"
        f"- Use ## for each document heading (e.g. ## Document 1 — X-Ray Report)\n"
        f"- Use ### for sub-sections within each document\n"
        f"- Use bullet points (- ) for lists of findings, damages, or details\n"
        f"- Use **bold** for key terms, diagnoses, severity indicators, and critical values\n"
        f"- End each document summary with a ### Key Takeaway section\n"
    )
    if request.max_words:
        prompt += f"- Keep each document summary under {request.max_words} words\n"
    prompt += "\nHere are the documents:\n"
    for i, doc_text in enumerate(request.documents):
        prompt += f"\n<document_{i+1}>\n{doc_text}\n</document_{i+1}>\n"
    return prompt


def _build_underwriting_prompt(request: SummarizeRequest) -> str:
    """Same input shape as _build_prompt, but organizes the output by
    underwriting concern (Medical / Financial / Occupational) instead of by
    source document — this is what feeds RiskAssessment.ai_summary from the
    Case Detail workbench.
    """
    prompt = (
        f"You are an expert life insurance underwriter. You have {len(request.documents)} OCR-extracted "
        f"documents (CNIC, medical reports, salary slips, bank statements, employment letters, etc.) for a "
        f"single customer's underwriting case.\n\n"
        f"Read across ALL documents together and produce EXACTLY three sections, pulling only the facts "
        f"relevant to each — synthesize across documents rather than summarizing them one by one:\n\n"
        f"FORMAT RULES (strictly follow):\n"
        f"- Use markdown formatting\n"
        f"- Exactly three ## headings, in this order: '## Medical Factors', '## Financial Factors', "
        f"'## Occupational Factors'\n"
        f"- Under each heading, use bullet points (- ) for concrete facts found in the documents "
        f"(diagnoses, medications, income figures, employer/job title, years of experience, hazard "
        f"indicators, account balances, etc.)\n"
        f"- Use **bold** for key values (amounts, diagnoses, job titles)\n"
        f"- If a section has no supporting evidence in the documents, write a single bullet: "
        f"'- No relevant information found in the uploaded documents.'\n"
        f"- Do not invent facts not present in the documents\n"
    )
    if request.max_words:
        prompt += f"- Keep the entire response under {request.max_words} words\n"
    prompt += "\nHere are the documents:\n"
    for i, doc_text in enumerate(request.documents):
        prompt += f"\n<document_{i+1}>\n{doc_text}\n</document_{i+1}>\n"
    return prompt


def _build_underwriter_note_prompt(request: UnderwriterNoteRequest) -> str:
    """Draft a short, human-sounding internal underwriter note from the case
    context. Plain prose (no markdown) so it drops straight into the notes
    textarea for the underwriter to review and edit before posting."""
    max_words = request.max_words or 90
    return (
        "You are an experienced life insurance underwriter writing a brief internal "
        "case note for the file. Based only on the case data below, write a concise "
        f"note (2-4 sentences, under {max_words} words) that captures what is going on "
        "with this case: who the applicant is, the main medical / financial / fraud risk "
        "drivers, and the AI's recommended decision. Write in plain professional prose — "
        "no markdown, no headings, no bullet points. Do not invent facts that are not in "
        "the data.\n\n"
        f"CASE DATA:\n{request.context}\n"
    )


async def _summarize(prompt: str, *, strip: bool = False) -> SummarizeResponse:
    try:
        result = await llm_provider.run(prompt)
    except NoProviderConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        msg = str(e) or "Unknown error during summarization"
        raise HTTPException(status_code=500, detail=f"Summarization error: {msg}")

    usage = result["usage"]
    asyncio.create_task(_record_token_usage(usage, result["model_name"]))
    summary = result["text"].strip() if strip else result["text"]
    return SummarizeResponse(summary=summary, token_usage=TokenUsage(**usage))


async def _stream_summarize_sse(prompt: str):
    async for ev in llm_provider.stream(prompt):
        if ev.get("type") == "done":
            asyncio.create_task(
                _record_token_usage(ev["token_usage"], ev.get("model_name", "unknown"))
            )
            ev = {"type": "done", "token_usage": ev["token_usage"]}
        yield f"data: {json.dumps(ev)}\n\n"


@app.get("/health")
async def health_check():
    try:
        cfg = await llm_provider.resolve()
        primary = cfg.get("primary") or {}
        fallback = cfg.get("fallback") or {}
        return {
            "status": "healthy",
            "primary": f"{primary.get('provider')}/{primary.get('model')}",
            "fallback": f"{fallback.get('provider')}/{fallback.get('model')}" if fallback else None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "healthy", "config_error": str(exc)}


@app.post("/summarize", response_model=SummarizeResponse)
async def summarize_text(request: SummarizeRequest):
    if not request.documents:
        raise HTTPException(status_code=400, detail="Documents list must not be empty.")
    return await _summarize(_build_prompt(request))


@app.post("/summarize/underwriting", response_model=SummarizeResponse)
async def summarize_underwriting(request: SummarizeRequest):
    """Category-organized variant of /summarize for the Case Detail workbench
    — Medical / Financial / Occupational sections instead of per-document."""
    if not request.documents:
        raise HTTPException(status_code=400, detail="Documents list must not be empty.")
    return await _summarize(_build_underwriting_prompt(request))


@app.post("/summarize/underwriter-note", response_model=SummarizeResponse)
async def summarize_underwriter_note(request: UnderwriterNoteRequest):
    """Draft a concise internal underwriter note from the case context shown on
    the Case Detail workbench (customer, policy, risk scores, decision, reasons)."""
    if not request.context or not request.context.strip():
        raise HTTPException(status_code=400, detail="Context must not be empty.")
    return await _summarize(_build_underwriter_note_prompt(request), strip=True)


@app.post("/summarize/stream")
async def summarize_text_stream(request: SummarizeRequest):
    """Streams summarization as Server-Sent Events — no HTTP timeout for large documents."""
    if not request.documents:
        raise HTTPException(status_code=400, detail="Documents list must not be empty.")

    return StreamingResponse(
        _stream_summarize_sse(_build_prompt(request)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
