from fastapi import FastAPI

app = FastAPI(title="API Gateway", version="0.1.0")


@app.get("/health")
async def health_check():
    return {"service": "api-gateway", "status": "healthy"}
