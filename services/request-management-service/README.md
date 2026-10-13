# Request Management service

FastAPI service for staff requests: a requester submits, the service routes the request to an accountable reviewer or
team, the reviewer approves, rejects or asks for more information, and the requester follows it to the outcome.
Approved actions that change another service's data are carried out by that service, never by this one.

- API: `/v1/...` on port 8007 (host 8017), public through the API gateway at **`/request-management/v1/...`**
- Frontend: [`request-management-app/`](../../request-management-app/README.md) (port 3007)
- Setup, database roles and environment: see "Request Management" in the [root README](../../README.md#request-management)

## Architecture

```
browser ──► api-gateway /request-management/v1/* ──► request-management-service ──► PostgreSQL (schema request_management)
                                                          │   │                       outbox_events ──► Kafka insurance.request.events.v1
                                                          │   └─ /auth/me, scoped reads with the user's token ──► tenant-service
                                                          └─ signed calls: user directory, apply correction ───► tenant-service
Kafka ──► executor (approved actions)  ──► tenant-service (owner applies the change)
      └─► notifier (in-app notifications)
```

| Module | Responsibility |
|---|---|
| `app/identity.py` | Verifies every caller with tenant-service `/auth/me` (cached 15 s per token) |
| `app/permissions.py`, `app/types/registry.py` | Who may submit, review and administer each request type |
| `app/workflow.py` | Review and execution state machines, allowed actions per caller |
| `app/routing.py`, `app/routing_admin.py` | Rule resolution at submission; rule administration |
| `app/service.py`, `app/queries.py` | Actions (transactional, versioned, idempotent) and reads |
| `app/attachments.py` | Private attachment storage (S3, or a local directory in development) |
| `app/workers.py` | Outbox relay, executor, notifier, retry/lease/overdue scheduler |
| `app/migrate.py`, `app/provision.py`, `migrations/*.sql` | Versioned schema, database roles |
| `app/adapters.py` | Contract for bringing existing approval flows in later |

## Data ownership

- Everything lives in the `request_management` schema: requests, immutable revisions, routing rules, assignments,
  decisions, comments, attachment metadata, append-only audit events, executions and attempts, outbox, consumer
  deduplication, idempotency keys and notifications.
- Users, customers, policies and commission earnings stay in tenant-service. This service stores their **ids** plus
  small display snapshots (a customer's name, the reviewed "before" values, the disputed earning's amounts). There
  are no foreign keys or joins to other schemas.
- Database roles (`app/provision.py`): `request_mgmt_owner` owns the schema and runs migrations;
  `request_mgmt_app` (what the service connects as) reads and writes rows in this schema only. It can't run DDL,
  touch any other schema, or update or delete audit events.
- Moving to a dedicated database later: provision there, run migrations, copy the schema, then change
  `REQUEST_MGMT_DATABASE_URL` and `REQUEST_MGMT_MIGRATION_DATABASE_URL`. No code refers to the database name.

### Migrations

Numbered SQL files in `migrations/` (`0001_initial.sql`, …). Each runs once, in a transaction, and is recorded with
a checksum in `request_management.schema_migrations`. Editing an applied file stops the run: fix forward with a new
file. An advisory lock keeps replicas from migrating at the same time. `create_all` is never used.

```bash
docker compose exec request-management-service python -m app.migrate --status
docker compose exec request-management-service python -m app.migrate
```

In production, run migrations as a deploy step with the owner credentials and set `REQUEST_MGMT_RUN_MIGRATIONS=false`
(and no migration URL) on the application.

## Identity and permissions

- **Identity:** every request needs the user's Bearer token, which is checked against `/auth/me` (the same check as
  the portal, the Automation Chat and the Underwriting Workbench).
  - User id, tenant, role and branch come only from that answer. Requester, approver, tenant and role fields sent by
    the browser are ignored, and an `X-Tenant-Id` that disagrees with the session is rejected (`TENANT_MISMATCH`).
  - Inactive or suspended accounts get `ACCOUNT_INACTIVE`. Accounts without a tenant (SuperAdmin) get `NO_TENANT`.
  - Revoked or expired tokens get `401` within the identity cache time (15 s by default).
