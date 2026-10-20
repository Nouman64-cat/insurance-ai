# Audit checkpoint signer: the ONLY container that ever holds an Ed25519 private key.
# Built from the repository root (it carries shared/audit/signer):
#   docker build -f microservices/backend-microservices/audit-signer/Dockerfile .
# It runs as an unprivileged user, publishes no port, and is reached only by the Audit Service over the internal network.
FROM python:3.12-slim

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin signer \
 && mkdir -p /run/audit-keys /run/audit-secrets /var/lib/audit-checkpoints /var/lib/audit-signer \
 && chown signer:signer /run/audit-keys /run/audit-secrets /var/lib/audit-checkpoints /var/lib/audit-signer \
 && chmod 700 /run/audit-keys /run/audit-secrets /var/lib/audit-signer && chmod 755 /var/lib/audit-checkpoints

WORKDIR /app
COPY microservices/backend-microservices/audit-signer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY microservices/backend-microservices/audit-signer/main.py ./main.py
COPY shared/ ./shared/

USER signer
EXPOSE 8021
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8021"]
