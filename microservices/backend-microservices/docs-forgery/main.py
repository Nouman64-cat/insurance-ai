"""HTTP interface for document-forensics analysis."""

from enum import Enum
from platform_config import configuration, record_usage

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse
from performance import Metrics

from docforensics import Layer2Options, Layer3Options, analyze_document
from docforensics import MAX_FILE_SIZE, detect_type
from docforensics.gemini_client import make_client
from docforensics.layer3 import availability, load_thresholds, threshold_summary
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
    try:
        config = configuration()
        policy_status = "connected" if config else "standalone"
    except HTTPException:
        config, policy_status = None, "unavailable"
    calibration = threshold_summary(_thresholds(config))
    return {"service": "docs-forgery", "status": "healthy",
            "platform_configuration": policy_status,
            "analysis_policy": {k: config["settings"][k] for k in ("enabled", "content_enabled", "pixel_enabled", "visual_enabled", "provider", "max_pages")} if config else None,
            "pixel_forensics": {"available": ready, "reason": reason, "calibrated": calibration is not None, "calibration": calibration}}


def _thresholds(config):
    baseline = load_thresholds()
    if config and config["settings"]["threshold_mode"] == "manual":
        settings = config["settings"]
        return {"t95": settings["t95"], "tmax": settings["tmax"], "model": "trufor",
                "severity_at_tmax": "LOW", "n_calibration": 0, "scope": "superadmin_manual",
                "created_at": config.get("updated_at"), "max_side": 1024}
    return baseline


def _analyze(data, name, doc_type, layer2, provider, visual, max_pages, layer3, config=None):
    # Construct a client per request so call logs and rate-limit state are not
    # shared across concurrent analyses. Layer 1 never needs a provider.
    settings = config["settings"] if config else {}
    overrides = {"model": settings[provider.value + "_model"]} if settings else {}
    client = make_client(provider.value, **overrides) if layer2 else None
    analysis = analyze_document(
        data, name, doc_type.value if doc_type else None,
        layer2=layer2, client=client,
        options=Layer2Options(visual=visual, max_pages=max_pages),
        layer3=layer3, layer3_options=Layer3Options(max_pages=max_pages, timeout_s=settings.get("pixel_timeout_seconds", 300), thresholds=_thresholds(config)),
    )
    report = analysis.report.to_dict()
    report["performance"] = analysis.performance
    if analysis.performance:
        metrics.observe(analysis.performance, analysis.report.verdict.value, layer2, layer3)
    if analysis.layer3 is not None:
        report["pixel_forensics"] = {
            "model": "TruFor", "calibrated": analysis.layer3.calibration is not None,
            "calibration": analysis.layer3.calibration,
            "seconds": analysis.layer3.seconds, "pages": analysis.layer3.pages,
        }
    record_usage(analysis, client, config)
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
    config = await run_in_threadpool(configuration)
    if config:
        settings = config["settings"]
        if not settings["enabled"]:
            raise HTTPException(503, "Document Forgery Detection is disabled by SuperAdmin.")
        if (layer2 and not settings["content_enabled"]) or (layer3 and not settings["pixel_enabled"]) or (visual and not settings["visual_enabled"]):
            raise HTTPException(403, "The requested analysis option is disabled by SuperAdmin.")
        if max_pages > settings["max_pages"]:
            raise HTTPException(422, f"SuperAdmin limits analysis to {settings['max_pages']} pages.")
        if layer2 and provider.value != settings["provider"]:
            raise HTTPException(422, f"SuperAdmin configured {settings['provider']} as the content provider. Select that provider and confirm consent.")
    # The engine and provider clients are synchronous; keep them off the event loop.
    return await run_in_threadpool(
        _analyze, data, name, doc_type, layer2, provider, visual, max_pages, layer3, config,
    )
