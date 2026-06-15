import os
import shutil
import tempfile
import numpy as np
import easyocr
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import JSONResponse
from pdf2image import convert_from_path

app = FastAPI(
    title="OCR Extraction Service",
    description="Microservice for extracting printed and handwritten text from images and PDFs.",
    version="1.0.0"
)

# Initialize the OCR reader globally on startup so it stays warm in memory
print("Initializing OCR Engine (GPU Enabled)...")
reader = easyocr.Reader(['en'], gpu=True)

@app.get("/health")
async def health_check():
    """Standard health check endpoint for microservice orchestration."""
    return {"status": "healthy", "engine": "EasyOCR", "gpu_enabled": True}

@app.post("/extract")
async def extract_text(file: UploadFile = File(...)):
    """
    Accepts a multipart file upload (PDF or Image), extracts text, 
    and returns the results directly via JSON.
    """
    file_ext = file.filename.lower().split('.')[-1]
    if file_ext not in ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'bmp']:
        raise HTTPException(
            status_code=400, 
            detail="Unsupported file format. Please upload a PDF, PNG, JPG, JPEG, TIFF, or BMP."
        )

    extracted_text = []

    try:
        if file_ext == 'pdf':
            # Save the uploaded streaming file safely to a temporary file for pdf2image processing
            with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
                shutil.copyfileobj(file.file, tmp_file)
                tmp_path = tmp_file.name

            try:
                pages = convert_from_path(tmp_path)
                for i, page in enumerate(pages):
                    page_np = np.array(page)
                    results = reader.readtext(page_np, detail=0, paragraph=True)
                    extracted_text.append(f"\n--- Page {i + 1} ---\n")
                    extracted_text.extend(results)
            finally:
                # Always clean up disk space after extraction completes
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

        else:
            # Process image directly from memory without hitting disk storage
            file_bytes = await file.read()
            results = reader.readtext(file_bytes, detail=0, paragraph=True)
            extracted_text.extend(results)

        return {
            "filename": file.filename,
            "extracted_text": "\n".join(extracted_text)
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR Processing Error: {str(e)}")

@app.post("/extract-from-path")
async def extract_text_from_path(input_path: str, output_path: str = None):
    """
    Alternative endpoint to process files directly from a shared volume 
    path (matching your internal data pipeline architecture).
    """
    if not os.path.exists(input_path):
        raise HTTPException(status_code=444, detail=f"Target file not found at: {input_path}")

    extracted_text = []
    file_ext = input_path.lower().split('.')[-1]

    try:
        if file_ext == 'pdf':
            pages = convert_from_path(input_path)
            for i, page in enumerate(pages):
                page_np = np.array(page)
                results = reader.readtext(page_np, detail=0, paragraph=True)
                extracted_text.append(f"\n--- Page {i + 1} ---\n")
                extracted_text.extend(results)
        
        elif file_ext in ['png', 'jpg', 'jpeg', 'tiff', 'bmp']:
            results = reader.readtext(input_path, detail=0, paragraph=True)
            extracted_text.extend(results)
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format path.")

        full_output = "\n".join(extracted_text)

        # If an output path is supplied, write it back to the shared volume
        if output_path:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(full_output)

        return {
            "status": "success",
            "input_file": input_path,
            "saved_to": output_path,
            "extracted_text": full_output
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))