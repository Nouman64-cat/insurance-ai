from fastapi import FastAPI

app = FastAPI(title="Risk Engine", version="0.1.0")


@app.get("/health")
async def health_check():
    return {"service": "risk-engine", "status": "healthy"}