- **Object access:** every lookup filters on the caller's tenant. A request the caller may not see answers `404`
  (its existence isn't revealed).

| | Submit | Review (decide) | Tenant administration |
|---|---|---|---|
| General operational request | Admin, Underwriter, ClaimsAdjuster, ClaimsManager, Agent, Broker | Admin, Underwriter, ClaimsManager | Admin |
| Customer profile correction | Admin, Underwriter, Agent, Broker | Admin, Underwriter | Admin |
| Commission dispute | Admin, Agent, Broker | Admin | Admin |

- **Viewing:** a requester sees their own requests. A reviewer sees requests assigned to them and unclaimed requests
  in their role's queue for types they may review. A tenant administrator sees all submitted requests in the tenant.
  Viewers and unknown roles can't submit or review.
- **Separation of duties:** nobody may decide their own request, administrators included. Routing never targets the
  requester; reassignment to the requester is refused; tenant-service re-checks the approver before applying a
  correction.
- **Internal notes:** comments and attachments marked internal are visible to reviewers and administrators only,
  never to the requester, even when the requester also holds a reviewer role.
- **Referenced records:** customers and commission earnings are validated with the requester's own token, so an agent
  can only reference customers and earnings tenant-service already lets them see.

## Lifecycle

Review and execution are separate:

| Review status | Meaning |
|---|---|
| `DRAFT` | Being written; only the requester sees it |
| `SUBMITTED` | Routed; waiting for the assigned reviewer, or for someone in the team queue to claim it |
| `IN_REVIEW` | A reviewer has started reviewing it |
| `NEEDS_INFORMATION` | Returned to the requester with a question |
| `APPROVED` / `REJECTED` | Final decision on a specific revision |
| `CANCELLED` | Withdrawn by the requester before a decision |

| Execution status | Meaning |
|---|---|
| `NOT_APPLICABLE` | Nothing to apply (not approved yet, or a type that only records a decision) |
| `PENDING` → `RUNNING` | Approved; queued, then being applied by the owning service |
| `SUCCEEDED` | Applied |
| `FAILED` | Not applied: retries exhausted, refused by the owner, or the record changed since review |

| Action (endpoint) | From | To | Who |
|---|---|---|---|
| `PUT /draft` | DRAFT, NEEDS_INFORMATION | (same; a new revision after NEEDS_INFORMATION) | requester |
| `submit` | DRAFT | SUBMITTED | requester (role may submit the type) |
| `start-review` | SUBMITTED | IN_REVIEW | assigned reviewer, or claims from the team queue |
| `release` | IN_REVIEW | SUBMITTED | the reviewer who claimed it from a queue |
| `request-information` | SUBMITTED, IN_REVIEW | NEEDS_INFORMATION | assigned reviewer |
| `resubmit` | NEEDS_INFORMATION | SUBMITTED | requester (with an answer) |
| `approve` / `reject` | IN_REVIEW | APPROVED / REJECTED | assigned reviewer, not the requester |
| `cancel` | DRAFT, SUBMITTED, IN_REVIEW, NEEDS_INFORMATION | CANCELLED | requester (reason required once submitted) |
| `reassign` | SUBMITTED, IN_REVIEW, NEEDS_INFORMATION | (same; IN_REVIEW goes back to SUBMITTED) | tenant administrator, with a reason |
| `retry-execution` | APPROVED + execution FAILED (not a conflict) | execution PENDING | administrator, or the reviewer who approved |
| `reopen-for-review` | APPROVED + execution FAILED with CONFLICT | NEEDS_INFORMATION | administrator, or the reviewer who approved |

- **Allowed actions:** anything else returns `INVALID_TRANSITION`. The detail response lists the actions the caller
  may take now (`allowed_actions`), and the frontend shows only those.
- **Revisions:** a submitted revision is frozen (a database trigger refuses changes). Editing after an information
  request starts a new revision. `approve`, `reject` and `request-information` must name the revision reviewed
  (`revision_no`), otherwise `STALE_REVISION`.
- **Concurrency:** every action sends `expected_version`. A request changed since it was loaded returns
  `STALE_VERSION`, so two reviewers deciding at once produce one decision; a unique index on final decisions per
  revision backs this up.
- **Duplicates:** create, `submit`, `resubmit`, `approve`, `reject` and `retry-execution` accept an `Idempotency-Key`
  header. A repeated call returns the first outcome, and reusing a key for a different body returns
  `IDEMPOTENCY_CONFLICT`.

## Routing

Tenant administrators manage rules on the frontend's **Routing** page (`/v1/routing-rules`):

- **One rule per request type:** optionally per branch, at most one active rule per type and branch.
- **Target:** either one named reviewer (`USER`) or a team queue (`ROLE`), plus a time to decide (`sla_hours`), which
  sets the request's due date.
- **Resolution at submission:** the branch rule wins over the tenant-wide rule. The request's branch is the
  referenced customer's branch, otherwise the requester's.
- **Target checks:** targets are checked against the live directory when the rule is saved and again at every
  submission (active, same tenant, allowed to review the type, not the requester).
  - If nothing qualifies, submission fails with `ROUTING_FAILED` and the request stays a draft. An open request
    always has an accountable owner (a database check enforces this).
- **Audit:** the rule id, version and resolved target are stored on the request and in its audit history. Rule edits
  bump the version and are audited too.
- **Overdue:** overdue requests (past `due_at`, still SUBMITTED or IN_REVIEW) appear in the queues and trigger a
  reminder to the reviewer or queue and the tenant administrators at most once per
  `REQUEST_MGMT_REMINDER_INTERVAL_HOURS`. Nothing is ever approved, rejected or reassigned automatically.

## Execution and reliability

- **Durable intent:** approving an executing type writes the decision, an `executions` row (stable
  `execution_key = rm:<request>:<revision>`) and an outbox event in one transaction.
- **Outbox relay:** publishes committed events to Kafka (`insurance.request.events.v1`, envelope `RequestEvent` in
  `shared/events/kafka_events.py`), in order. Unpublished rows survive restarts and broker outages.
- **Executor (consumer group):** deduplicates on the event id in the same transaction as claiming the execution. It
  calls the owning service with the execution key, which makes a repeated attempt (after a crash) return the first
  result instead of applying twice.
- **Retries:** transient failures retry with exponential backoff (`REQUEST_MGMT_RETRY_BASE_SECONDS`, capped at 15
  minutes) up to `REQUEST_MGMT_MAX_EXECUTION_ATTEMPTS`, then the execution is `FAILED`. Attempts whose worker died are
  recovered after a 2-minute lease. Every attempt is recorded.
- **Failures stay visible:** nothing is replayed on login, page refresh or reconnect. An authorized user retries
  explicitly.
- **Customer corrections:** tenant-service compares the reviewed "before" values with the current record. If they
  differ it returns `CONFLICT`, nothing is overwritten, and the request can only be reopened for review (never
  retried as-is).
- **Notifications:** submission or assignment (to the reviewer or queue), information requests, decisions,
  cancellations, comments, execution success or failure, and overdue reminders become in-app notifications. They are
  written by the notifier consumer and deduplicated per event and recipient. No SMS, email or paid providers are used.

## Request types and integrations

| Type | What approval does |
|---|---|
| `general` | Records the decision. Nothing is executed. |
| `customer_profile_correction` | Applies an allowlisted change through tenant-service (see below). |
| `commission_dispute` | Records a resolution (`UPHELD`, `PARTIALLY_UPHELD`, `NOT_UPHELD`). The commission ledger is not changed and no payout is created; a financial correction has to be made through a supported commission operation. |

**Customer profile corrections**
- **Changeable fields (allowlist):** `shared/requests/customer_corrections.py`. These are mobile number, email,
  emergency contact, street address, postal code, city, province and marital status.
- **Never changeable here:** name, CNIC, date of birth, gender, tenant, branch, assigned agent, acquisition source,
  income, occupation, smoker status, height and weight. Adding a field is a policy change made in that file.
- **Applying:** tenant-service's `POST /internal/request-management/tenants/{tenant}/customers/{customer}/profile-corrections`
  applies them. It is not reachable through the gateway.
- **Authentication:** calls are signed with HMAC-SHA256 using `REQUEST_MGMT_SERVICE_KEY`, covering a timestamp, the
  method, the path and the body, with a 5-minute window (`shared/security/service_auth.py`). The key is accepted only
  by these endpoints.
- **Owner-side checks:** tenant-service verifies the allowlist, that the approver is an active Admin or Underwriter
  of the same tenant and not the requester, and that the record still matches what was reviewed. It is idempotent on
  the execution key and records each correction in `customer_profile_corrections`.

**Existing approval flows** keep their own approvals and are **not** routed through this service:
- underwriting decisions (`PATCH /tenants/{t}/cases/{id}/status`);
- claim approval and payout (`PATCH /tenants/{t}/claims/{id}/status`, `POST .../payout`);
- commission agreement maker-checker (`POST .../commissions/agreements/{id}/approve`).

Commission payout runs have no backend approval yet. `app/adapters.py` describes how one of these flows could
move here later: an adapter, plus the owning service refusing the action unless it comes from that adapter. That way
two engines never independently authorize the same action.

## API

All under `/v1` (through the gateway: `/request-management/v1`).

| Method and path | Purpose |
|---|---|
| `GET /request-types` | Types, with whether the caller may submit each |
| `GET /summary` | Counts for the caller (my drafts / open / needing information, assigned, queue, overdue; tenant totals for admins; unread notifications) |
| `GET /requests?scope=mine\|review\|tenant` | Server-side paged list. Filters: `status`, `execution_status`, `type`, `priority`, `assignee` (id or `unassigned`), `branch`, `created_from`, `created_to`, `overdue`, `q`, `sort`, `page`, `page_size` |
| `POST /requests` | Create a draft (`request_type`, `title`, `priority`, `payload`) |
| `GET /requests/{id}`, `GET /requests/{id}/timeline` | Detail with `allowed_actions`; audit timeline (filtered for the requester) |
| `PUT /requests/{id}/draft` | Edit title, priority or proposal |
| `POST /requests/{id}/{action}` | `submit`, `resubmit`, `start-review`, `release`, `request-information`, `approve`, `reject`, `cancel`, `reassign`, `retry-execution`, `reopen-for-review` |
| `POST /requests/{id}/comments` | `{body, visibility: REQUESTER\|INTERNAL}` |
| `POST /requests/{id}/attachments`, `GET .../attachments/{aid}/content` | Upload (multipart; PDF, PNG or JPEG, 10 MB, type checked on content); authorized download |
| `GET /notifications`, `POST /notifications/{id}/read`, `POST /notifications/read-all` | In-app notifications |
| `GET/POST /routing-rules`, `PUT /routing-rules/{id}`, `POST /routing-rules/{id}/deactivate` | Routing administration (tenant administrators) |
| `GET /reviewers?request_type=` | Eligible reviewers, for routing and reassignment pickers (administrators) |
| `GET /healthz` | Health |

Errors are always `{"error": {"code", "message", "details"}}`. The codes are:
- `UNAUTHENTICATED` (401);
- `FORBIDDEN`, `ACTION_NOT_ALLOWED`, `SELF_APPROVAL`, `TENANT_MISMATCH`, `ACCOUNT_INACTIVE`, `NO_TENANT`, `ADMIN_ONLY`
  (403);
- `NOT_FOUND` (404);
- `INVALID_TRANSITION`, `STALE_VERSION`, `STALE_REVISION`, `IDEMPOTENCY_CONFLICT`, `RULE_EXISTS` (409);
- `VALIDATION`, `ROUTING_FAILED`, `SUBJECT_NOT_FOUND` (422);
- `AUTH_UNAVAILABLE`, `DIRECTORY_UNAVAILABLE` (503).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REQUEST_MGMT_DATABASE_URL` | — | Application role connection |
| `REQUEST_MGMT_MIGRATION_DATABASE_URL` | — | Schema owner connection (migrations); unset in production apps |
| `REQUEST_MGMT_RUN_MIGRATIONS` | `true` | Run migrations at startup when the migration URL is set |
| `REQUEST_MGMT_DB_SCHEMA` | `request_management` | Schema name |
| `TENANT_SERVICE_URL` | `http://tenant-service:8001` | Identity, scoped lookups, directory, corrections |
| `REQUEST_MGMT_SERVICE_KEY` | — | HMAC key shared with tenant-service (same value on both) |
| `REQUEST_MGMT_IDENTITY_CACHE_SECONDS` | `15` | How long a verified session is trusted |
| `KAFKA_BOOTSTRAP_SERVERS` | `kafka:9092` | Event topic `insurance.request.events.v1` (created at startup) |
| `REQUEST_MGMT_WORKERS` | `true` | Background workers (off for tests) |
| `REQUEST_MGMT_MAX_EXECUTION_ATTEMPTS` | `5` | Automatic attempts before FAILED |
| `REQUEST_MGMT_RETRY_BASE_SECONDS` | `30` | Backoff base |
| `REQUEST_MGMT_REMINDER_INTERVAL_HOURS` | `24` | Overdue reminder spacing |
| `REQUEST_MGMT_STORAGE` | `s3` | `s3` (with `S3_BUCKET_NAME`, AWS credentials) or local |
| `REQUEST_MGMT_LOCAL_STORAGE_DIR` | `/data/request-attachments` | Local attachment directory (a Docker volume in Compose) |
| `REQUEST_MGMT_MAX_ATTACHMENT_BYTES` | 10 MiB | Attachment size limit |
| `REQUEST_MGMT_PROVISION_DATABASE_URL`, `REQUEST_MGMT_DB_OWNER_PASSWORD`, `REQUEST_MGMT_DB_APP_PASSWORD` | — | One-off provisioning only (`python -m app.provision`) |

## Tests

Tests use a disposable PostgreSQL database with the real migrations and database roles (dropped afterwards), and a
fake tenant-service that honours the same contract:

```bash
docker compose exec -T -e REQUEST_MGMT_WORKERS=false request-management-service python -m unittest discover -s tests -t . -v
docker compose exec -T tenant-service python test_request_management_internal.py   # tenant-service's side, real models and signatures
```

The suites cover:
- **Isolation and identity:** cross-tenant denial, tenant and role spoofing, revoked and inactive users.
- **Permissions:** self-approval (an admin requester included), unauthorized queue access and reassignment, invalid
  transitions.
- **Decisions:** approval of the exact reviewed revision, simultaneous decisions, duplicate submissions and
  executions.
- **Execution:** a crash after the domain update, customer changes since review (conflict then re-review), failed
  execution and safe retry.
- **Reliability and visibility:** internal comment and attachment visibility, outbox delivery across a publisher
  outage and restart, overdue reminders.
- **Database:** migration checksums and the database privilege boundary.

## Deployment

The image builds from the repository root because it carries `shared/`:
`docker build -f services/request-management-service/Dockerfile .`

To scale out, run more containers. The workers coordinate through row locks (`FOR UPDATE SKIP LOCKED`), Kafka
consumer groups and deduplication tables; none of them keep state in memory.
