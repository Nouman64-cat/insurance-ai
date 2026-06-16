import os
import base64
from fastapi import FastAPI, File, UploadFile, HTTPException
import google.generativeai as genai

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set")

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel("gemini-2.5-flash")

OCR_PROMPT = (
    "You are an OCR engine. Extract all text from this document exactly as it appears, "
    "preserving the original layout and line breaks. Output only the raw extracted text, no commentary."
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


def _run_ocr(file_bytes: bytes, mime_type: str) -> str:
    response = model.generate_content([
        OCR_PROMPT,
        {"mime_type": mime_type, "data": base64.b64encode(file_bytes).decode()},
    ])
    return response.text


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
        extracted_text = _run_ocr(file_bytes, mime_type)
        return {"filename": file.filename, "extracted_text": extracted_text}
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

        extracted_text = _run_ocr(file_bytes, mime_type)

        if output_path:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(extracted_text)

        return {
            "status": "success",
            "input_file": input_path,
            "saved_to": output_path,
            "extracted_text": extracted_text,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
