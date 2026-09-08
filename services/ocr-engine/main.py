import asyncio
import json
import logging
import os
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from fastapi.responses import StreamingResponse

import llm_provider
from llm_provider import NoProviderConfigured, PdfProviderUnavailable

log = logging.getLogger("ocr-engine")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")

async def _record_token_usage(usage_dict: dict, model_name: str = "unknown"):
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{TENANT_SERVICE_URL}/tokens/usage",
                json={
                    "service_name": "OCR Engine",
                    "model_name": model_name,
                    "input_tokens": usage_dict["input"],
                    "output_tokens": usage_dict["output"],
                    "total_tokens": usage_dict["total"]
                },
                timeout=5.0
            )
    except Exception as e:
        print(f"Failed to record token usage: {e}")

# this is System prompt

OCR_PROMPT = (
    "You are a highly capable multimodal document analysis and visual intelligence engine for an insurance platform. "
    "Your task is to extract and analyze all information from the provided image or document.\n\n"
    "First, identify the type of input:\n\n"
    "── TYPE A: Text-heavy documents (forms, PDFs, prescriptions, contracts, invoices) ──\n"
    "1. Extract all visible text exactly as written, preserving original layout, spacing, and line breaks.\n"
    "2. For handwritten text, signatures, or annotations, extract them in their correct spatial position.\n"
    "3. For tables, forms, or key-value structures, format them as Markdown tables or aligned key: value pairs.\n\n"
    "── TYPE B: Visual/scene images (X-rays, MRIs, accident scenes, crime scenes, damage photos) ──\n"
    "1. Extract any visible text, labels, annotations, dates, scale markers, or overlaid text.\n"
    "2. Provide a structured visual analysis of what you observe:\n"
    "   - For medical images (X-ray, MRI, CT, ultrasound): describe the body part, visible findings, abnormalities, fractures, lesions, opacity changes, or any clinically relevant observations.\n"
    "   - For accident/damage photos: describe the type of incident, affected areas, severity of damage, vehicle parts involved, environmental conditions, and any visible injuries.\n"
    "   - For crime scene photos: describe the scene layout, visible evidence, damage patterns, and any relevant contextual details.\n"
    "3. Structure your output with clear sections: 'Extracted Text' (if any) and 'Visual Analysis'.\n\n"
    "General rules:\n"
    "- Be precise and factual. Do not speculate beyond what is visually evident.\n"
    "- Do not add conversational commentary or introductory phrases.\n"
    "- If an image contains both text and visual scene content, handle both accordingly."
)

SUPPORTED_EXTENSIONS = {"pdf", "png", "jpg", "jpeg", "tiff", "bmp"}

MIME_MAP = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "tiff": "image/tiff",
    "bmp": "image/bmp",
}

