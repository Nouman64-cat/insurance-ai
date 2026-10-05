# insurance-ai — AI-Powered Insurance Underwriting Platform

An event-driven, multi-tenant insurance underwriting platform built on FastAPI microservices, LangGraph AI workflows, Kafka, PostgreSQL, and Memgraph.

---

## Architecture Overview

```
Browser / Postman
       │  HTTP
       ▼
 API Gateway :8010          ← single public entry point, tenant auth
       │
       ├── POST /evaluate        → Requirements gate, then publishes ProposalSubmittedEvent to Kafka (202 Accepted)
       └── POST /evaluate/stream → Requirements gate, then calls Risk Engine directly over HTTP (SSE streaming)

Requirements/Evidence gate (api-gateway, before either path reaches Risk Engine)
  POST .../requirements/determine  → tenant-service's Requirements Engine; case-less calls skip this
  if NOT satisfied                 → case moves to "Pending Documents", Risk Engine is never called
  POST .../underwriting/evidence   → document evidence + e-application/ACR + verification findings bundle

Kafka :9092
  insurance.proposal.submitted.v1   ← Gateway publishes here
  insurance.risk.evaluated.v1       ← Risk Engine consumer publishes here; api-gateway's
                                        risk_result_worker.py persists the RiskAssessment
                                        (idempotent on RiskEvaluatedEvent.correlation_id)
  insurance.case.events.v1          ← tenant-service publishes workflow/requirement/
                                        verification events here, fanned out live over
                                        SSE by api-gateway's case_event_hub.py

Risk Engine :8012
  ├── FastAPI server      → POST /evaluate, POST /evaluate/stream (sync HTTP path)
  └── consumer.py daemon  → polls Kafka, runs LangGraph, publishes results

LangGraph Workflow (inside Risk Engine) — see shared/underwriting/ for the rule modules
  validate_input             → deterministic field + business-rule validation
  load_underwriting_profile  → assembles customer + policy + e-application + ACR +
                                 document evidence into one normalized profile
  medical_scoring            → Gemini 2.5 Flash + deterministic BMI/smoker/condition floors
  financial_scoring          → Gemini 2.5 Flash + deterministic coverage-vs-income ceiling
  fraud_detection            → Memgraph ring query + Gemini 2.5 Flash + deterministic severity bands
  decision_engine            → rule-based over the three independent results (NOT a weighted
                                 sum — see "Decision Rules" below). Composite score is still
                                 computed and returned for the dashboard, but never decides.

Data Stores
  PostgreSQL         → tenants, customers, policies, risk_assessments, claims, artifacts,
                       case_requirements, verification_findings
                       (external service — NOT a docker-compose container; see below)
  Memgraph   :7688   → fraud ring detection graph (customer network analysis)
```

**PostgreSQL is external.** It is no longer part of `docker-compose.yml` — every service connects to a Postgres instance you run yourself (a local install, a managed cloud database, etc.) via the `DATABASE_URL` in `.env`. Containers reach a host-installed Postgres through `host.docker.internal` (macOS/Windows Docker Desktop); on Linux you may need `--add-host=host.docker.internal:host-gateway` or the host's LAN IP instead.

---

## Port Reference

