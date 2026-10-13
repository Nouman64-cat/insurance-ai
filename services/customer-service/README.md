# Customer Service backend

FastAPI service on port 8008 (host 8018), exposed through the gateway at `/customer-service/v1`.
Owns tickets and append-only conversation/audit events in PostgreSQL schema `customer_service`.
Customer and policy records remain in tenant-service. Linked records are validated with the caller's token.

## Scope and permissions

Agents, brokers, underwriters, and claims adjusters can submit and read their own tickets.
Admin and ClaimsManager users can work the tenant queue, claim/release tickets, record internal notes,
and manage status. The optional `CustomerService` role is recognized if provisioned by the platform.
Viewer, SuperAdmin, inactive users, and accounts without a tenant cannot use this service.
Tenant identity comes from `/auth/me`; browser role/tenant claims never grant access.

Categories: general, policy servicing, billing, claim enquiry, complaint, documents.
Statuses: OPEN, IN_PROGRESS, WAITING_CUSTOMER, RESOLVED, CLOSED, CANCELLED.
Requesters can cancel OPEN tickets and reopen RESOLVED/CLOSED tickets.
Staff follow explicit state transitions with a reason. Version checks prevent stale decisions.
Creation requires a UUID idempotency key and rejects reuse with different content.
Private notes are excluded from requester responses.
Due dates: LOW 120 hours, NORMAL 72, HIGH 24, URGENT 4. Overdue tickets are marked in the queue.
These are tracking targets, not automated escalation promises.

## Setup

Set `CS_DB_OWNER_PASSWORD` and `CS_DB_APP_PASSWORD` in the root `.env`.
Provision uses `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` via `CS_PROVISION_DATABASE_URL`, requiring PostgreSQL role/schema administration.

```sh
docker compose up -d --build customer-service customer-service-app api-gateway   # provisions first, then starts
```

To re-run provisioning on its own (for example after changing a password): `docker compose run --rm customer-service-provision`.

Compose currently connects the application/migration roles to `host.docker.internal:5432/${POSTGRES_DB}`.
Set POSTGRES_DB to the same database used by DATABASE_URL; customize these URLs for remote PostgreSQL.
`customer_service_owner` owns the schema and migrations. `customer_service_app` has ticket row privileges and
SELECT/INSERT on events, without audit UPDATE/DELETE. No cross-service database writes or foreign keys.
Migrations use checksums and a PostgreSQL advisory lock and apply once on startup.
For production, run `python migrate.py` in deployment, set `CS_RUN_MIGRATIONS=false`, and omit owner credentials
from application instances. Use separate PostgreSQL database URLs later if stronger isolation is needed.

Key configuration: CS_DATABASE_URL, CS_MIGRATION_DATABASE_URL, TENANT_SERVICE_URL.
Health: `/v1/healthz`. Identity/capabilities: `/v1/me`. Tickets: `/v1/tickets`, detail `/{id}`,
actions `/{id}/comments`, `/{id}/assignment`, `/{id}/status`.

## Limits

This release tracks work and links to owning systems. It does not execute policy amendments, refunds,
surrenders, claims settlements, or payments. No customer self-service login, file attachments, external
email/SMS, automatic escalation, arbitrary staff reassignment, or Request Management approval adapter yet.
Conversation is staff-entered text, not outbound messaging to a customer.

## Tests

```sh
docker compose exec -T customer-service python -m unittest discover -s tests -v
```

Integration tests use POSTGRES_USER/POSTGRES_PASSWORD on the configured database host, or an explicit
CS_TEST_ADMIN_URL pointing to PostgreSQL administrator credentials. They create a disposable database,
apply real migrations, and clean it up. Never point test creation at restricted production credentials.

In `ENV_VAR=demo`, tenant Admin users can use **Fill demo data** in Customer Service to add eight
clearly marked sample tickets with replies, internal notes, and overdue examples. Repeated fills do not
duplicate or overwrite tickets. Samples do not link to or modify real customer/policy records.
