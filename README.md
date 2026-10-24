# Insurance AI

A multi-tenant, AI-assisted insurance platform covering customer acquisition, underwriting, policy servicing, claims, commissions, document intelligence, and agent workflows.

The platform combines deterministic insurance rules with LLM-assisted analysis, event-driven processing, and graph-based fraud intelligence.

## Features

- **AI-assisted underwriting** with medical, financial, fraud, and document evidence
- **Deterministic decision engine** for approve, loading, review, postpone, decline, and fraud investigation outcomes
- **Requirements engine** that determines required medical, identity, and financial evidence
- **Document intelligence** for OCR, visual analysis, verification, and summarization
- **Multi-provider LLM runtime** with configurable primary/fallback models
- **Fraud intelligence** backed by Memgraph
- **Event-driven workflows** using Kafka
- **AI copilot / chat agent** built with LangGraph
- **Multi-tenant administration** with JWT-based authentication and role-aware workflows
- **Agent mobile application** for leads, proposals, e-applications, underwriting, policies, commissions, and AI assistance
- **Policy, claims, commission, and post-issuance workflows**
- **Request management** with reviewer routing, approvals, audit history, and approved customer corrections

## Architecture

```text
                        ┌─────────────────────┐
                        │   Next.js Web App   │
                        │ React Native Agent  │
                        └──────────┬──────────┘
                                   │
                                   ▼
                         ┌──────────────────┐
                         │   API Gateway    │
                         │      :8010       │
                         └────────┬─────────┘
                                  │
              ┌───────────────────┼────────────────────┐
              │                   │                    │
              ▼                   ▼                    ▼
      Tenant Service         Risk Engine          Chat Agent
          :8011                 :8012                :8016
              │                   │                    │
              │             LangGraph                 │
              │                   │               LangGraph
              │                   ▼                    │
              │            LLM Runtime ◄───────────────┘
              │             │    │    │
              │          Gemini OpenAI Anthropic
              │
      ┌───────┴────────┐
      │                │
      ▼                ▼
 PostgreSQL           Kafka
 System of Record   Event Backbone
                       │
                ┌──────┴──────┐
                ▼             ▼
           OCR Engine    Async Underwriting
             :8014
                │
                ▼
       Text Summarizer
       :8005 (internal)

Risk Engine ───────────────► Memgraph
                             Fraud Graph
```

### Underwriting flow

```text
Case / Proposal
      │
      ▼
Requirements Engine
      │
      ├── missing evidence → Pending Documents
      │
      ▼
Evidence Bundle
      │
      ▼
Normalized Underwriting Profile
      │
      ├── Medical Assessment
      ├── Financial Assessment
      └── Fraud Assessment
             │
             ▼
      Deterministic Rules
             │
             ▼
      Underwriting Decision
```

LLMs assist with extraction, interpretation, and structured risk assessment. Final underwriting branching is governed by deterministic rules in `shared/underwriting/`.

## LLM Providers

The platform supports:

- Google Gemini
- OpenAI
- Anthropic

A SuperAdmin can configure the **primary** and **fallback** provider from:

```text
Platform → LLM Configuration
```

Configuration is shared by the Chat Agent, Risk Engine, OCR Engine, and Text Summarizer.

Provider credentials are encrypted at rest and services automatically fall back to the configured secondary provider when the primary provider fails.

## Tech Stack

| Layer               | Technology                                  |
| ------------------- | ------------------------------------------- |
| Web                 | Next.js 14, React, TypeScript, Tailwind CSS |
| Mobile              | React Native, Expo                          |
| APIs                | FastAPI, Python                             |
| AI orchestration    | LangGraph, LangChain                        |
| LLMs                | Gemini, OpenAI, Anthropic                   |
| Database            | PostgreSQL                                  |
| Event streaming     | Apache Kafka                                |
| Fraud graph         | Memgraph                                    |
| Object storage      | AWS S3                                      |
| Authentication      | JWT                                         |
| Documentation       | Docusaurus                                  |
| Local orchestration | Docker Compose                              |