| Service          | Host Port      | Purpose                                                                  |
| ---------------- | -------------- | ------------------------------------------------------------------------ |
| Frontend         | 3000           | Next.js underwriting dashboard                                           |
| Memgraph Lab Web | 3001           | Graph database UI                                                        |
| **Docs**   | **4991** | **Docusaurus documentation site**                                  |
| PostgreSQL       | *(external)* | Not run via docker-compose — point`DATABASE_URL` at your own instance |
| Memgraph Bolt    | 7688           | Bolt protocol for graph queries                                          |
| Memgraph Lab     | 7445           | Memgraph Lab UI                                                          |
| API Gateway      | 8010           | Main public entry point                                                  |
| Tenant Service   | 8011           | Tenant management                                                        |
| Risk Engine      | 8012           | LangGraph risk evaluation                                                |
| Decision Engine  | 8013           | (Scaffolded — future)                                                   |
| OCR Engine       | 8014           | Document text extraction via Gemini                                      |
| Text Summarizer  | 8015           | OCR text summarization via Gemini                                        |
| Kafka UI         | 8090           | Inspect Kafka topics and messages                                        |
| Kafka            | 9092           | Internal broker (service → service)                                     |
| Kafka            | 9094           | External listener (host tools, Postman)                                  |

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) ≥ 4.x (includes Docker Compose v2)
- A **running PostgreSQL instance** reachable from your machine (local install, Postgres.app, a managed cloud DB, etc.) — **not** provided by docker-compose. Create an empty database for the app to migrate into.
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/)
- [Node.js](https://nodejs.org/) ≥ 18 — for the git commit/branch lint hooks (see [Git Branch & Commit Conventions](#git-branch--commit-conventions))

---

## First Time Setup

**1. Copy the environment file and set your credentials**

```bash
cp .env.example .env
```

Open `.env` and fill in:

- `DATABASE_URL` — pointing at your external PostgreSQL instance and the empty database you created (e.g. `postgresql+asyncpg://postgres:yourpassword@host.docker.internal:5432/insurance-ai` on macOS/Windows Docker Desktop)
- Your Gemini API key and any other credentials

**2. Build images and start all services**

```bash
docker compose up --build -d
```

This pulls base images, installs dependencies, and starts all containers. Takes **3–5 minutes** on a cold machine. Run `docker compose ps` to confirm all services are healthy before proceeding.

On first boot, `tenant-service` connects to your external PostgreSQL via `DATABASE_URL` and runs its migrations automatically (`migrate.py`, via the FastAPI lifespan) — check `docker compose logs tenant-service` for `all migrations complete` if a service fails to come up healthy.

**3. Create the platform SuperAdmin**

Tenant creation and Admin bootstrap are gated behind a **SuperAdmin** — a platform-level operator attached to a reserved `"Platform"` tenant. Create one with the bootstrap CLI (run inside the `tenant-service` container):

```bash
docker compose exec tenant-service python create_superadmin.py --email you@yourdomain.com
```

Only `--email` is required. Nothing is taken from the email — the display name is a random single word (e.g. `Riley`), the username is that word plus random digits (e.g. `riley4821`), and a secure password is auto-generated. Optional overrides: `--username`, `--first-name`, `--last-name`, `--password`.

The credentials are printed to stdout (and best-effort emailed via SES — `emailed: no` just means email isn't configured; the account still exists). Re-running is safe: it reuses the `"Platform"` tenant and `SuperAdmin` role, and errors if the email/username is already taken.

```
SuperAdmin created:
  email:    you@yourdomain.com
  username: riley4821
  name:     Riley
  password: <generated>
```

**4. Create your first tenant**

The platform is multi-tenant. Every request requires a valid `X-Tenant-Id` header. Log in as the SuperAdmin to get a JWT, then create a tenant:

```bash
# Log in (form-encoded; "username" is the SuperAdmin email)
TOKEN=$(curl -s -X POST http://localhost:8010/auth/token \
  -d "username=you@yourdomain.com" \
  -d "password=<superadmin-password>" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Create a tenant (name + alphanumeric code both required)
curl -s -X POST http://localhost:8010/tenants \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Insurance", "code": "ACME"}' | python3 -m json.tool
```

Copy the `id` from the response — you pass it as `X-Tenant-Id` in every subsequent request.

To bootstrap that tenant's first Admin user (all calls use the SuperAdmin `$TOKEN`):

```bash
TENANT_ID=<id-from-above>

# a) create a branch the Admin will belong to
BRANCH_ID=$(curl -s -X POST http://localhost:8010/tenants/$TENANT_ID/branches \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"branch_code": "HQ", "name": "Head Office", "city": "Karachi"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# b) create the first Admin (username + password are generated and emailed / returned)
curl -s -X POST http://localhost:8010/tenants/$TENANT_ID/setup \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\": \"admin@acme.com\", \"full_name\": \"Acme Admin\", \"branch_id\": \"$BRANCH_ID\"}" \
  | python3 -m json.tool
```

After that, the Admin logs in via `POST /auth/token` and manages users normally.

**5. Start the Kafka consumer daemon**

The Risk Engine exposes a Kafka consumer that processes async proposals. Run it in a separate terminal:

```bash
docker compose exec risk-engine python consumer.py
```

You should see:

```
INFO  consumer started — polling insurance.proposal.submitted.v1
```

Leave this running. It polls continuously and publishes results to `insurance.risk.evaluated.v1`.

**6. Verify everything is up**

| URL                          | Expected response                                    |
| ---------------------------- | ---------------------------------------------------- |
| http://localhost:3000        | Underwriting dashboard (Next.js)                     |
| http://localhost:4991        | Docusaurus documentation site                        |
| http://localhost:8010/health | `{"service":"api-gateway","status":"healthy"}`     |
| http://localhost:8012/health | `{"service":"risk-engine","status":"healthy"}`     |
| http://localhost:8014/health | `{"status":"healthy","engine":"Gemini 2.5 Flash"}` |
| http://localhost:8015/health | `{"status":"healthy","engine":"Gemini 2.5 Flash"}` |
| http://localhost:8010/docs   | API Gateway — Swagger UI                            |
| http://localhost:8012/docs   | Risk Engine — Swagger UI                            |
| http://localhost:8014/docs   | OCR Engine — Swagger UI                             |
| http://localhost:8015/docs   | Text Summarizer — Swagger UI                        |
| http://localhost:8090        | Kafka UI — topic browser                            |
| http://localhost:3001        | Memgraph Lab — graph database UI                    |

---

## Documentation Site

The project ships with a [Docusaurus](https://docusaurus.io/) site covering architecture, DB schemas, data flow, the tech stack, and a per-service endpoint reference — all with live Mermaid diagrams.

**Run without Docker (fastest):**

```bash
cd docs
npm install
npm start
# → http://localhost:4991
```

**Run via Docker Compose (alongside all other services):**

```bash
docker compose up docs
# → http://localhost:4991
```

No `--build` step needed — the docs service uses the pre-built `node:20-alpine` image and installs dependencies at startup.

Source lives in `docs/docs/`. Edit any `.md` file and the browser hot-reloads automatically.

---

## API Reference

### Underwriting — Async Path (recommended)

**POST /evaluate** — submits a proposal to Kafka and returns immediately.

```bash
curl -s -X POST http://localhost:8010/evaluate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: <tenant-id>" \
  -d '{
    "customer": {
      "cnic": "35201-1234567-1",
      "name": "Sara Ahmed",
      "dob": "1998-04-10",
      "gender": "Female",
      "occupation": "Software Engineer",
      "declared_income": 500000
    },
    "policy": {
      "product_name": "Term Life Insurance",
      "coverage_amount": 3000000,
      "term_years": 10
    }
  }'
```

Response — **202 Accepted**:

```json
{
  "event_id": "3f2e1a...",
  "proposal_id": "7c4b9d...",
  "status": "accepted",
  "message": "Proposal queued for async risk evaluation."
}
```

Use the `event_id` to correlate the result on `insurance.risk.evaluated.v1` (visible in Kafka UI at `http://localhost:8090`).

---

### Underwriting — Sync Streaming Path (dev/testing)

**POST /evaluate/stream** — calls the Risk Engine directly and streams SSE progress events as each LangGraph node completes.

```bash
curl -s -X POST http://localhost:8010/evaluate/stream \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: <tenant-id>" \
  -H "Accept: text/event-stream" \
  --no-buffer \
  -d '{ ... same body ... }'
```

SSE event types:

| Type         | When                          | Payload                |
| ------------ | ----------------------------- | ---------------------- |
| `progress`             | each LangGraph node completes                        | `{node, data}`                             |
| `invalid`              | validation failed                                     | `{errors: [...]}`                          |
| `pending_requirements` | mandatory requirements unmet — Risk Engine never ran  | `{requirements, satisfied, case_status}`   |
| `saved`                | DB write complete                                     | full assessment object                     |
| `error`                | something failed                                      | `{message}`                                |

---

### Underwriting Requirements Engine

Before either evaluation path reaches the Risk Engine, api-gateway calls tenant-service's
Requirements Engine (`shared/underwriting/requirements_rules.py`) for any case-scoped call.
It determines what evidence a case needs — CNIC, salary slip, bank statement, tax document,
medical questionnaire/examination, ECG, lab reports, physician report — based on age,
coverage, coverage-to-income ratio, smoker status, BMI, and declared medical conditions, and
persists the result as `CaseRequirement` rows. If any **required** item is not
`Satisfied`/`Waived`, the case moves to `Pending Documents` and the Risk Engine is never
called — there is no automatic decision on an incomplete case. Requirements are
case-scoped and pre-decision; they are a separate concept from the existing
policy-scoped, post-decision `PolicyRequirement`/`ComplianceCheck` pre-issuance gate.

A parallel Verification stage (`shared/underwriting/verification.py`) cross-checks declared
vs. document-evidenced values (income, identity, medical conditions, employer) and persists
structured `VerificationFinding` rows, which the decision rules below also consult.

### LangGraph Workflow — Decision Rules

The `decision_engine` node is rule-based over the three **independent** results produced by
`medical_scoring`/`financial_scoring`/`fraud_detection` — it does **not** average them into a
weighted composite score. A composite is still computed and returned (for the dashboard/
explainability only):

```
composite_score = (40% × medical_score) + (40% × financial_score) + (20% × fraud_probability × 100)
```

...but the actual decision is a sequential rule chain (`shared/underwriting/decision_rules.py`),
evaluated roughly in this order:

| Decision                          | Condition (first match wins)                                          |
| ---------------------------------- | ----------------------------------------------------------------------- |
| **Request Additional Evidence** | mandatory requirements not satisfied                                   |
| **Fraud Investigation**         | fraud severity High/Critical, or `investigation_required`              |
| **Human Review**                | fraud severity Medium                                                  |
| **Decline**                     | medical classification is Decline                                      |
| **Postpone**                    | medical classification is Postpone                                     |
| **Human Review**                | medical classification is Medical Review Required / ambiguous          |
| **Decline** / **Human Review**  | financial not justified (Decline, or Human Review if referral_required) |
| **Human Review**                | unresolved high-severity verification finding                          |
| **Approve with Loading**        | medical classification is Substandard/Rated, or a loading applies      |
| **Human Review**                | financial flagged for referral, or medium-severity finding             |
| **Auto Approve**                | everything else clears                                                 |

Because this is a sequential chain and not a weighted sum, a severe medical or fraud finding
can never be mathematically cancelled out by good scores elsewhere — each check either
returns its own decision immediately or falls through to the next one. The AI layer never
auto-finalizes `Approved`/`Declined`: every decision above still only parks the case/policy at
`Under Review` (or `Pending Documents` for Request Additional Evidence) — only a human
underwriter reaches Approved/Rejected, via `PATCH /cases/{id}/status`.

The final `reasons` list includes XAI outputs from all three scoring nodes, which decision
rule fired, and the composite math breakdown (dashboard-only). The structured
`MedicalUnderwritingResult`/`FinancialUnderwritingResult`/`FraudAssessment` objects are
persisted verbatim on `RiskAssessment.underwriting_results` for the Case Detail UI's
Requirements/Verification/Medical/Financial/Fraud panels.

---

### OCR Engine

**POST /extract** — upload a PDF or image, get extracted text.

```bash
curl -s -X POST http://localhost:8014/extract \
  -F "file=@/path/to/document.pdf"
```

**POST /extract/stream** — same, as SSE stream.

Supported formats: `PDF`, `PNG`, `JPG`, `JPEG`, `TIFF`, `BMP`

---

### Text Summarizer

**POST /summarize** — summarize OCR-extracted text from one or more documents.

```bash
curl -s -X POST http://localhost:8015/summarize \
  -H "Content-Type: application/json" \
  -d '{
    "documents": ["<extracted text from OCR>"],
    "max_words": 200
  }'
```

**POST /summarize/stream** — same, as SSE stream.

---

### Risk Engine (direct — bypass gateway)

Useful for testing the LangGraph workflow in isolation without Kafka or tenant auth.

```bash
curl -s -X POST http://localhost:8012/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "customer": { "cnic": "35201-1234567-1", "name": "Sara Ahmed", "dob": "1998-04-10", "gender": "female", "occupation": "software engineer", "declared_income": 500000 },
    "policy": { "product_name": "Term Life Insurance", "coverage_amount": 3000000, "term_years": 10 }
  }' | python3 -m json.tool
```

---

## Kafka Topics

| Topic                                  | Producer                          | Consumer                                                             | Payload                                                                                      |
| --------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `insurance.proposal.submitted.v1`     | API Gateway                       | risk-engine `consumer.py`                                            | `ProposalSubmittedEvent` — customer + policy + evidence bundle                             |
| `insurance.risk.evaluated.v1`         | risk-engine `consumer.py`         | api-gateway `risk_result_worker.py`                                   | `RiskEvaluatedEvent` — scores + decision + structured underwriting_results                |
| `insurance.artifact.ocr.requested.v1` | tenant-service (artifact upload) | tenant-service `ocr_worker.py`                                        | `ArtifactOCRRequestedEvent`                                                                  |
| `insurance.customer.created.v1`       | tenant-service                    | api-gateway `quote_worker.py`                                         | `CustomerCreatedEvent`                                                                       |
| `insurance.policy.lifecycle.v1`       | tenant-service                    | *(none currently)*                                                    | `PolicyLifecycleEvent`                                                                       |
| `insurance.case.events.v1`            | tenant-service                    | api-gateway `case_event_hub.py` → live SSE to the frontend           | `CaseEvent` — includes `RequirementsDetermined`/`VerificationCompleted` event types now |

`risk_result_worker.py` dedupes on `RiskEvaluatedEvent.correlation_id` before writing a
`RiskAssessment`, so a redelivered message never creates a duplicate row.

Browse all topics live at **http://localhost:8090** (Kafka UI).

---

## After Making Code Changes

### Python service changed

Source directories are volume-mounted, so **uvicorn `--reload` picks up `.py` saves automatically** — no restart needed.

If you changed `requirements.txt`, rebuild that service's image:

```bash
docker compose up --build api-gateway
docker compose up --build risk-engine
```

If you added a new package to the risk-engine and the change is cached, force a clean rebuild:

```bash
docker compose build --no-cache risk-engine
docker compose up risk-engine -d
```

### Frontend changed

Next.js dev server has hot-reload enabled — saving any file under `frontend/` refreshes the browser automatically.

If you added an npm package:

```bash
docker compose up --build frontend
```

### Shared models changed (`shared/models/core.py` or `shared/events/kafka_events.py`)

The `shared/` directory is bind-mounted into the gateway and risk-engine. Uvicorn reloads automatically.

PostgreSQL is external, so `docker compose down -v` no longer touches it (that only wipes Kafka's volume now). Schema changes to the DB models go through an additive migration instead of a full reset — add a new entry to `MIGRATIONS` in `services/tenant-service/migrate.py` following the existing add-column → backfill → set-not-null pattern, then restart `tenant-service` (or let `--reload` pick it up) to apply it against your existing database.

### `docker-compose.yml` or `.env` changed

```bash
docker compose down
docker compose up --build -d
```

---

## Git Branch & Commit Conventions

Full guide: [Git Branch and Commit Naming Convention](https://doc.clickup.com/90182858897/d/2kzn2e4h-818/git-branchand-commit-naming-convention)

### Enable the git hooks (once per clone)

```bash
npm install   # at the repo root — installs Husky + Commitlint and activates the hooks
```

| Hook | Checks | Runs on |
|---|---|---|
| `commit-msg` | Commit message format (`commitlint.config.mjs`) | `git commit` |
| `pre-push` | Branch name format (`scripts/lint-branch-name.mjs`) | `git push` |

A PR workflow (`.github/workflows/naming-lint.yml`) runs the same checks on GitHub when Actions are available.

### Branch naming

```
<type>/<short-kebab-case-description>
<type>/<ticket-id>-<short-description>      # when a task/ticket ID exists
```

Allowed types: `feat`, `fix`, `hotfix`, `refactor`, `docs`, `test`, `perf`, `ci`, `chore`

```
feat/user-authentication
fix/login-token-expiry
refactor/vector-retrieval
feat/AI-142-rag-evaluation
fix/CU-12345-login-token-expiry
```

`main`, `dev` and `gh-pages` are exempt. To rename a branch: `git branch -m <new-name>`.

### Commit messages

```
<type>(<scope>): <description>
```

Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `ci`, `chore`, `build`, `style`

Rules:
- Scope is required and kebab-case — e.g. `auth`, `rag`, `agent`, `api`, `deps`
- Description is short, clear, imperative, and starts lowercase — no trailing period
- Header (first line) is at most 72 characters; put extra detail in the body (`git commit -m "<header>" -m "<body>"`)

```
feat(auth): add JWT authentication
fix(rag): prevent duplicate documents
refactor(agent): simplify state management
docs(readme): add setup instructions
chore(deps): update dependencies
```

Avoid: `updated code`, `fix`, `changes`, `final changes`, `feat(auth): Add thing`

Check a branch name manually: `npm run lint:branch`

---

## Common Commands

```bash
# Start everything (after first-time setup)
docker compose up -d

# Rebuild and start specific services
docker compose up --build api-gateway risk-engine -d

# Start the Kafka consumer (in a separate terminal)
docker compose exec risk-engine python consumer.py

# Create a platform SuperAdmin (tenant / admin bootstrap operator)
docker compose exec tenant-service python create_superadmin.py --email you@yourdomain.com

# Watch logs for one service
docker compose logs -f risk-engine
docker compose logs -f api-gateway

# Stop all containers (data is preserved)
docker compose down

# Stop and wipe all data volumes (full reset)
docker compose down -v

# Open a shell inside a running service
docker compose exec api-gateway sh
docker compose exec risk-engine sh

# Connect to PostgreSQL (external — connect directly from the host, matching your DATABASE_URL)
psql -h localhost -p 5432 -U <user> -d <database>

# List Kafka topics
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list

# Tail messages on a Kafka topic
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic insurance.risk.evaluated.v1 \
  --from-beginning
```

---

## Troubleshooting

### Port conflicts

```bash
# Find which process is using a port
lsof -i :8010

# Stop all containers and try again
docker compose down
docker compose up -d
```

### Kafka consumer not receiving messages

1. Confirm Kafka is healthy: `docker compose ps kafka`
2. Confirm the topic exists: `docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list`
3. Check consumer logs in the terminal where you ran `python consumer.py`
4. Inspect the topic in Kafka UI at `http://localhost:8090`

### Risk Engine unhealthy after code change

```bash
docker compose logs risk-engine --tail 30
```

If the error is `ModuleNotFoundError`, a new dependency was added to `requirements.txt` but not installed — rebuild without cache:

```bash
docker compose build --no-cache risk-engine && docker compose up risk-engine -d
```

### LLM provider / fallback configuration

**All four LLM services** — `chat-agent`, `risk-engine`, `ocr-engine`,
`text-summarizer` — resolve a **primary** and **fallback** model at runtime and
retry the identical request against the fallback on any primary failure (429
rate limit, 503 overload, 403 billing/"dunning" block, quota exhaustion).

Configure it in the **SuperAdmin UI** — *Platform → LLM Configuration*
(`/super-admin/llm-config`). Pick the provider (Gemini / OpenAI / Anthropic)
for the primary and fallback roles, set the model, paste the API key, hit
**Test key**. Keys are stored **Fernet-encrypted** in `llm_provider_config`
(needs `CONFIG_ENCRYPTION_KEY` in `.env`) and never returned to the browser.
Changes take effect within ~60s — no restart. The services read the decrypted
set from `tenant-service`'s internal-only `GET /internal/llm-config` (guarded
by `INTERNAL_API_SECRET`, not exposed through the api-gateway).

**No provider keys live in `.env`.** An optional env fallback
(`GEMINI_API_KEY` / `GEMINI_MODEL` for the primary; `OPENAI_API_KEY` /
`OPENAI_FALLBACK_MODEL` then `ANTHROPIC_API_KEY` / `ANTHROPIC_FALLBACK_MODEL`
for the fallback) is only consulted when the DB config is empty or
`tenant-service` is unreachable.

**OCR / PDF caveat:** OpenAI chat models cannot read PDFs — only Gemini and
Anthropic can. If the OCR fallback is OpenAI and a PDF is submitted while the
PDF-capable provider is down, `ocr-engine` returns a clear error pointing at
the LLM Configuration page. Images work on all three providers.

```bash
# What are the services actually using right now?
curl -s -H "X-Internal-Secret: $INTERNAL_API_SECRET" \
  http://localhost:8011/internal/llm-config | python3 -m json.tool
docker compose exec ocr-engine  curl -s localhost:8004/health
docker compose exec text-summarizer curl -s localhost:8005/health

# Is the primary provider itself the problem?
docker compose exec chat-agent python -c "import asyncio,providers; \
c=asyncio.run(providers.resolve()); print(c['primary']['provider'], c['primary']['model'])"
```

A `PERMISSION_DENIED` / `dunning` error means the Gemini key's Google Cloud
project is blocked for a payment issue — fix billing at https://ai.studio, or
switch the primary to OpenAI/Anthropic in the UI.

### Token Economy (`/super-admin/tokens`)

Every LLM call posts a row to `tenant-service`'s `/tokens/usage` with the
**model that actually ran** (`chat-agent`, `risk-engine`, `ocr-engine`,
`text-summarizer`). The page prices each model at its own rate — see
`MODEL_PRICING` in `frontend/app/super-admin/tokens/page.tsx` (verify against
the provider pricing pages periodically). Rows whose model isn't in that table
are costed at `DEFAULT_RATE` and flagged "estimated" in the UI.

### Database doesn't exist / tenant-service can't connect

PostgreSQL is external, so there's no docker volume to reset here. Instead:

1. Confirm the database in `DATABASE_URL` actually exists on your Postgres instance (`CREATE DATABASE insurance-ai;` if not).
2. Confirm the host is reachable from inside a container — on macOS/Windows Docker Desktop this is normally `host.docker.internal`; on Linux you may need `--add-host` or the host's LAN IP.
3. Test the connection directly from your host first: `psql -h localhost -p 5432 -U <user> -d <database>`.
4. Restart `tenant-service` to re-run migrations once the connection is confirmed: `docker compose restart tenant-service`.

### Service won't start — missing `.env`

```bash
cp .env.example .env
# fill in GEMINI_API_KEY and other credentials, then:
docker compose up -d
```

### Memgraph graph query returns no results

Memgraph starts empty. Fraud ring detection only returns connections for customers who were previously evaluated and written to the graph. On a fresh instance, the `fraud_detection` node falls back gracefully (fraud_probability defaults to LLM-only assessment).
