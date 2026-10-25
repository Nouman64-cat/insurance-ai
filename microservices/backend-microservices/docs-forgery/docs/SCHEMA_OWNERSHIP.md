# One database, service-owned schemas

The application continues to use the existing PostgreSQL database (`insurance-ai` locally). A schema is a namespace inside that database, not another database and not a network service. PostgreSQL permits cross-schema access when a role has the required grants; separation comes from permissions, not schema names alone. [PostgreSQL schema documentation](https://www.postgresql.org/docs/current/ddl-schemas.html).

## Ownership

| Data | Owner | Storage |
|---|---|---|
| Tenant identities, users and Admin permissions | tenant-service | Existing tenant-service schema (`dev` locally) |
| SuperAdmin forgery settings and Token Economy usage | tenant-service | Existing tenant-service schema |
| Analysis reports, evidence, heatmaps and processing status | docs-forgery | `docs_forgery.document_intelligence_results` |

There are no direct SQL reads or writes from tenant-service to the result table. Tenant/actor identifiers remain UUID references verified through the identity service. Cross-service foreign keys were removed during migration; removing a user/tenant therefore does not cascade-delete evidence. The service APIs, not SQL joins, provide the application integration boundary.

## Request flow

```mermaid
sequenceDiagram
    participant Admin as Admin browser
    participant Gateway as Portal / API Gateway
    participant Tenant as tenant-service
    participant Forgery as docs-forgery
    participant DB as PostgreSQL
    Admin->>Gateway: Upload + user JWT
    Gateway->>Tenant: Forward authenticated request
    Tenant->>Tenant: Validate JWT, active Admin and tenant
    Tenant->>Forgery: Internal API + secret + verified tenant/actor IDs
    Forgery->>DB: Connect as docs_forgery_app
    Forgery->>DB: Set tenant context for this transaction; insert processing record
    Forgery->>Tenant: Read central policy through internal API
    Forgery->>Forgery: Analyze document
    Forgery->>DB: Save full report in docs_forgery schema
    Forgery->>Tenant: Record cost usage through internal API
    Forgery-->>Tenant: Saved report
    Tenant-->>Admin: Report through gateway/portal
```

For history, the browser follows the same authenticated route. The authenticated user's tenant is supplied by tenant-service; a browser cannot select another tenant through a form field or header. Docs-forgery checks internal authentication and requires UUID tenant/actor headers for persisted analysis. It does not accept the browser's role label as proof of authorization.

## Database permissions

`docs_forgery_owner` owns the schema/table and cannot log in. The explicit provisioning job uses configured database administration credentials to perform DDL. The running docs-forgery container receives its connection address, private database password, provider keys, internal API secret and required runtime settings—not PostgreSQL-owner credentials.

`docs_forgery_app` is a non-superuser login with schema `USAGE` and table `SELECT`, `INSERT`, `UPDATE`. It cannot create tables/schemas, delete results, or read the tenant-service schema. Tenant-service's normal database role has no access to `docs_forgery`. The runtime role is not a member of the owner role.

All result queries contain a tenant predicate. In addition, PostgreSQL row-level security compares `tenant_id` with a transaction-local `app.tenant_id`. Without that context, no rows are visible. Context is cleared when the transaction ends before the pooled connection is reused. `FORCE ROW LEVEL SECURITY` is enabled and the application role has no `BYPASSRLS`. [PostgreSQL RLS documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

RLS helps prevent accidental unscoped queries; the service is still trusted to set the verified context. A compromised service with its database credentials could set another context. Database administrators can also bypass these controls. RLS is not a substitute for API authorization.

## Transport trust

Current internal HTTP calls use `X-Internal-Secret` on the Docker network. This is a shared platform secret: any service holding it is trusted and could impersonate an internal caller. It is not per-service identity and does not encrypt traffic. For production across hosts, use TLS/mTLS or short-lived, audience-scoped service tokens, and distribute credentials per service. This change limits docs-forgery's database credentials; it does not retrofit every existing service's credential distribution.

## Provisioning and migration

The shared `.env` has a docs-forgery section with the connection address (no password):

```dotenv
# Schema: docs_forgery; runtime role: docs_forgery_app
DOCS_FORGERY_DATABASE_URL=postgresql://docs_forgery_app@host.docker.internal:5432/insurance-ai
DOCS_FORGERY_URL=http://docs-forgery:8022
DOCS_FORGERY_LEGACY_SCHEMA=dev
```

Create a separate ignored `.env.docs-forgery`, mode `600`, containing:

```dotenv
DOCS_FORGERY_DB_PASSWORD=<generated-password>
```

Use the actual existing database name and a generated password of at least 24 characters. The application builds the full connection URL and URL-encodes the private password. Keep that password out of shared `.env`, which other services load. Existing complete URLs remain supported for deployments/test tools. Keep owner credentials in the provisioning environment only. The one-off job reads both files and can use `DOCS_FORGERY_MIGRATION_DATABASE_URL`, or the existing `POSTGRES_USER`/`POSTGRES_PASSWORD` with the runtime database host/name.

```sh
docker compose build docs-forgery tenant-service
# Stop writers during the table move.
docker compose stop tenant-service docs-forgery
docker compose --profile tools run --rm --no-deps -T docs-forgery-provision
docker compose up -d --no-deps --wait tenant-service docs-forgery
```

The provisioning transaction creates the schema and roles, moves the existing table using `ALTER TABLE ... SET SCHEMA`, changes ownership/grants, removes cross-service foreign keys and enables RLS. IDs, report JSON, timestamps and tenant/actor associations remain intact. `DOCS_FORGERY_LEGACY_SCHEMA` selects the source (default `dev`); it does not change the database. The old shared ORM model is removed, so tenant-service no longer recreates the legacy table. Re-running provisioning is safe when the legacy table is absent. If both legacy and destination tables exist, it stops for reconciliation rather than merging or overwriting records. A failed migration rolls back its transaction. No new application database is created.

Do not run the old tenant-service build after migration: it would recreate the legacy table. Back up the existing database before a production rollout. There is no automatic reverse migration or data deletion.

## Verification

```sh
# Unit/API tests require development dependencies, which are not in the runtime image.
# Run from the service directory in a development virtualenv:
python -m pip install -r requirements-dev.txt
TENANT_SERVICE_URL= DOCS_FORGERY_DATABASE_URL= python -m unittest discover -s tests -t .
# Return to repository root for these Compose commands:
# Creates/drops disposable test databases and temporary roles; no application data is touched:
docker compose --profile tools run --rm --no-deps -T docs-forgery-provision python -m tests.storage_postgres
# Tenant Admin authentication and forwarding:
docker compose exec -T tenant-service python test_document_intelligence.py
```

The PostgreSQL tests cover migration of legacy rows with ORM-side defaults, repeated provisioning, saved report JSON, tenant isolation, pooled connection context, and denied cross-schema/DDL/delete operations.