## Repository Structure

```text
insurance-ai/
├── mobile-apps/
│   ├── agent-app/                # React Native / Expo agent application
│   └── customer-app/             # React Native / Expo customer application
├── microservices/
│   ├── frontend-microservices/
│   │   ├── frontend/             # Next.js operations/admin portal, :3000
│   │   ├── automation-chat/      # Next.js Automation Chat (AI copilot) app, own container, :3004 (opt-in)
│   │   ├── underwriting-app/     # Next.js Underwriting Workbench (queue, case workspace), own container, :3005
│   │   ├── request-management-app/ # Next.js Request Management app, :3007 (run separately)
│   │   ├── customer-service-app/ # Next.js Customer Service desk, :3008
│   │   ├── forgery-detection-app/ # Legacy link to protected Admin workspace, :3012
│   │   ├── claims-manager-app/   # Next.js Claims Manager app, :3011
│   │   ├── customer-portal/      # Next.js customer self-service portal
│   │   ├── marketing-site/       # Next.js public marketing site (demo content, :3002)
│   │   └── docs/                 # Docusaurus documentation site, :4991
│   └── backend-microservices/
│       ├── api-gateway/
│       ├── tenant-service/
│       ├── risk-engine/
│       ├── chat-agent/
│       ├── docs-forgery/          # FastAPI document manipulation analysis, :8032
│       ├── ocr-engine/
│       ├── text-summarizer/
│       ├── customer-management/  # FastAPI customer portal back end
│       ├── customer-service/     # FastAPI service desk, isolated PostgreSQL schema, :8018
│       ├── request-management-service/ # FastAPI request workflows, isolated PostgreSQL schema, :8017
│       ├── audit-service/        # FastAPI hash-chained audit ledger, isolated PostgreSQL schema `audit`, :8030
│       ├── audit-signer/         # isolated Ed25519 signer for audit checkpoints and archive manifests (internal only)
│       └── decision-engine/
├── infrastructure/
│   └── minio/                # MinIO AIStor bootstrap for the audit archive (bucket, Object Lock, identities)
├── shared/                       # Python code shared by the backend microservices
│   ├── models/
│   ├── audit/                    # audit event contract, sanitizer, transactional outbox + relay, checkpoint/archive manifests, signer
│   ├── events/
│   ├── services/
│   └── underwriting/
└── docker-compose.yml
```

## Quick Start

### Prerequisites

- Docker + Docker Compose
- PostgreSQL
- Node.js 18+
- At least one supported LLM provider account

### 1. Configure the environment

```bash
cp .env.example .env
```

At minimum configure:

```env
DATABASE_URL=postgresql+asyncpg://...
JWT_SECRET_KEY=...
CONFIG_ENCRYPTION_KEY=...
```

Generate a Fernet encryption key with:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

AWS S3, SES, OpenSanctions, and provider environment fallbacks are optional depending on the workflow being used.

### 2. Start the platform

