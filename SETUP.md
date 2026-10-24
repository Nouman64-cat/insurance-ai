```bash
set -e

git rev-parse --show-toplevel
cd "$(git rev-parse --show-toplevel)"

docker info >/dev/null
docker compose version
command -v psql
command -v python3

test -f .env || cp .env.example .env
chmod 600 .env

printf '%s\n' 'Start your external PostgreSQL server before continuing. Allow Docker containers to connect through host.docker.internal:5432.'
printf '%s\n' 'Configure .env for this machine: ENV_VAR=dev; POSTGRES_DB=insurance-ai; POSTGRES_USER=postgres; POSTGRES_PASSWORD; DATABASE_URL (same database, valid runtime credentials, host.docker.internal); RISK_MIGRATION_DATABASE_URL (same database, schema-creation credentials). URL-encode passwords in database URLs.'
printf '%s\n' 'Configure unique secrets: JWT_SECRET_KEY, INTERNAL_API_SECRET, CONFIG_ENCRYPTION_KEY (Fernet), CM_DB_OWNER_PASSWORD, CM_DB_APP_PASSWORD, CM_JWT_SECRET, CS_DB_OWNER_PASSWORD, CS_DB_APP_PASSWORD, REQUEST_MGMT_DB_OWNER_PASSWORD, REQUEST_MGMT_DB_APP_PASSWORD, REQUEST_MGMT_SERVICE_KEY, AUDIT_DB_OWNER_PASSWORD, AUDIT_DB_APP_PASSWORD, AUDIT_DB_SIGNER_PASSWORD, AUDIT_SIGNER_SERVICE_KEY.'
printf '%s\n' 'Configure MinIO: AISTOR_LICENSE_KEY (your real license), AISTOR_LICENSE_FILE=, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (16+ characters), AUDIT_ARCHIVE_WRITER_KEY, AUDIT_ARCHIVE_WRITER_SECRET, AUDIT_ARCHIVE_READER_KEY, AUDIT_ARCHIVE_READER_SECRET, EVAL_LAKE_ACCESS_KEY, EVAL_LAKE_SECRET_KEY.'
printf '%s\n' 'Configure CORS_ALLOWED_ORIGINS for your local frontend ports. Configure any provider credentials required by the workflows you will use.'
printf '%s\n' 'Generate a separate secret for each password/key field as needed:'
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
printf '%s\n' 'Generate CONFIG_ENCRYPTION_KEY:'
python3 -c 'import base64, secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())'
"${EDITOR:-vi}" .env

test -f .env.docs-forgery || (umask 077; python3 -c 'import secrets; print("DOCS_FORGERY_DB_PASSWORD=" + secrets.token_urlsafe(32))' > .env.docs-forgery)
chmod 600 .env.docs-forgery

psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE "insurance-ai"'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'insurance-ai')\gexec
SQL

psql -h localhost -U postgres -d insurance-ai -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'

docker compose config --quiet
docker compose build

docker compose --profile tools run --rm --no-deps --build request-management-provision
docker compose --profile tools run --rm --no-deps docs-forgery-provision

docker compose up -d --wait kafka minio
docker compose up -d minio-init
docker compose wait minio-init
test "$(docker inspect --format '{{.State.ExitCode}}' "$(docker compose ps -a -q minio-init)")" = 0

docker compose up -d --wait audit-service
docker compose --profile tools run --rm --no-deps --build audit-signer-init
docker compose --profile tools run --rm --no-deps --build audit-archive-init

docker compose up -d --build --wait

docker compose exec -T audit-signer python -m shared.audit.signer.cli status
docker compose exec -T audit-service python -m app.archive.cli status
docker compose ps -a

printf 'SuperAdmin email: '
read -r SETUP_SUPERADMIN_EMAIL
docker compose exec tenant-service python create_superadmin.py --email "$SETUP_SUPERADMIN_EMAIL"
unset SETUP_SUPERADMIN_EMAIL

printf '%s\n' 'Back up audit-keys, audit-secrets, audit-signer-state, audit-checkpoints, audit-archive-keys, aistor-data, and PostgreSQL. Store the key/passphrase backups separately. Keep all named volumes on subsequent starts.'
printf '%s\n' 'Configure audit retention, archiving, cleanup and optional local test mode in SuperAdmin: http://localhost:3000/super-admin/audit-configuration'
printf '%s\n' 'Configure Document Forgery Detection model and token rates in SuperAdmin LLM Configuration: http://localhost:3000/super-admin/llm-config'
printf '%s\n' 'Portal: http://localhost:3000 | MinIO console: http://localhost:9001'
```