app = FastAPI(
    title="OCR Extraction Service",
    description="Microservice for extracting text from images and PDFs using Gemini 2.5 Flash.",
    version="2.0.0"
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


def _text_of(content) -> str:
    """LangChain message content is str for these providers, but be defensive."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content if isinstance(b, dict)
        )
    return str(content or "")


async def _run_ocr(file_bytes: bytes, mime_type: str) -> dict:
    """Run OCR against the configured primary model, failing over to the
    fallback on error. Raises PdfProviderUnavailable / NoProviderConfigured."""
    cfg = await llm_provider.resolve()
    chain, dropped_for_pdf = llm_provider.provider_chain(cfg, mime_type)

    last_exc: Exception | None = None
    for entry in chain:
        try:
            model = llm_provider.build_model(entry)
            messages = llm_provider.messages_for(entry, OCR_PROMPT, file_bytes, mime_type)
            response = await model.ainvoke(messages)
            return {
                "text": _text_of(response.content),
                "token_usage": llm_provider.usage_of(response),
                "model_name": llm_provider.model_of(response),
            }
        except (PdfProviderUnavailable, NoProviderConfigured):
            raise
        except Exception as exc:  # noqa: BLE001 — try the next provider
            last_exc = exc
            log.warning("OCR via %s failed: %s", entry.get("provider"), exc)
    if dropped_for_pdf:
        raise PdfProviderUnavailable(
            f"PDF OCR failed on the PDF-capable provider(s) ({last_exc}) and the "
            "configured fallback (OpenAI) can't read PDFs. Fix the primary "
            "provider or set a Gemini/Anthropic fallback in Platform → LLM "
            "Configuration."
        )
    raise RuntimeError(f"All OCR providers failed. Last error: {last_exc}")


async def _stream_ocr_sse(file_bytes: bytes, mime_type: str):
    try:
        cfg = await llm_provider.resolve()
        chain, dropped_for_pdf = llm_provider.provider_chain(cfg, mime_type)
    except (PdfProviderUnavailable, NoProviderConfigured) as exc:
        yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        return

    last_exc: Exception | None = None
    for idx, entry in enumerate(chain):
        try:
            model = llm_provider.build_model(entry, streaming=True)
            messages = llm_provider.messages_for(entry, OCR_PROMPT, file_bytes, mime_type)
            final = None
            async for chunk in model.astream(messages):
                text = _text_of(chunk.content)
                if text:
                    yield f"data: {json.dumps({'type': 'chunk', 'text': text})}\n\n"
                final = chunk if final is None else (final + chunk)
            usage = llm_provider.usage_of(final)
            model_name = llm_provider.model_of(final)
            yield f"data: {json.dumps({'type': 'done', 'token_usage': usage})}\n\n"
            asyncio.create_task(_record_token_usage(usage, model_name))
            return
        except Exception as exc:  # noqa: BLE001 — fail over, or report if last
            last_exc = exc
            log.warning("OCR stream via %s failed: %s", entry.get("provider"), exc)
            if idx == len(chain) - 1:
                msg = str(exc)
                if dropped_for_pdf:
                    msg = (
                        f"PDF OCR failed ({exc}) and the configured fallback (OpenAI) "
                        "can't read PDFs — set a Gemini/Anthropic fallback in "
                        "Platform → LLM Configuration."
                    )
                yield f"data: {json.dumps({'type': 'error', 'message': msg})}\n\n"


@app.get("/health")
async def health_check():
    try:
        cfg = await llm_provider.resolve()
        primary = (cfg.get("primary") or {})
        fallback = (cfg.get("fallback") or {})
        return {
            "status": "healthy",
            "primary": f"{primary.get('provider')}/{primary.get('model')}",
            "fallback": f"{fallback.get('provider')}/{fallback.get('model')}" if fallback else None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "healthy", "config_error": str(exc)}


@app.post("/extract")
async def extract_text(file: UploadFile = File(...)):
    """Accepts a multipart file upload (PDF or image) and returns extracted text."""
    file_ext = file.filename.lower().split(".")[-1]
    if file_ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format. Supported: {', '.join(SUPPORTED_EXTENSIONS).upper()}",
        )

    file_bytes = await file.read()
    mime_type = MIME_MAP[file_ext]

    try:
        result = await _run_ocr(file_bytes, mime_type)
        asyncio.create_task(_record_token_usage(result["token_usage"], result["model_name"]))
        return {
            "filename": file.filename,
            "extracted_text": result["text"],
            "token_usage": result["token_usage"],
        }
    except PdfProviderUnavailable as e:
        raise HTTPException(status_code=422, detail=str(e))
    except NoProviderConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR Processing Error: {str(e)}")


@app.post("/extract/stream")
async def extract_text_stream(file: UploadFile = File(...)):
    """Streams OCR extraction as Server-Sent Events — no HTTP timeout for large docs."""
    file_ext = file.filename.lower().split(".")[-1]
    if file_ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format. Supported: {', '.join(SUPPORTED_EXTENSIONS).upper()}",
        )

    file_bytes = await file.read()
    mime_type = MIME_MAP[file_ext]

    return StreamingResponse(
        _stream_ocr_sse(file_bytes, mime_type),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/extract-from-path")
async def extract_text_from_path(input_path: str, output_path: str | None = None):
    """Processes a file from a shared volume path and optionally writes output to disk."""
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail=f"File not found at: {input_path}")

    file_ext = input_path.lower().split(".")[-1]
    if file_ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file format.")

    mime_type = MIME_MAP[file_ext]

    try:
        with open(input_path, "rb") as f:
            file_bytes = f.read()

        result = await _run_ocr(file_bytes, mime_type)
        asyncio.create_task(_record_token_usage(result["token_usage"], result["model_name"]))

        if output_path:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(result["text"])

        return {
            "status": "success",
            "input_file": input_path,
            "saved_to": output_path,
            "extracted_text": result["text"],
            "token_usage": result["token_usage"],
        }
    except PdfProviderUnavailable as e:
        raise HTTPException(status_code=422, detail=str(e))
    except NoProviderConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
