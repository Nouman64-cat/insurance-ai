import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set")

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel("gemini-2.5-flash")

SUMMARIZE_PROMPT = (
    "You are an expert insurance document analyst. Summarize the following extracted document text "
    "concisely and accurately. Focus on key policy details, coverage terms, claimant information, "
    "dates, amounts, and any critical conditions or exclusions. Output only the summary, no commentary."
)

app = FastAPI(
    title="Text Summarizer Service",
    description="Microservice for summarizing OCR-extracted insurance document text using Gemini 2.5 Flash.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SummarizeRequest(BaseModel):
    text: str
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
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty.")

    prompt = SUMMARIZE_PROMPT
    if request.max_words:
        prompt += f" Keep the summary under {request.max_words} words."

    try:
        response = model.generate_content([prompt, request.text])
        usage = response.usage_metadata
        return SummarizeResponse(
            summary=response.text,
            token_usage=TokenUsage(
                input=usage.prompt_token_count,
                output=usage.candidates_token_count,
                total=usage.total_token_count,
            ),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summarization error: {str(e)}")
