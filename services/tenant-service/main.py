from fastapi import FastAPI

app = FastAPI(title="Tenant Service", version="0.1.0")


@app.get("/health")
async def health_check():
    return {"service": "tenant-service", "status": "healthy"}
