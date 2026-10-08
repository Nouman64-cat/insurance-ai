import asyncio
import json
import logging
import os
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

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


async def _run_ocr(file_bytes: bytes, mime_type: str, prompt: str = OCR_PROMPT) -> dict:
    """Run OCR against the configured primary model, failing over to the
    fallback on error. Raises PdfProviderUnavailable / NoProviderConfigured."""
    cfg = await llm_provider.resolve()
    chain, dropped_for_pdf = llm_provider.provider_chain(cfg, mime_type)

    last_exc: Exception | None = None
    for entry in chain:
        # A timeout or a dropped connection is usually the provider having a slow moment, not a bad request: try the
        # same provider once more before giving up on it and moving down the chain.
        for attempt in (1, 2):
            try:
                model = llm_provider.build_model(entry)
                messages = llm_provider.messages_for(entry, prompt, file_bytes, mime_type)
                response = await model.ainvoke(messages)
                return {
                    "text": _text_of(response.content),
                    "token_usage": llm_provider.usage_of(response),
                    "model_name": llm_provider.model_of(response),
                }
            except (PdfProviderUnavailable, NoProviderConfigured):
                raise
            except Exception as exc:  # noqa: BLE001 — retry once if transient, else try the next provider
                last_exc = exc
                transient = isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or any(
                    w in str(exc).lower() for w in ("timed out", "timeout", "connection error", "connection reset", "temporarily"))
                log.warning("OCR via %s failed (attempt %d): %s", entry.get("provider"), attempt, exc)
                if not (transient and attempt == 1):
                    break
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


CUSTOMER_PROVINCES = [
    "Punjab", "Sindh", "Khyber Pakhtunkhwa", "Balochistan",
    "Gilgit-Baltistan", "Azad Jammu & Kashmir", "Islamabad Capital Territory",
]
_PROVINCE_ALIASES = {
    "kpk": "Khyber Pakhtunkhwa", "k.p.k": "Khyber Pakhtunkhwa", "khyber pakhtunkhawa": "Khyber Pakhtunkhwa",
    "nwfp": "Khyber Pakhtunkhwa", "gb": "Gilgit-Baltistan", "gilgit baltistan": "Gilgit-Baltistan",
    "ajk": "Azad Jammu & Kashmir", "azad kashmir": "Azad Jammu & Kashmir", "azad jammu and kashmir": "Azad Jammu & Kashmir",
    "ict": "Islamabad Capital Territory", "islamabad": "Islamabad Capital Territory",
}

CUSTOMER_FIELDS = (
    # Tab 1: Identity & Contact
    "first_name", "last_name", "cnic", "date_of_birth", "gender", "marital_status",
    "mobile_number", "email", "emergency_contact_name", "street_address", "city",
    "province", "postal_code",
    # Tab 2: CNIC & Docs
    "cnic_issue_date", "cnic_expiry_date", "cnic_validation_status",
    # Tab 3: Occupation & Income
    "employment_type", "occupation", "employer_name", "industry", "years_of_experience",
    "occupation_hazard_level", "declared_annual_income", "monthly_income", "income_stability_score",
    # Tab 4: Medical & Lifestyle
    "has_pre_existing_conditions", "is_smoker", "is_diabetic", "medical_conditions",
    "height_cm", "weight_kg", "exercise_frequency",
    # Tab 5: Habit Check
    "smoking_status", "alcohol_consumption_frequency", "recreational_drug_use_history",
    "participates_in_extreme_sports", "extreme_sports_details", "private_aviation",
    "frequent_high_risk_travel", "travel_destinations", "moving_violations_past_3_years",
    "dui_dwi_history", "criminal_record",
    # Tab 6: Financial Profile
    "credit_score", "delinquency_count", "risk_grade", "number_of_dependents", "dependent_type",
    # Tab 7: Nominee Details
    "beneficiary_first_name", "beneficiary_last_name", "beneficiary_cnic",
    "beneficiary_relationship", "beneficiary_share",
    # Tab 8: Insurance Plans
    "insurance_plan_name", "policy_coverage", "policy_term",
    "dependent_name", "dependent_dob",
)

