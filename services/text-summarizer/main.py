import os
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
from google.generativeai.types import HarmCategory, HarmBlockThreshold

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set")

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel("gemini-2.5-flash")

app = FastAPI(
    title="Text Summarizer Service",
    description="Microservice for summarizing OCR-extracted text using Gemini 2.5 Flash.",
    version="1.0.0",
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
    documents: list[str]  # Updated to accept a list of strings
    max_words: int | None = None

class TokenUsage(BaseModel):
    input: int
    output: int
    total: int

class SummarizeResponse(BaseModel):
    summary: str
    token_usage: TokenUsage

@app.get("/health")
async def health_check():
    return {"status": "healthy", "engine": "Gemini 2.5 Flash", "model": "gemini-2.5-flash"}

@app.post("/summarize", response_model=SummarizeResponse)
async def summarize_text(request: SummarizeRequest):
    if not request.documents:
        raise HTTPException(status_code=400, detail="Documents list must not be empty.")

    # Build prompt with exact format: document count + XML-wrapped documents
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

    safety_settings = {
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_NONE,
    }

    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(prompt, safety_settings=safety_settings)
        )

        # Validate response before accessing metadata
        if not response or not response.text:
            raise ValueError("Empty response from Gemini model")

        usage = response.usage_metadata
        if not usage:
            raise ValueError("No token usage metadata in response")

        return SummarizeResponse(
            summary=response.text,
            token_usage=TokenUsage(
                input=usage.prompt_token_count,
                output=usage.candidates_token_count,
                total=usage.total_token_count,
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=500, detail=f"Invalid response from Gemini: {str(e)}")
    except Exception as e:
        error_msg = str(e) if str(e) else "Unknown error during summarization"
        raise HTTPException(status_code=500, detail=f"Summarization error: {error_msg}")
