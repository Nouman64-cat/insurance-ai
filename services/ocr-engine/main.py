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
    "You are a highly capable multimodal OCR and document parsing engine. "
    "Your task is to extract all textual and structured information from the provided document or image. "
    "This includes printed text, handwriting, annotations, forms, medical scans/imaging (e.g., X-ray labels, "
    "patient info, measurements, clinical annotations), and accident photos/claims (e.g., license plates, signs, labels, handwritten remarks, damage details).\n\n"
    "Follow these guidelines:\n"
    "1. Extract all visible text exactly as written, preserving original layout, spacing, and line breaks.\n"
    "2. For handwritten text, signatures, or annotations, extract them and place them in the correct spatial location relative to surrounding text.\n"
    "3. If the input is a medical image (such as an X-ray, MRI, ultrasound, or prescription) or an accident/damage photo, extract any visible printed/written labels, annotations, dates, diagnostic stamps, scale markers, or overlaid text.\n"
    "4. For tables, forms, or key-value structures, format them clearly (using Markdown tables or aligned text) to preserve structure.\n"
    "5. Output only the raw extracted text/data. Do not include any introductory text, explanation, or conversational commentary."
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