CUSTOMER_EXTRACT_PROMPT = (
    "You are a comprehensive data-extraction engine for an insurance onboarding and underwriting system. "
    "The input is a personal document (e.g. an application form, customer diagnostic sheet, CNIC, salary slip, "
    "or insurance proposal). Read it thoroughly and return ONLY one valid JSON object — no prose, no Markdown fences.\n\n"
    "CRITICAL FORMAT REQUIREMENT:\n"
    "Return ONLY a single FLAT JSON object with the exact keys listed below at the top level. "
    "Do NOT group or nest keys under section or tab names (e.g. do NOT create objects like {\"Identity & Contact\": {...}} or {\"Tab 1\": {...}}). "
    "Every key must be a direct top-level property of the JSON object.\n\n"
    "Identity & Contact (Tab 1):\n"
    "- first_name: string (given name)\n"
    "- last_name: string (surname / family name)\n"
    "- cnic: string (13 digits formatted XXXXX-XXXXXXX-X)\n"
    "- date_of_birth: string (YYYY-MM-DD)\n"
    "- gender: exactly one of Male, Female, Other\n"
    "- marital_status: exactly one of Single, Married, Divorced, Widowed\n"
    "- mobile_number: string\n"
    "- email: string\n"
    "- emergency_contact_name: string\n"
    "- street_address: string\n"
    "- city: string\n"
    f"- province: exactly one of {', '.join(CUSTOMER_PROVINCES)}\n"
    "- postal_code: string\n\n"
    "CNIC & Docs (Tab 2):\n"
    "- cnic_issue_date: string (YYYY-MM-DD)\n"
    "- cnic_expiry_date: string (YYYY-MM-DD)\n"
    "- cnic_validation_status: exactly one of Valid, Invalid, Expired, Unverifiable\n\n"
    "Occupation & Income (Tab 3):\n"
    "- employment_type: exactly one of Salaried, Self-Employed, Business, Unemployed, Retired, Student\n"
    "- occupation: string\n"
    "- employer_name: string\n"
    "- industry: string\n"
    "- years_of_experience: integer\n"
    "- occupation_hazard_level: exactly one of Low, Medium, High, VeryHigh\n"
    "- declared_annual_income: number in PKR (if only monthly salary stated, multiply by 12)\n"
    "- monthly_income: number in PKR\n"
    "- income_stability_score: integer from 1 to 100\n\n"
    "Medical & Lifestyle (Tab 4):\n"
    "- has_pre_existing_conditions: boolean (true/false)\n"
    "- is_smoker: boolean (true/false)\n"
    "- is_diabetic: boolean (true/false)\n"
    "- medical_conditions: list of objects [{\"condition_name\": string, \"severity\": 'Mild'|'Moderate'|'Severe'}] or empty list\n"
    "- height_cm: number in centimeters\n"
    "- weight_kg: number in kilograms\n"
    "- exercise_frequency: exactly one of Sedentary, Light, Moderate, Active, VeryActive\n\n"
    "Habit Check (Tab 5):\n"
    "- smoking_status: exactly one of Non-smoker, Occasional, Heavy Smoker, Vaper, Chewing Tobacco\n"
    "- alcohol_consumption_frequency: exactly one of None, Occasional, Moderate, Heavy\n"
    "- recreational_drug_use_history: boolean (true/false)\n"
    "- participates_in_extreme_sports: boolean (true/false)\n"
    "- extreme_sports_details: list of strings (e.g. Skydiving, Scuba Diving (past 100ft), Bungee Jumping, Rock/Ice Climbing, Motorsports/Racing)\n"
    "- private_aviation: boolean (true/false)\n"
    "- frequent_high_risk_travel: boolean (true/false)\n"
    "- travel_destinations: list of strings (destinations visited/planned)\n"
    "- moving_violations_past_3_years: integer\n"
    "- dui_dwi_history: boolean (true/false)\n"
    "- criminal_record: boolean (true/false)\n\n"
    "Financial Profile (Tab 6):\n"
    "- credit_score: integer (credit score, e.g. 780)\n"
    "- delinquency_count: integer\n"
    "- risk_grade: exactly one of A, B, C, D, E, F\n"
    "- number_of_dependents: integer\n"
    "- dependent_type: exactly one of Spouse, Child, Parent, Sibling, Other\n\n"
    "Nominee Details (Tab 7):\n"
    "- beneficiary_first_name: string\n"
    "- beneficiary_last_name: string\n"
    "- beneficiary_cnic: string (13 digits formatted XXXXX-XXXXXXX-X)\n"
    "- beneficiary_relationship: exactly one of Spouse, Parent, Child, Sibling, Guardian, Other\n"
    "- beneficiary_share: integer percentage (e.g. 100)\n\n"
    "Insurance Plans (Tab 8):\n"
    "- insurance_plan_name: string (e.g. Salary Protection Plan or Term Life)\n"
    "- policy_coverage: number in PKR\n"
    "- policy_term: integer in years\n"
    "- dependent_name: string or null\n"
    "- dependent_dob: string (YYYY-MM-DD) or null\n\n"
    "Rules:\n"
    "- Use null for any value that is NOT explicitly mentioned or cannot be determined from the document. Never guess.\n"
    "- The person is the applicant / document holder.\n"
    "- Read values carefully exactly as written."
)


