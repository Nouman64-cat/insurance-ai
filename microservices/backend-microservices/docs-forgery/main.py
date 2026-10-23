"""HTTP interface for document-forensics analysis."""

from enum import Enum

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse
from performance import Metrics

from docforensics import Layer2Options, Layer3Options, analyze_document
from docforensics import MAX_FILE_SIZE, detect_type
from docforensics.gemini_client import make_client
from docforensics.layer3 import availability, load_thresholds
from schemas import AnalysisResponse

app = FastAPI(title="Document Forensics Service", version="1.0.0")
metrics = Metrics()


@app.middleware("http")
async def count_analysis_requests(request, call_next):
    if request.url.path != "/analyze":
        return await call_next(request)
    try:
        response = await call_next(request)
    except Exception:
        metrics.observe_http(500)
        raise
    metrics.observe_http(response.status_code)
    return response


@app.get("/performance")
def performance_summary():
    return metrics.snapshot()


@app.get("/metrics", response_class=PlainTextResponse)
def prometheus_metrics():
    return PlainTextResponse(metrics.prometheus(), media_type="text/plain; version=0.0.4")


class DocumentType(str, Enum):
    bank_statement = "bank_statement"
    payslip = "payslip"
    invoice = "invoice"
    receipt = "receipt"
    other = "other"


class Provider(str, Enum):
    gemini = "gemini"
    groq = "groq"


@app.get("/health")
def health():
    ready, reason = availability()
    return {"service": "docs-forgery", "status": "healthy",
            "pixel_forensics": {"available": ready, "reason": reason, "calibrated": load_thresholds() is not None}}


def _analyze(data, name, doc_type, layer2, provider, visual, max_pages, layer3):
    # Construct a client per request so call logs and rate-limit state are not
    # shared across concurrent analyses. Layer 1 never needs a provider.
    client = make_client(provider.value) if layer2 else None
    analysis = analyze_document(
        data, name, doc_type.value if doc_type else None,
        layer2=layer2, client=client,
        options=Layer2Options(visual=visual, max_pages=max_pages),
        layer3=layer3, layer3_options=Layer3Options(max_pages=max_pages),
    )
    report = analysis.report.to_dict()
    report["performance"] = analysis.performance
    if analysis.performance:
        metrics.observe(analysis.performance, analysis.report.verdict.value, layer2, layer3)
    if analysis.layer3 is not None:
        report["pixel_forensics"] = {
            "model": "TruFor", "calibrated": load_thresholds() is not None,
            "seconds": analysis.layer3.seconds, "pages": analysis.layer3.pages,
        }
    return report


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze(
    file: UploadFile = File(...),
    doc_type: DocumentType | None = Form(None),
    layer2: bool = Form(False, description="Send document pages to the selected model provider."),
    provider: Provider = Form(Provider.gemini),
    visual: bool = Form(False, description="Additional model visual inspection (requires layer2)."),
    max_pages: int = Form(4, ge=1, le=40, description="Page limit for Layers 2 and 3."),
    layer3: bool = Form(False, description="Run the bundled local TruFor CPU model."),
):
    try:
        # Read only up to the limit plus one byte before invoking the engine.
        data = await file.read(MAX_FILE_SIZE + 1)
        name = file.filename or "upload"
    finally:
        await file.close()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="Maximum document size is 100 MiB.")
    if detect_type(data) == "unknown":
        raise HTTPException(status_code=415, detail="Unsupported document content. Upload a PDF or supported image.")
    # The engine and provider clients are synchronous; keep them off the event loop.
    return await run_in_threadpool(
        _analyze, data, name, doc_type, layer2, provider, visual, max_pages, layer3,
    )