Before the first start, provision the Customer Service and Request Management database roles and schemas as described in
[Request Management](#request-management) and [Customer Service](#customer-service) below. Both backends start with the main stack.

```bash
docker compose up --build -d
```

Check services:

```bash
docker compose ps
```

### 3. Create the platform SuperAdmin

```bash
docker compose exec tenant-service \
  python create_superadmin.py --email you@example.com
```

Login at:

```text
http://localhost:3000
```

Then configure the primary/fallback LLM providers under **Platform → LLM Configuration**.

## Automation Chat

The AI copilot runs as its own app and container, separate from the web portal (`microservices/frontend-microservices/automation-chat/`, port **3004**).
It is **opt-in**: `docker compose up` does not start it. Start it when you want it:

```bash
docker compose up -d automation-chat   # start (builds on first run)
docker compose stop automation-chat    # stop
```

Then use the **Automation** button in the portal's top bar. It opens the chat in a new tab, or tells you the
container is not running. You can also open http://localhost:3004 directly.

**Single sign-on.** Nothing to type: signing in to the portal also sets an httpOnly session cookie (`insurance_sso`).
The chat app reads it, verifies it with the API Gateway and signs the same user in. If you are not signed in to the
portal you are sent to its login page and brought back. Signing out of the portal signs out of the chat as well.

| Setting                  | Where                | Purpose                                                             |
| ------------------------ | -------------------- | ------------------------------------------------------------------- |
| `NEXT_PUBLIC_AUTOMATION_URL` | portal (`frontend`) | Address the **Automation** button opens (default `http://localhost:3004`) |
| `NEXT_PUBLIC_PORTAL_URL` | `automation-chat`    | The portal: pages the chat embeds and the sign-in redirect (default `http://localhost:3000`) |
| `SSO_COOKIE_NAME`        | both                 | Cookie name, must match (default `insurance_sso`)                   |
| `SSO_COOKIE_DOMAIN`      | both                 | Leave empty on localhost. Set a shared parent domain (`.example.com`) when the apps are on different subdomains |
| `SSO_COOKIE_SECURE`      | both                 | `true` behind HTTPS                                                 |

The chat uses the same API Gateway and Chat Agent as before; it needs the rest of the stack running. Details:
[`microservices/frontend-microservices/automation-chat/README.md`](microservices/frontend-microservices/automation-chat/README.md).

## Underwriting Workbench

The underwriting queue, case workspace, post-underwriting verification, live evaluation and assessment history run as
their own app (`microservices/frontend-microservices/underwriting-app/`, port **3005**). It starts with the stack, signs in from the portal's session (the
same `insurance_sso` cookie as the Automation Chat) and uses the same backend. The portal's Underwriting links open
it, and old portal URLs (`/underwriting`, `/case/<id>`…) redirect there with their query string.

```bash
docker compose up -d --build underwriting-app   # the workbench and the backend it needs
docker compose up -d frontend                   # the portal, where sign-in happens
```

| Setting                        | Where                         | Purpose                                                    |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------- |
| `NEXT_PUBLIC_UNDERWRITING_URL` | portal, chat, workbench       | The workbench's public URL (default `http://localhost:3005`) |
| `NEXT_PUBLIC_PORTAL_URL`       | portal, chat, workbench       | The portal's public URL: sign-in and return links (default `http://localhost:3000`) |
| `SSO_COOKIE_NAME` / `SSO_COOKIE_DOMAIN` | all three            | As for the Automation Chat above                           |

Details, the shared-code setup, production builds and benchmarking: [`microservices/frontend-microservices/underwriting-app/README.md`](microservices/frontend-microservices/underwriting-app/README.md).

## Audit Trail

Significant activity across the platform is recorded in a centralized, tenant-isolated, append-only **audit ledger** whose events are
chained with SHA-256, so edited, deleted or reordered records are detected by verification. Services queue audit intents in a transactional
outbox (same transaction as the business change), relay them over Kafka (`insurance.audit.events.v1`), and the Audit Service
(`microservices/backend-microservices/audit-service/`, schema `audit`) assigns sequence numbers and hashes. Tenant admins read their tenant's
trail, and run chain verification, under **Administration → Security & Compliance → Audit Trail**; the platform administrator sees every chain.

Before the first start add `AUDIT_DB_OWNER_PASSWORD` and `AUDIT_DB_APP_PASSWORD` to `.env` (see `.env.example`); `docker compose up -d audit-service`
creates the schema and roles. Hash specification, guarantees, **security limits**, API, operations and manual tamper test:
[service README](microservices/backend-microservices/audit-service/README.md).

