# Request Management service. Built from the repository root so the image carries the shared contracts it imports
# (shared/events, shared/security, shared/requests):
#   docker build -f services/request-management-service/Dockerfile .
# Dockerfile.dockerignore (next to this file) limits the context to this service and shared/.
FROM python:3.12-slim

WORKDIR /app

COPY services/request-management-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/request-management-service/ ./
COPY shared/ ./shared/

# Migrations run at startup with REQUEST_MGMT_MIGRATION_DATABASE_URL (the schema owner); the service itself connects
# with REQUEST_MGMT_DATABASE_URL (row access only). Background workers coordinate through row locks and Kafka
# consumer groups, so scaling out is more containers.
EXPOSE 8007
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8007"]
