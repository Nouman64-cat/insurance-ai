# Customer Management service (customer portal back end). Built from the repository root so the image also carries
# shared/security (the signed service-to-service contract):
#   docker build -f microservices/backend-microservices/customer-management/Dockerfile .
FROM python:3.12-slim

WORKDIR /app

COPY microservices/backend-microservices/customer-management/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY microservices/backend-microservices/customer-management/ ./
COPY shared/ ./shared/

# Migrations run at startup with CM_MIGRATION_DATABASE_URL (the schema owner); the service itself connects with
# CM_DATABASE_URL (row access in the customer_management schema only).
EXPOSE 8009
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8009"]