**Signed checkpoints (Stage 2).** Every 500 events or 15 minutes per chain, an isolated `audit-signer` container (the only holder of a private key) re-verifies the
chain and signs a checkpoint with Ed25519; copies are kept outside PostgreSQL, so history can no longer be silently rewritten by someone who controls only the database.
One-time per installation: `docker compose run --rm audit-signer-init` (each developer gets their own keys; nothing secret is committed). See the
[Stage 2 section of the service README](microservices/backend-microservices/audit-service/README.md#stage-2-signed-checkpoints) for the trust model, key backup/rotation, and
the manual end-to-end guide.

**Archive & cold storage (Stage 3).** Events older than the hot window (default 6 months) are moved by the Audit Service into **compressed (zstd), encrypted (AES-256-GCM) and signed**
archives in a local **MinIO AIStor Free** bucket (private, versioned, Object Lock). They stay searchable and verifiable (Audit Trail → **Archive & retention**), retention policies
and legal holds are configurable, and only fully archived, re-verified months can be removed from PostgreSQL (a separate, confirmed step; automatic cleanup is off by default).
Archive storage is optional and uses the `storage` Compose profile. An ordinary `docker compose up -d` skips MinIO and its initialization job; document forgery analysis works without them. Archive operations and evaluation dataset storage require MinIO to be configured and running.

One-time per installation, with the AIStor Free license file kept **outside** the repository. Set `AISTOR_LICENSE_FILE` in `.env` to a real file on the current host. On macOS, for example, use `/Users/your-name/.config/insurance-ai/minio.license`; do not copy another machine's `/home/...` path. The file must exist and be accessible to Docker Desktop before starting storage:

```bash
# .env: MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (16+ chars), AUDIT_ARCHIVE_WRITER_KEY/SECRET, AUDIT_ARCHIVE_READER_KEY/SECRET, AISTOR_LICENSE_FILE=<path to your license file>
docker compose --profile storage up -d minio
docker compose --profile storage run --rm minio-init            # private bucket + Object Lock + least-privilege identities (idempotent)
docker compose run --rm audit-archive-init    # archive master key, created once; back it up separately
docker compose up -d audit-service audit-signer
docker compose exec audit-service python -m app.archive.cli status
```

MinIO listens on `127.0.0.1:9000` (S3 API) and `http://localhost:9001` (console, root credentials from `.env`); both are reachable from this machine only. See the
[Stage 3 section of the service README](microservices/backend-microservices/audit-service/README.md#stage-3-archival-retention-and-cold-storage) for setup, ports,
Docker commands, backup/restore, troubleshooting, configuration and the trust model.

## Request Management

Request Management has a separate FastAPI backend (`microservices/backend-microservices/request-management-service/`) and Next.js frontend
(`microservices/frontend-microservices/request-management-app/`). Staff submit a request, the service routes it to an eligible reviewer or queue, and
the reviewer approves, rejects, or asks for more information. It includes revisions, reassignment, comments,
private attachments, audit history, notifications, and overdue reminders. Reviewers cannot approve their own requests.

Details: [service README](microservices/backend-microservices/request-management-service/README.md) (permissions, lifecycle, routing,
execution, API, tests) and [app README](microservices/frontend-microservices/request-management-app/README.md) (pages, sign-in, running).

| Request type | Outcome |
| ------------ | ------- |
| General operational request | Records the review decision without executing an external action |
| Customer profile correction | Queues an approved, allowlisted correction through tenant-service, with conflict checks and duplicate protection |
| Commission dispute | Records a resolution against an existing earning; does not rewrite the ledger or create a payout |

**Approval and execution are separate.** An approved customer correction can still have pending or failed execution.
The service uses a transactional outbox and retryable workers to coordinate delivery and execution. Existing
underwriting, claims, and commission approval flows remain in their owning services.

### Database and first-time setup

The backend shares the existing PostgreSQL instance but owns the `request_management` schema. The
`request_mgmt_owner` role runs versioned SQL migrations, and `request_mgmt_app` accesses application rows.
Business records stay in tenant-service and are accessed through its APIs. No separate PostgreSQL server is required.

Add these values to the root `.env` (use distinct generated secrets):

```env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<existing PostgreSQL admin password>
POSTGRES_DB=insurance-ai
REQUEST_MGMT_DB_OWNER_PASSWORD=<schema owner password>
REQUEST_MGMT_DB_APP_PASSWORD=<application role password>
REQUEST_MGMT_SERVICE_KEY=<shared internal service secret>
```

Use the name of your existing platform database for `POSTGRES_DB`. Compose currently constructs the Request
Management connection URLs against `host.docker.internal:5432`; update its connection settings if PostgreSQL is
elsewhere. The internal service key must match between Request Management and tenant-service.

Provision the roles and schema once, then start the backend and portal:

```bash
docker compose --profile tools run --rm --build request-management-provision
docker compose up -d --build request-management-service tenant-service api-gateway frontend
```

Migrations run on startup when the migration URL is configured. Inspect migration status with:

```bash
docker compose exec request-management-service python -m app.migrate --status
```

For production, run migrations as a separate deployment step and set `REQUEST_MGMT_RUN_MIGRATIONS=false` on
application instances, keeping schema-owner credentials out of the running application.

### Frontend and SSO

The frontend is not currently a Docker Compose service. Create `microservices/frontend-microservices/request-management-app/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:8010
NEXT_PUBLIC_PORTAL_URL=http://localhost:3000
NEXT_PUBLIC_REQUESTS_URL=http://localhost:3007
API_GATEWAY_INTERNAL_URL=http://localhost:8010
SSO_COOKIE_NAME=insurance_sso
```

Start it separately:

```bash
cd microservices/frontend-microservices/request-management-app
npm install
npm run dev
```

Sign in through the portal, then open http://localhost:3007. The app reuses the portal's `insurance_sso` session
and verifies identity through the gateway. Set `NEXT_PUBLIC_REQUESTS_URL` on the portal to change the destination
and allowed SSO return origin. For HTTPS subdomains, use the same SSO cookie name and parent domain across apps.
A tenant administrator must add a routing rule for each request type (Request Management → Routing) before
requests of that type can be submitted.

### Backend configuration

| Setting | Purpose |
| ------- | ------- |
| `REQUEST_MGMT_DATABASE_URL` | Application-role PostgreSQL connection |
| `REQUEST_MGMT_MIGRATION_DATABASE_URL` | Schema-owner connection for migrations |
| `REQUEST_MGMT_SERVICE_KEY` | Authenticates supported internal operations with tenant-service |
| `TENANT_SERVICE_URL` | Identity verification, directory lookups, and domain operations |
| `KAFKA_BOOTSTRAP_SERVERS` | Outbox event publishing |
| `REQUEST_MGMT_WORKERS` | Enables execution, notification, and reminder workers (default `true`) |
| `REQUEST_MGMT_STORAGE` | Attachment storage backend (default `s3`, with local fallback when no bucket is configured) |
| `REQUEST_MGMT_MAX_ATTACHMENT_BYTES` | Attachment size limit (default 10 MiB) |

Attachments support PDF, PNG, and JPEG. Compose mounts a persistent local attachment volume for development.
For S3, supply the bucket, region, and AWS credentials to this service. The public API is exposed through the gateway
at `/request-management/v1`; backend health is available at http://localhost:8017/v1/healthz.

## Customer Service

Customer Service runs as a separate Next.js app (`microservices/frontend-microservices/customer-service-app/`, port **3008**) and FastAPI backend
(`microservices/backend-microservices/customer-service/`, host port **8018**). Open **Operations → Customer Service** in the portal sidebar.
It uses the portal SSO and includes customer/policy-linked tickets, search, status filters, priorities and due dates,
claim/release assignment, replies, internal staff notes, resolution, reopening, and audit history.

Agents and brokers see their own tickets. Admin and ClaimsManager users handle the tenant queue.
Review and policy mutation approvals remain in their owning modules; this release does not execute financial or
policy changes. Customer-visible replies are recorded in the ticket, not sent by email/SMS.

The backend owns the `customer_service` PostgreSQL schema with distinct migration/application roles.
Add generated `CS_DB_OWNER_PASSWORD` and `CS_DB_APP_PASSWORD` values to `.env`, ensure `POSTGRES_DB` matches
`DATABASE_URL`, then start. `customer-service` first runs `customer-service-provision`, which creates the
`customer_service` schema and its two users inside the existing database (safe to repeat), then migrates:

```bash
docker compose up -d --build customer-service customer-service-app api-gateway frontend
```

The provisioner uses `POSTGRES_USER` and `POSTGRES_PASSWORD` with PostgreSQL administrative privileges. Compose currently uses
`host.docker.internal:5432` for the application and migration connections; customize these for a remote database.
The frontend/backend start with the main stack after provisioning. At custom origins, set
`NEXT_PUBLIC_CUSTOMER_SERVICE_URL` on the portal and app and use matching SSO cookie settings.

Details: [backend setup and scope](microservices/backend-microservices/customer-service/README.md),
[frontend setup and production build](microservices/frontend-microservices/customer-service-app/README.md).

## Agent Mobile App

The agent application runs separately through Expo:

```bash
cd mobile-apps/agent-app
npm install
npm start
```

Set the gateway URL when required:

```env
EXPO_PUBLIC_API_URL=http://<your-host>:8010
```

A physical device must use an address reachable from the device rather than `localhost`.

## Local Services

| Service         |            URL / Port |
| --------------- | --------------------: |
| Web Portal      | http://localhost:3000 |
| Automation Chat | http://localhost:3004 (opt-in, see above) |
| Underwriting Workbench | http://localhost:3005 |
| Request Management App | http://localhost:3007 (run separately, see above) |
| API Gateway     | http://localhost:8010 |
| Tenant Service  | http://localhost:8011 |
| Risk Engine     | http://localhost:8012 |
| Decision Engine | http://localhost:8013 |
| OCR Engine      | http://localhost:8014 |
| Document Forensics | http://localhost:8032/docs |
| Admin Document Intelligence | http://localhost:3000/admin/document-intelligence |
| Text Summarizer | Internal Docker service `text-summarizer:8005`, via the authenticated API Gateway |
| Chat Agent      | http://localhost:8016 |
| Customer Service App | http://localhost:3008 |
| Customer Service Backend | http://localhost:8018 |
| Request Management Service | http://localhost:8017 |
| Audit Service   | http://localhost:8030 (via the gateway: `/audit/v1`) |
| MinIO AIStor S3 API (audit archive) | http://127.0.0.1:9000 (this machine only) |
| MinIO Console   | http://localhost:9001 (root credentials from `.env`) |
| Documentation   | http://localhost:4991 |
| Kafka UI        | http://localhost:8090 |
| Memgraph Lab    | http://localhost:3001 |
| Kafka           |           9092 / 9094 |
| Memgraph Bolt   |                  7688 |

PostgreSQL is external and configured through `DATABASE_URL`.

## Development

Branch names follow:

```text
<type>/<short-description>
```

Commit messages follow Conventional Commits:

```text
<type>(<scope>): <description>
```

Examples:

```text
feat(underwriting): add financial verification rules
fix(agent): handle expired session
docs(readme): update architecture overview
```

Useful commands:

```bash
npm run lint:branch
docker compose logs -f risk-engine
docker compose logs -f api-gateway
docker compose down
```

## Documentation

Detailed architecture, service APIs, data flows, database schemas, underwriting rules, and implementation notes live in `microservices/frontend-microservices/docs/`.

Run the documentation locally with:

```bash
cd microservices/frontend-microservices/docs
npm install
npm start
```

Then open:

```text
http://localhost:4991
```

## Development Status

Insurance AI is under active development. The `dev` branch contains the latest platform work and may include experimental or incomplete workflows.

The underwriting rules currently included in the repository are engineering/demo rules and must undergo actuarial, compliance, security, and regulatory validation before production insurance use.

In `ENV_VAR=demo`, tenant Admin users can use **Fill demo data** in Customer Service to add eight
clearly marked sample tickets with replies, internal notes, and overdue examples. Repeated fills do not
duplicate or overwrite tickets. Samples do not link to or modify real customer/policy records.

## Document Intelligence (Admin)

Sign in as a tenant **Admin**, then open **Admin → [Document Intelligence](http://localhost:3000/admin/document-intelligence)**. Upload a document, select the permitted analysis layers and review or download the report. **Saved analyses** lists your organisation's history and reopens stored reports. This page is for tenant Admins; SuperAdmins retain the separate configuration and costing controls.

The old port 3012 workspace now links to the Admin portal. Its upload and performance proxy endpoints return 401. The detection engine requires `X-Internal-Secret` for analysis and metrics; browser clients never receive that secret. The portal forwards the user's JWT through API Gateway, and tenant-service checks role, active account and tenant ownership before analysis or history access.

```sh
docker compose build tenant-service api-gateway frontend docs-forgery forgery-detection-app
docker compose up -d tenant-service api-gateway frontend docs-forgery forgery-detection-app
```

The shared nonempty `INTERNAL_API_SECRET` is required in `.env`. Results are owned by docs-forgery in the `docs_forgery` schema of the same database; run the explicit [schema provisioning/migration](microservices/backend-microservices/docs-forgery/docs/SCHEMA_OWNERSHIP.md#provisioning-and-migration) before starting analysis. The detection runtime and TruFor weights remain in the docs-forgery image. Automatic analysis of other document uploads is not connected.

### Saved reports

PostgreSQL table `docs_forgery.document_intelligence_results` stores the tenant, uploading admin, filename, SHA-256, file size, requested options, timestamps, status, verdict and complete report JSON, including findings, evidence, heatmaps and performance measurements. Original document bytes are not retained. Analyses are recorded before execution and are marked completed, incomplete or failed; success is returned only after the report is committed. Interrupted service processes can leave a processing record; check history before retrying. Retention follows database backup/administration policies; there is no automatic report deletion.

History queries and report downloads are restricted to the signed-in Admin's tenant. The API never accepts a browser-supplied tenant ID. API routes are `POST /document-intelligence/analyze`, `GET /document-intelligence/results`, and `GET /document-intelligence/results/{id}` through API Gateway. The main UI uses authenticated same-origin proxies under `/api/document-intelligence/`.

### Configuration, costing and metrics

SuperAdmins manage thresholds, enabled layers, provider/model names, page/time limits and rates under **[Document Forgery Detection](http://localhost:3000/super-admin/document-forgery)**. Costs appear in **[Token Economy → Document Forgery Detection](http://localhost:3000/super-admin/tokens?tab=document-forgery)**. Rates are snapshotted per analysis; blank means unpriced. Model tokens and local inference time are costed separately, and usage records include tenant attribution.

The **[SuperAdmin performance dashboard](http://localhost:3000/super-admin/document-forgery/performance)** preserves runtime metrics and labelled quality report import. Runtime metrics are process-local and reset on restart. See [metric definitions and benchmarks](microservices/backend-microservices/docs-forgery/docs/PERFORMANCE_METRICS.md). Synthetic checks test functionality and do not establish detection accuracy.

The [engine README](microservices/backend-microservices/docs-forgery/README.md) documents its API and limitations. Pixel thresholds remain provisional; reports provide evidence for human review, and `no_evidence` does not establish authenticity.

Service APIs, credentials, database roles and tenant RLS are explained in [Schema ownership and secure communication](microservices/backend-microservices/docs-forgery/docs/SCHEMA_OWNERSHIP.md). Central settings/costs stay in tenant-service; results are read and written only by docs-forgery.
