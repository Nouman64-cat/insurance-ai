# Audit Service. Built from the repository root so the image also carries shared/audit (the event contract and the
# sanitizer the service validates every message against):
#   docker build -f microservices/backend-microservices/audit-service/Dockerfile .
# Dockerfile.dockerignore (next to this file) limits the context to this service and shared/.
FROM python:3.12-slim

WORKDIR /app

COPY microservices/backend-microservices/audit-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY microservices/backend-microservices/audit-service/ ./
COPY shared/ ./shared/

# Migrations run at startup with AUDIT_MIGRATION_DATABASE_URL (the schema owner); the service itself connects with
# AUDIT_DATABASE_URL (read the ledger, append events; no UPDATE/DELETE anywhere).
EXPOSE 8020
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8020"]
