import os
import base64
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import google.generativeai as genai

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set")

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel("gemini-2.5-flash")

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


def _run_ocr(file_bytes: bytes, mime_type: str) -> dict:
    response = model.generate_content([
        OCR_PROMPT,
        {"mime_type": mime_type, "data": base64.b64encode(file_bytes).decode()},
    ])
    usage = response.usage_metadata
    return {
        "text": response.text,
        "token_usage": {
            "input": usage.prompt_token_count,
            "output": usage.candidates_token_count,
            "total": usage.total_token_count,
        },
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy", "engine": "Gemini 2.5 Flash", "model": "gemini-2.5-flash"}


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
        result = _run_ocr(file_bytes, mime_type)
        return {
            "filename": file.filename,
            "extracted_text": result["text"],
            "token_usage": result["token_usage"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR Processing Error: {str(e)}")


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

        result = _run_ocr(file_bytes, mime_type)

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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
