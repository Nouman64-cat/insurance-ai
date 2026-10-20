# Customer Service. Built from the repository root so the image also carries shared/audit (the audit event contract and
# transactional-outbox helpers):
#   docker build -f microservices/backend-microservices/customer-service/Dockerfile .
# Dockerfile.dockerignore (next to this file) limits the context to this service and shared/.
FROM python:3.12-slim
WORKDIR /app
COPY microservices/backend-microservices/customer-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY microservices/backend-microservices/customer-service/ ./
COPY shared/ ./shared/
EXPOSE 8008
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8008"]