def _clean_customer_fields(raw: dict) -> dict:
    """Validate and normalise what the model returned. Anything that doesn't
    pass is dropped to None so the form leaves that field empty for manual
    entry, rather than being filled with a plausible-looking wrong value."""
    import re
    from datetime import datetime

    # Flatten nested structures (e.g. if the LLM grouped keys by section/tab)
    flat_raw: dict = {}

    def _flatten(d: dict):
        for k, v in d.items():
            if isinstance(v, dict):
                _flatten(v)
            else:
                flat_raw[k] = v

    if isinstance(raw, dict):
        _flatten(raw)

    def text(v):
        if v is None:
            return None
        v = str(v).strip()
        return v or None

    def clean_cnic(v):
        if not v:
            return None
        digits = re.sub(r"\D", "", str(v))
        return f"{digits[:5]}-{digits[5:12]}-{digits[12]}" if len(digits) == 13 else None

    def clean_date(v):
        if not v:
            return None
        try:
            return datetime.strptime(str(v)[:10], "%Y-%m-%d").date().isoformat()
        except ValueError:
            return None

    def clean_bool(v):
        if v is None:
            return None
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            v_lower = v.strip().lower()
            if v_lower in ("true", "yes", "y", "1"):
                return True
            if v_lower in ("false", "no", "n", "0", "none"):
                return False
        return None

    def clean_num(v, is_int=False):
        if v is None or v == "":
            return None
        try:
            cleaned = str(v).replace(",", "").replace("$", "").replace("PKR", "").replace("pkr", "").strip()
            num = float(cleaned)
            return int(round(num)) if is_int else num
        except (ValueError, TypeError):
            return None

    out: dict = {k: None for k in CUSTOMER_FIELDS}

    # Text fields
    for k in (
        "first_name", "last_name", "mobile_number", "emergency_contact_name",
        "street_address", "city", "postal_code", "occupation", "employer_name",
        "industry", "insurance_plan_name", "beneficiary_first_name",
        "beneficiary_last_name", "dependent_name",
    ):
        out[k] = text(flat_raw.get(k))

    # CNICs
    out["cnic"] = clean_cnic(flat_raw.get("cnic"))
    out["beneficiary_cnic"] = clean_cnic(flat_raw.get("beneficiary_cnic"))

    # Dates
    out["date_of_birth"] = clean_date(flat_raw.get("date_of_birth"))
    out["cnic_issue_date"] = clean_date(flat_raw.get("cnic_issue_date"))
    out["cnic_expiry_date"] = clean_date(flat_raw.get("cnic_expiry_date"))
    out["dependent_dob"] = clean_date(flat_raw.get("dependent_dob"))

    # Enums
    for key, allowed in (
        ("gender", ("Male", "Female", "Other")),
        ("marital_status", ("Single", "Married", "Divorced", "Widowed")),
        ("cnic_validation_status", ("Valid", "Invalid", "Expired", "Unverifiable")),
        ("employment_type", ("Salaried", "Self-Employed", "Business", "Unemployed", "Retired", "Student")),
        ("occupation_hazard_level", ("Low", "Medium", "High", "VeryHigh")),
        ("exercise_frequency", ("Sedentary", "Light", "Moderate", "Active", "VeryActive")),
        ("smoking_status", ("Non-smoker", "Occasional", "Heavy Smoker", "Vaper", "Chewing Tobacco")),
        ("alcohol_consumption_frequency", ("None", "Occasional", "Moderate", "Heavy")),
        ("dependent_type", ("Spouse", "Child", "Parent", "Sibling", "Other")),
        ("beneficiary_relationship", ("Spouse", "Parent", "Child", "Sibling", "Guardian", "Other")),
    ):
        val = text(flat_raw.get(key))
        if val:
            norm_val = val.lower().replace("-", " ").replace(" ", "")
            match = next((a for a in allowed if a.lower().replace("-", " ").replace(" ", "") == norm_val), None)
            out[key] = match

    # Risk grade (A, B, C, D, E, F)
    rg = text(flat_raw.get("risk_grade"))
    if rg:
        rg_clean = rg.upper().replace("GRADE", "").strip()
        out["risk_grade"] = rg_clean if rg_clean in ("A", "B", "C", "D", "E", "F") else None

    # Province
    prov = (text(flat_raw.get("province")) or "").lower()
    out["province"] = next(
        (p for p in CUSTOMER_PROVINCES if p.lower() == prov), _PROVINCE_ALIASES.get(prov)
    )

    # Email
    email = text(flat_raw.get("email"))
    out["email"] = email if email and re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) else None

    # Numbers
    out["declared_annual_income"] = clean_num(flat_raw.get("declared_annual_income"))
    out["monthly_income"] = clean_num(flat_raw.get("monthly_income"))
    out["years_of_experience"] = clean_num(flat_raw.get("years_of_experience"), is_int=True)
    out["income_stability_score"] = clean_num(flat_raw.get("income_stability_score"), is_int=True)
    out["height_cm"] = clean_num(flat_raw.get("height_cm"))
    out["weight_kg"] = clean_num(flat_raw.get("weight_kg"))
    out["moving_violations_past_3_years"] = clean_num(flat_raw.get("moving_violations_past_3_years"), is_int=True)
    out["credit_score"] = clean_num(flat_raw.get("credit_score"), is_int=True)
    out["delinquency_count"] = clean_num(flat_raw.get("delinquency_count"), is_int=True)
    out["number_of_dependents"] = clean_num(flat_raw.get("number_of_dependents"), is_int=True)
    out["beneficiary_share"] = clean_num(flat_raw.get("beneficiary_share"), is_int=True)
    out["policy_coverage"] = clean_num(flat_raw.get("policy_coverage"))
    out["policy_term"] = clean_num(flat_raw.get("policy_term"), is_int=True)

    # Booleans
    for b_key in (
        "has_pre_existing_conditions", "is_smoker", "is_diabetic",
        "recreational_drug_use_history", "participates_in_extreme_sports",
        "private_aviation", "frequent_high_risk_travel", "dui_dwi_history",
        "criminal_record",
    ):
        out[b_key] = clean_bool(flat_raw.get(b_key))

    # Lists
    # medical_conditions
    med_conds = flat_raw.get("medical_conditions")
    if isinstance(med_conds, list) and med_conds:
        clean_conds = []
        for c in med_conds:
            if isinstance(c, dict) and c.get("condition_name"):
                sev = text(c.get("severity")) or "Mild"
                sev_match = next((s for s in ("Mild", "Moderate", "Severe") if s.lower() == sev.lower()), "Mild")
                clean_conds.append({"condition_name": text(c.get("condition_name")), "severity": sev_match})
        out["medical_conditions"] = clean_conds if clean_conds else None
    else:
        out["medical_conditions"] = None

    # extreme_sports_details
    esd = flat_raw.get("extreme_sports_details")
    if isinstance(esd, list) and esd:
        cleaned_esd = [str(item).strip() for item in esd if str(item).strip()]
        out["extreme_sports_details"] = cleaned_esd if cleaned_esd else None
    elif isinstance(esd, str) and esd.strip() and esd.strip().lower() != "none":
        out["extreme_sports_details"] = [esd.strip()]
    else:
        out["extreme_sports_details"] = None

    # travel_destinations
    td = flat_raw.get("travel_destinations")
    if isinstance(td, list) and td:
        cleaned_td = [str(item).strip() for item in td if str(item).strip()]
        out["travel_destinations"] = cleaned_td if cleaned_td else None
    elif isinstance(td, str) and td.strip() and td.strip().lower() != "none":
        out["travel_destinations"] = [td.strip()]
    else:
        out["travel_destinations"] = None

    return out


