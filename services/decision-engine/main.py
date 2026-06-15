from fastapi import FastAPI

app = FastAPI(title="Decision Engine", version="0.1.0")


@app.get("/health")
async def health_check():
    return {"service": "decision-engine", "status": "healthy"}