def _parse_json_object(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        cleaned = cleaned.rsplit("```", 1)[0]
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("The model did not return a JSON object.")
    return json.loads(cleaned[start:end + 1])


CUSTOMER_PDF_MAX_PAGES = 3


def _pdf_pages_as_png(pdf_bytes: bytes, dpi: int = 130) -> list[bytes]:
    """First few pages of a PDF as PNGs. Empty list if PyMuPDF isn't available
    or the PDF can't be opened, so the caller can surface the original error."""
    try:
        import pymupdf
    except ImportError:
        return []
    try:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
            return [
                page.get_pixmap(dpi=dpi).tobytes("png")
                for page in list(doc)[:CUSTOMER_PDF_MAX_PAGES]
            ]
    except Exception as exc:  # noqa: BLE001 — corrupt/encrypted PDF
        log.warning("Could not render PDF pages: %s", exc)
        return []


CUSTOMER_UPLOAD_EXTENSIONS = {"pdf", "png", "jpg", "jpeg"}
CUSTOMER_UPLOAD_MAX_BYTES = 10 * 1024 * 1024


@app.post("/extract-customer")
async def extract_customer_fields(file: UploadFile = File(...)):
    """Read a PDF / PNG / JPG and return the customer-form fields found in it.

    Fields the document doesn't contain come back as null — the caller leaves
    those empty (and highlights them) rather than filling in guesses.
    """
    file_ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if file_ext not in CUSTOMER_UPLOAD_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported format. Upload a PDF, PNG or JPG file.")

    file_bytes = await file.read()
    if len(file_bytes) > CUSTOMER_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File is too large (max 10 MB).")
    if not file_bytes:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    try:
        try:
            results = [await _run_ocr(file_bytes, MIME_MAP[file_ext], prompt=CUSTOMER_EXTRACT_PROMPT)]
        except PdfProviderUnavailable:
            # The configured model (e.g. OpenAI) can't ingest PDFs, but it can
            # read images — so read the PDF's pages as images instead.
            pages = _pdf_pages_as_png(file_bytes)
            if not pages:
                raise
            results = list(await asyncio.gather(*[_run_ocr(png, "image/png", prompt=CUSTOMER_EXTRACT_PROMPT) for png in pages]))

        fields = {k: None for k in CUSTOMER_FIELDS}
        usage = {"input": 0, "output": 0, "total": 0}
        for idx, result in enumerate(results):
            asyncio.create_task(_record_token_usage(result["token_usage"], result["model_name"]))
            for k in usage:
                usage[k] += result["token_usage"].get(k, 0)
            try:
                raw_json = _parse_json_object(result["text"])
                page_fields = _clean_customer_fields(raw_json)
            except (ValueError, json.JSONDecodeError) as exc:
                if len(results) == 1:
                    raise HTTPException(status_code=422, detail=f"Could not read structured details from this document ({exc}).")
                continue
            # Earlier pages win; later pages only fill what is still missing.
            fields = {k: fields[k] if fields[k] is not None else page_fields[k] for k in CUSTOMER_FIELDS}
        return {
            "filename": file.filename,
            "fields": fields,
            "found": sum(1 for v in fields.values() if v is not None),
            "token_usage": usage,
        }
    except HTTPException:
        raise
    except PdfProviderUnavailable as e:
        raise HTTPException(status_code=422, detail=str(e))
    except NoProviderConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction error: {str(e)}")


# ── Family group document ────────────────────────────────────────────────────
# One document describes the whole household: the family, the policy being proposed
# and every member. Same contract as /extract-customer — anything the document does
# not state comes back null so the form leaves it empty (and highlights it).

FAMILY_FIELDS = (
    "family_name", "contact_person", "contact_email", "contact_phone",
    "household_declared_income", "city", "province",
    "policy_type", "total_sum_insured", "term_years", "effective_date", "discount_percentage",
)
FAMILY_MEMBER_FIELDS = (
    "cnic", "name", "dob", "gender", "relationship", "occupation", "declared_income",
    "is_smoker", "height_cm", "weight_kg", "coverage_amount", "plan_name",
    "is_insured", "share_pct",
)
FAMILY_MAX_MEMBERS = 8

FAMILY_EXTRACT_PROMPT = (
    "You are a data-extraction engine for an insurance onboarding system. The input is a FAMILY "
    "insurance proposal / household form. Read it thoroughly and return ONLY one valid JSON object — "
    "no prose, no Markdown fences — with exactly this shape:\n"
    "{\n"
    '  "family_name": string|null,            // e.g. "Rehman Family"\n'
    '  "contact_person": string|null,         // the proposer\n'
    '  "contact_email": string|null,\n'
    '  "contact_phone": string|null,\n'
    '  "household_declared_income": number|null,   // household annual income, PKR\n'
    '  "city": string|null,\n'
    '  "province": string|null,               // Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Jammu & Kashmir\n'
    '  "policy_type": "Floater"|"LifeBundle"|null,  // Health Floater = one shared pool; Life Bundle = each member has their own life cover\n'
    '  "total_sum_insured": number|null,      // Floater only: the shared pool, PKR\n'
    '  "term_years": number|null,\n'
    '  "effective_date": "YYYY-MM-DD"|null,\n'
    '  "discount_percentage": number|null,    // Life Bundle only\n'
    '  "members": [ {\n'
    '      "cnic": string|null, "name": string|null, "dob": "YYYY-MM-DD"|null,\n'
    '      "gender": "Male"|"Female"|null,\n'
    '      "relationship": "Self"|"Spouse"|"Child"|"Parent"|"Sibling"|"Other"|null,   // the proposer / head of family is Self\n'
    '      "is_insured": boolean|null,        // Self is always true. Only a Spouse can be insured: true if the form says the spouse is fully insured / covered, false if only a nominee. Everyone else false.\n'
    '      "share_pct": number|null,          // this person\'s share of the head\'s death benefit in % (nominee share). null for Self.\n'
    '      "occupation": string|null, "declared_income": number|null,   // annual PKR; only for insured members\n'
    '      "is_smoker": boolean|null, "height_cm": number|null, "weight_kg": number|null,\n'
    '      "coverage_amount": number|null,    // Life Bundle only: this member\'s own sum assured\n'
    '      "plan_name": string|null           // Life Bundle only: the life plan chosen for this member\n'
    '  } ]\n'
    "}\n\n"
    "Rules:\n"
    "- Use null for any value that is NOT explicitly stated. Never guess or invent.\n"
    "- List every household member in the document, in the order written, at most 8.\n"
    "- Read values exactly as written."
)


import re as _re
from datetime import datetime as _datetime


def _c_text(v):
    v = None if v is None else str(v).strip()
    return v or None


def _c_num(v, is_int=False):
    if v in (None, ""):
        return None
    try:
        n = float(str(v).replace(",", "").replace("PKR", "").replace("pkr", "").replace("%", "").strip())
        return int(round(n)) if is_int else n
    except (ValueError, TypeError):
        return None


def _c_date(v):
    try:
        return _datetime.strptime(str(v)[:10], "%Y-%m-%d").date().isoformat() if v else None
    except ValueError:
        return None


def _c_cnic(v):
    digits = _re.sub(r"\D", "", str(v or ""))
    return f"{digits[:5]}-{digits[5:12]}-{digits[12]}" if len(digits) == 13 else None


def _c_bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        low = v.strip().lower()
        if low in ("true", "yes", "y", "1"):
            return True
        if low in ("false", "no", "n", "0", "none"):
            return False
    return None


def _c_choice(v, options):
    low = str(v or "").strip().lower().replace(" ", "")
    return next((o for o in options if o.lower().replace(" ", "") == low), None)


def _c_province(v):
    v = _c_text(v)
    if not v:
        return None
    v = _PROVINCE_ALIASES.get(v.lower(), v)
    return v if v in CUSTOMER_PROVINCES else None


def _clean_family_fields(raw: dict) -> dict:
    """Validate what the model returned; anything that does not pass becomes None."""
    text, num, date_, cnic, boolean, choice = _c_text, _c_num, _c_date, _c_cnic, _c_bool, _c_choice

    raw = raw if isinstance(raw, dict) else {}
    province = _c_province(raw.get("province"))

    family = {
        "family_name": text(raw.get("family_name")), "contact_person": text(raw.get("contact_person")),
        "contact_email": text(raw.get("contact_email")), "contact_phone": text(raw.get("contact_phone")),
        "household_declared_income": num(raw.get("household_declared_income")),
        "city": text(raw.get("city")), "province": province,
        "policy_type": choice(raw.get("policy_type"), ("Floater", "LifeBundle")),
        "total_sum_insured": num(raw.get("total_sum_insured")), "term_years": num(raw.get("term_years"), True),
        "effective_date": date_(raw.get("effective_date")), "discount_percentage": num(raw.get("discount_percentage")),
    }
    members = []
    for m in (raw.get("members") if isinstance(raw.get("members"), list) else [])[:FAMILY_MAX_MEMBERS]:
        if not isinstance(m, dict):
            continue
        row = {
            "cnic": cnic(m.get("cnic")), "name": text(m.get("name")), "dob": date_(m.get("dob")),
            "gender": choice(m.get("gender"), ("Male", "Female")),
            "relationship": choice(m.get("relationship"), ("Self", "Spouse", "Child", "Parent", "Sibling", "Other")),
            "occupation": text(m.get("occupation")), "declared_income": num(m.get("declared_income")),
            "is_smoker": boolean(m.get("is_smoker")), "height_cm": num(m.get("height_cm")), "weight_kg": num(m.get("weight_kg")),
            "coverage_amount": num(m.get("coverage_amount")), "plan_name": text(m.get("plan_name")),
            "is_insured": boolean(m.get("is_insured")), "share_pct": num(m.get("share_pct")),
        }
        # Only the head and a spouse can be insured; anyone else is a nominee whatever the model said.
        if row["relationship"] == "Self":
            row["is_insured"], row["share_pct"] = True, None
        elif row["relationship"] not in (None, "Spouse"):
            row["is_insured"] = False
        if any(v is not None for v in row.values()):
            members.append(row)
    return {"family": family, "members": members}


@app.post("/extract-family")
async def extract_family_fields(file: UploadFile = File(...)):
    """Read a PDF / PNG / JPG describing a household and return the family, its policy and its members."""
    file_ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if file_ext not in CUSTOMER_UPLOAD_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported format. Upload a PDF, PNG or JPG file.")
    file_bytes = await file.read()
    if len(file_bytes) > CUSTOMER_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File is too large (max 10 MB).")
    if not file_bytes:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    try:
        try:
            results = [await _run_ocr(file_bytes, MIME_MAP[file_ext], prompt=FAMILY_EXTRACT_PROMPT)]
        except PdfProviderUnavailable:
            pages = _pdf_pages_as_png(file_bytes)
            if not pages:
                raise
            results = list(await asyncio.gather(*[_run_ocr(png, "image/png", prompt=FAMILY_EXTRACT_PROMPT) for png in pages]))

        family = {k: None for k in FAMILY_FIELDS}
        members: list = []
        usage = {"input": 0, "output": 0, "total": 0}
        for result in results:
            asyncio.create_task(_record_token_usage(result["token_usage"], result["model_name"]))
            for k in usage:
                usage[k] += result["token_usage"].get(k, 0)
            try:
                page = _clean_family_fields(_parse_json_object(result["text"]))
            except (ValueError, json.JSONDecodeError) as exc:
                if len(results) == 1:
                    raise HTTPException(status_code=422, detail=f"Could not read structured details from this document ({exc}).")
                continue
            # Earlier pages win; later pages fill what is still missing and add members not seen yet.
            family = {k: family[k] if family[k] is not None else page["family"][k] for k in FAMILY_FIELDS}
            seen = {m["cnic"] for m in members if m.get("cnic")}
            members += [m for m in page["members"] if not (m.get("cnic") and m["cnic"] in seen)]
        members = members[:FAMILY_MAX_MEMBERS]
        found = sum(1 for v in family.values() if v is not None) + sum(1 for m in members for v in m.values() if v is not None)
        return {"filename": file.filename, "family": family, "members": members, "found": found, "token_usage": usage}
    except HTTPException:
        raise
    except PdfProviderUnavailable as e:
        raise HTTPException(status_code=422, detail=str(e))
    except NoProviderConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction error: {str(e)}")


# ── Corporate (organization) document ─────────────────────────────────────────
# One document describes the company, the group policy being proposed, its benefit classes
# and the employee census. Same contract as /extract-family.

ORG_MAX_EMPLOYEES = 60
ORG_MAX_CLASSES = 10
ORG_MAX_DEPENDANTS = 120
ORG_MAX_NOMINEES = 120
_RIDER_TYPES = ("AccidentalDeath", "Disability", "PayContinuation", "FeeContinuation")

ORGANIZATION_EXTRACT_PROMPT = (
    "You are a data-extraction engine for an insurance onboarding system. The input is a CORPORATE "
    "group life insurance proposal: the company, the group policy requested, the benefit classes, the "
    "employee list, and the employees' dependants and nominees. Read it thoroughly and return ONLY one valid "
    "JSON object — no prose, no Markdown fences — with exactly this shape:\n"
    "{\n"
    '  "company": { "name": string|null, "registration_number": string|null, "industry": string|null,\n'
    '               "contact_person": string|null, "contact_email": string|null, "contact_phone": string|null,\n'
    '               "city": string|null, "province": string|null },\n'
    '  "policy": { "plan_name": string|null,          // e.g. "Group Life", "Group Life — SME", "Group Family Takaful"\n'
    '              "sum_assured_multiple": number|null, // default cover as a multiple of monthly basic salary\n'
    '              "term_years": number|null, "effective_date": "YYYY-MM-DD"|null },\n'
    '  "classes": [ { "name": string|null, "basis": "Flat"|"SalaryMultiple"|"ServiceBanded"|"LoanBalance"|null,\n'
    '                 "flat_amount": number|null, "salary_multiple": number|null,\n'
    '                 "service_bands": [ {"min_years": number, "amount": number} ]|null,\n'
    '                 "grades": [string]|null, "min_cover": number|null, "max_cover": number|null, "is_default": boolean|null,\n'
    '                 "coverages": [ {"coverage_type": "AccidentalDeath"|"Disability"|"PayContinuation"|"FeeContinuation",\n'
    '                                 "percent_of_base": number, "max_amount": number|null} ]|null } ],   // extra benefits, % of life cover\n'
    '  "employees": [ { "cnic": string|null, "name": string|null, "dob": "YYYY-MM-DD"|null, "gender": "Male"|"Female"|null,\n'
    '                   "occupation": string|null, "declared_income": number|null,   // annual PKR\n'
    '                   "employee_id": string|null, "designation": string|null, "grade": string|null,\n'
    '                   "joining_date": "YYYY-MM-DD"|null, "basic_monthly_salary": number|null,\n'
    '                   "benefit_class": string|null, "is_smoker": boolean|null, "height_cm": number|null,\n'
    '                   "weight_kg": number|null, "loan_amount": number|null } ],\n'
    '  "dependants": [ { "employee_ref": string|null,   // the employee\'s Employee ID (or CNIC) exactly as written\n'
    '                    "name": string|null, "relationship": "Spouse"|"Child"|"Parent"|null, "dob": "YYYY-MM-DD"|null,\n'
    '                    "cnic": string|null, "gender": "Male"|"Female"|null, "covered_amount": number|null } ],\n'
    '  "nominees": [ { "employee_ref": string|null, "name": string|null,\n'
    '                  "relationship": "Spouse"|"Child"|"Parent"|"Sibling"|"Other"|null, "cnic": string|null,\n'
    '                  "share_pct": number|null, "date_of_birth": "YYYY-MM-DD"|null, "is_minor": boolean|null,\n'
    '                  "guardian_name": string|null } ]\n'
    "}\n\n"
    "Rules:\n"
    "- Use null for any value that is NOT explicitly stated. Never guess or invent. Use [] for a list the document does not have.\n"
    "- The employee census may be split across two tables that share the Emp ID column — merge them into ONE employee object per Emp ID.\n"
    "- \"employees\" holds ONLY the people in the employee census tables. The dependants and nominees tables list other people — never repeat them under \"employees\".\n"
    "- A class's \"coverages\" come from the extra-benefits table for THAT class only; do not copy one class's benefits to another.\n"
    "- Section headings often state how many rows follow (e.g. \"10 employees\", \"6 dependants\"). Return exactly that many, "
    "going row by row from the first to the last — do not skip or merge rows.\n"
    "- List every benefit class, employee, dependant and nominee, in the order written.\n"
    "- Read values exactly as written."
)


def _clean_organization_fields(raw: dict) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    c, p = raw.get("company") or {}, raw.get("policy") or {}
    company = {
        "name": _c_text(c.get("name")), "registration_number": _c_text(c.get("registration_number")),
        "industry": _c_text(c.get("industry")), "contact_person": _c_text(c.get("contact_person")),
        "contact_email": _c_text(c.get("contact_email")), "contact_phone": _c_text(c.get("contact_phone")),
        "city": _c_text(c.get("city")), "province": _c_province(c.get("province")),
    }
    policy = {
        "plan_name": _c_text(p.get("plan_name")), "sum_assured_multiple": _c_num(p.get("sum_assured_multiple")),
        "term_years": _c_num(p.get("term_years"), True), "effective_date": _c_date(p.get("effective_date")),
    }

    def items(key, limit):
        return [x for x in (raw.get(key) if isinstance(raw.get(key), list) else [])[:limit] if isinstance(x, dict)]

    classes = []
    for k in items("classes", ORG_MAX_CLASSES):
        grades = [g for g in (_c_text(g) for g in (k.get("grades") if isinstance(k.get("grades"), list) else [])) if g]
        bands = []
        for b in (k.get("service_bands") if isinstance(k.get("service_bands"), list) else []):
            if isinstance(b, dict) and _c_num(b.get("min_years")) is not None and _c_num(b.get("amount")) is not None:
                bands.append({"min_years": _c_num(b["min_years"], True), "amount": _c_num(b["amount"])})
        coverages = []
        for v in (k.get("coverages") if isinstance(k.get("coverages"), list) else []):
            kind = _c_choice(v.get("coverage_type"), _RIDER_TYPES) if isinstance(v, dict) else None
            if kind and _c_num(v.get("percent_of_base")) is not None:
                coverages.append({"coverage_type": kind, "percent_of_base": _c_num(v["percent_of_base"]), "max_amount": _c_num(v.get("max_amount"))})
        row = {
            "name": _c_text(k.get("name")), "basis": _c_choice(k.get("basis"), ("Flat", "SalaryMultiple", "ServiceBanded", "LoanBalance")),
            "flat_amount": _c_num(k.get("flat_amount")), "salary_multiple": _c_num(k.get("salary_multiple")),
            "service_bands": bands or None, "grades": grades or None, "min_cover": _c_num(k.get("min_cover")),
            "max_cover": _c_num(k.get("max_cover")), "is_default": _c_bool(k.get("is_default")), "coverages": coverages or None,
        }
        if row["name"]:
            classes.append(row)

    employees = []
    for e in items("employees", ORG_MAX_EMPLOYEES):
        row = {
            "cnic": _c_cnic(e.get("cnic")), "name": _c_text(e.get("name")), "dob": _c_date(e.get("dob")),
            "gender": _c_choice(e.get("gender"), ("Male", "Female")), "occupation": _c_text(e.get("occupation")),
            "declared_income": _c_num(e.get("declared_income")), "employee_id": _c_text(e.get("employee_id")),
            "designation": _c_text(e.get("designation")), "grade": _c_text(e.get("grade")),
            "joining_date": _c_date(e.get("joining_date")), "basic_monthly_salary": _c_num(e.get("basic_monthly_salary")),
            "benefit_class": _c_text(e.get("benefit_class")), "is_smoker": _c_bool(e.get("is_smoker")),
            "height_cm": _c_num(e.get("height_cm")), "weight_kg": _c_num(e.get("weight_kg")), "loan_amount": _c_num(e.get("loan_amount")),
        }
        # A census row carries pay, class or occupation; a person lifted from the dependants / nominees
        # tables doesn't, so it is not an employee.
        if any(row[k] is not None for k in ("declared_income", "basic_monthly_salary", "benefit_class", "occupation")):
            employees.append(row)

    dependants = []
    for d in items("dependants", ORG_MAX_DEPENDANTS):
        row = {
            "employee_ref": _c_text(d.get("employee_ref")), "name": _c_text(d.get("name")),
            "relationship": _c_choice(d.get("relationship"), ("Spouse", "Child", "Parent")), "dob": _c_date(d.get("dob")),
            "cnic": _c_cnic(d.get("cnic")), "gender": _c_choice(d.get("gender"), ("Male", "Female")), "covered_amount": _c_num(d.get("covered_amount")),
        }
        if row["name"]:
            dependants.append(row)

    nominees = []
    for n in items("nominees", ORG_MAX_NOMINEES):
        row = {
            "employee_ref": _c_text(n.get("employee_ref")), "name": _c_text(n.get("name")),
            "relationship": _c_choice(n.get("relationship"), ("Spouse", "Child", "Parent", "Sibling", "Other")),
            "cnic": _c_cnic(n.get("cnic")), "share_pct": _c_num(n.get("share_pct")), "date_of_birth": _c_date(n.get("date_of_birth")),
            "is_minor": _c_bool(n.get("is_minor")), "guardian_name": _c_text(n.get("guardian_name")),
        }
        if row["name"]:
            nominees.append(row)
    return {"company": company, "policy": policy, "classes": classes, "employees": employees, "dependants": dependants, "nominees": nominees}


@app.post("/extract-organization")
async def extract_organization_fields(file: UploadFile = File(...)):
    """Read a PDF / PNG / JPG describing a company's group scheme: company, policy, classes and employees."""
    file_ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if file_ext not in CUSTOMER_UPLOAD_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported format. Upload a PDF, PNG or JPG file.")
    file_bytes = await file.read()
    if len(file_bytes) > CUSTOMER_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File is too large (max 10 MB).")
    if not file_bytes:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    try:
        try:
            results = [await _run_ocr(file_bytes, MIME_MAP[file_ext], prompt=ORGANIZATION_EXTRACT_PROMPT)]
        except PdfProviderUnavailable:
            pages = _pdf_pages_as_png(file_bytes, dpi=180)   # census tables are dense; digits need the extra resolution
            if not pages:
                raise
            results = list(await asyncio.gather(*[_run_ocr(png, "image/png", prompt=ORGANIZATION_EXTRACT_PROMPT) for png in pages]))

        company = {k: None for k in ("name", "registration_number", "industry", "contact_person", "contact_email", "contact_phone", "city", "province")}
        policy = {k: None for k in ("plan_name", "sum_assured_multiple", "term_years", "effective_date")}
        classes: list = []
        employees: list = []
        dependants: list = []
        nominees: list = []
        usage = {"input": 0, "output": 0, "total": 0}
        for result in results:
            asyncio.create_task(_record_token_usage(result["token_usage"], result["model_name"]))
            for k in usage:
                usage[k] += result["token_usage"].get(k, 0)
            try:
                page = _clean_organization_fields(_parse_json_object(result["text"]))
            except (ValueError, json.JSONDecodeError) as exc:
                if len(results) == 1:
                    raise HTTPException(status_code=422, detail=f"Could not read structured details from this document ({exc}).")
                continue
            # Earlier pages win; later pages fill what is missing and add classes / employees not yet seen.
            company = {k: company[k] if company[k] is not None else page["company"][k] for k in company}
            policy = {k: policy[k] if policy[k] is not None else page["policy"][k] for k in policy}
            names = {k["name"].lower() for k in classes}
            classes += [k for k in page["classes"] if k["name"].lower() not in names]
            seen = {e["cnic"] for e in employees if e.get("cnic")}
            employees += [e for e in page["employees"] if not (e.get("cnic") and e["cnic"] in seen)]
            dependants += page["dependants"]
            nominees += page["nominees"]
        classes, employees = classes[:ORG_MAX_CLASSES], employees[:ORG_MAX_EMPLOYEES]
        dependants, nominees = dependants[:ORG_MAX_DEPENDANTS], nominees[:ORG_MAX_NOMINEES]
        found = (sum(v is not None for v in company.values()) + sum(v is not None for v in policy.values())
                 + sum(v is not None for rows in (classes, employees, dependants, nominees) for r in rows for v in r.values()))
        return {"filename": file.filename, "company": company, "policy": policy, "classes": classes, "employees": employees,
                "dependants": dependants, "nominees": nominees, "found": found, "token_usage": usage}
    except HTTPException:
        raise
    except PdfProviderUnavailable as e:
        raise HTTPException(status_code=422, detail=str(e))
    except NoProviderConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction error: {str(e)}")


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


# ─────────────────────────────────────────────────────────────────────────────
# Structured document-understanding — per-document-type fact extraction over
# already-OCR'd text. Used by tenant-service/ocr_worker.py so the Underwriting
# Profile (shared/underwriting/profile.py) gets real structured evidence
# instead of the fabricated placeholder entities the old regex extractor
# returned for any document it couldn't parse.
# ─────────────────────────────────────────────────────────────────────────────

_MEDICAL_REPORT_PROMPT = (
    "You are extracting structured clinical facts from an already-OCR'd medical "
    "document for insurance underwriting. Return ONLY a JSON object with these keys: "
    '{"conditions": [string], "medications": [string], "blood_pressure": string|null, '
    '"physician_findings": [string]}. Use an empty list / null for anything not present. '
    "Never invent a finding that is not supported by the text."
)
_INCOME_EVIDENCE_PROMPT = (
    "You are extracting verified income facts from an already-OCR'd salary slip or bank "
    "statement for insurance underwriting. Return ONLY a JSON object with these keys: "
    '{"verified_monthly_income": number|null, "employer": string|null}. '
    "Use null for anything not present. Never invent a number that is not in the text."
)
_IDENTITY_EVIDENCE_PROMPT = (
    "You are extracting identity facts from an already-OCR'd national ID / CNIC document "
    'for insurance underwriting. Return ONLY a JSON object: {"cnic": string|null, '
    '"name": string|null, "dob": string|null}. dob must be YYYY-MM-DD or null. '
    "Use null for anything not present."
)
_GENERIC_EVIDENCE_PROMPT = (
    "Summarize the key facts in this already-OCR'd document relevant to insurance "
    'underwriting. Return ONLY a JSON object: {"summary": string}.'
)

_MEDICAL_KEYWORDS = ("medical", "diagnos", "lab", "physician", "health", "ecg")
_INCOME_KEYWORDS = ("salary", "income", "bank", "statement", "tax")
_IDENTITY_KEYWORDS = ("cnic", "identity", "passport", "id card")


def _structured_prompt_for(document_type: str) -> tuple[str, list[str]]:
    lowered = (document_type or "").lower()
    if any(kw in lowered for kw in _MEDICAL_KEYWORDS):
        return _MEDICAL_REPORT_PROMPT, ["conditions", "medications", "blood_pressure", "physician_findings"]
    if any(kw in lowered for kw in _INCOME_KEYWORDS):
        return _INCOME_EVIDENCE_PROMPT, ["verified_monthly_income", "employer"]
    if any(kw in lowered for kw in _IDENTITY_KEYWORDS):
        return _IDENTITY_EVIDENCE_PROMPT, ["cnic", "name", "dob"]
    return _GENERIC_EVIDENCE_PROMPT, ["summary"]


class ExtractStructuredRequest(BaseModel):
    extracted_text: str
    document_type: str


@app.post("/extract-structured")
async def extract_structured(body: ExtractStructuredRequest):
    """Text-only structured extraction — no file, no vision call. Returns
    empty fields (never a fabricated default) when the text is blank or
    every configured provider fails, so a caller never mistakes "nothing
    extracted" for "nothing present"."""
    keys_for_type = _structured_prompt_for(body.document_type)[1]
    if not body.extracted_text or not body.extracted_text.strip():
        return {"fields": {k: None for k in keys_for_type}, "document_type": body.document_type}

    prompt, keys = _structured_prompt_for(body.document_type)
    try:
        cfg = await llm_provider.resolve()
        chain, _ = llm_provider.provider_chain(cfg, mime_type="text/plain")
    except (NoProviderConfigured, PdfProviderUnavailable) as exc:
        log.warning("extract-structured: no provider available (%s)", exc)
        return {"fields": {k: None for k in keys}, "document_type": body.document_type}

    for entry in chain:
        try:
            model = llm_provider.build_model(entry)
            response = await model.ainvoke([SystemMessage(content=prompt), HumanMessage(content=body.extracted_text)])
            asyncio.create_task(_record_token_usage(llm_provider.usage_of(response), llm_provider.model_of(response)))
            parsed = _parse_json_object(response.content)
            return {"fields": {k: parsed.get(k) for k in keys}, "document_type": body.document_type}
        except Exception as exc:  # noqa: BLE001 — try the next provider in the chain
            log.warning("extract-structured provider %s failed: %s", entry.get("provider"), exc)
            continue

    return {"fields": {k: None for k in keys}, "document_type": body.document_type}
