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
       ├── POST /evaluate        → publishes ProposalSubmittedEvent to Kafka (202 Accepted)
       └── POST /evaluate/stream → calls Risk Engine directly over HTTP (SSE streaming)

Kafka :9092
  insurance.proposal.submitted.v1   ← Gateway publishes here
  insurance.risk.evaluated.v1       ← Risk Engine consumer publishes here

Risk Engine :8012
  ├── FastAPI server      → POST /evaluate, POST /evaluate/stream (sync HTTP path)
  └── consumer.py daemon  → polls Kafka, runs LangGraph, publishes results

LangGraph Workflow (inside Risk Engine)
  validate_input        → deterministic field + business-rule validation
  medical_scoring       → Gemini 2.5 Flash (age, gender, occupation hazard)
  financial_scoring     → Gemini 2.5 Flash (coverage ratio, term, income stability)
  fraud_detection       → Memgraph ring query + Gemini 2.5 Flash
  decision_aggregation  → deterministic (40% medical + 40% financial + 20% fraud)
                          Auto Approve / Human Review / Decline

Data Stores
  PostgreSQL :5434   → tenants, applicants, policies, risk_assessments, claims, artifacts
  Memgraph   :7688   → fraud ring detection graph (applicant network analysis)
```

---

## Port Reference

| Service | Host Port | Purpose |
|---|---|---|
| Frontend | 3000 | Next.js underwriting dashboard |
| Memgraph Lab Web | 3001 | Graph database UI |
| PostgreSQL | 5434 | Relational database (internal: 5432) |
| Memgraph Bolt | 7688 | Bolt protocol for graph queries |
| Memgraph Lab | 7445 | Memgraph Lab UI |
| API Gateway | 8010 | Main public entry point |
| Tenant Service | 8011 | Tenant management |
| Risk Engine | 8012 | LangGraph risk evaluation |
| Decision Engine | 8013 | (Scaffolded — future) |
| OCR Engine | 8014 | Document text extraction via Gemini |
| Text Summarizer | 8015 | OCR text summarization via Gemini |
| Kafka UI | 8090 | Inspect Kafka topics and messages |
| Kafka | 9092 | Internal broker (service → service) |
| Kafka | 9094 | External listener (host tools, Postman) |

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) ≥ 4.x (includes Docker Compose v2)
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/)

---

## First Time Setup

**1. Copy the environment file and set your credentials**

```bash
cp .env.example .env
```

Open `.env` and fill in your Gemini API key and any other credentials before running anything.

**2. Build images and start all services**

```bash
docker compose up --build -d
```

This pulls base images, installs dependencies, and starts all containers. Takes **3–5 minutes** on a cold machine. Run `docker compose ps` to confirm all services are healthy before proceeding.

**3. Create your first tenant**

The platform is multi-tenant. Every request requires a valid `X-Tenant-Id` header. Create one tenant to get started:

```bash
curl -s -X POST "http://localhost:8010/tenants?name=Acme+Insurance" | python3 -m json.tool
```

Copy the `id` from the response — you will pass it as `X-Tenant-Id` in every subsequent request.

**4. Start the Kafka consumer daemon**

The Risk Engine exposes a Kafka consumer that processes async proposals. Run it in a separate terminal:

```bash
docker compose exec risk-engine python consumer.py
```

You should see:
```
INFO  consumer started — polling insurance.proposal.submitted.v1
```

Leave this running. It polls continuously and publishes results to `insurance.risk.evaluated.v1`.

**5. Verify everything is up**

| URL | Expected response |
|---|---|
| http://localhost:3000 | Underwriting dashboard (Next.js) |
| http://localhost:8010/health | `{"service":"api-gateway","status":"healthy"}` |
| http://localhost:8012/health | `{"service":"risk-engine","status":"healthy"}` |
| http://localhost:8014/health | `{"status":"healthy","engine":"Gemini 2.5 Flash"}` |
| http://localhost:8015/health | `{"status":"healthy","engine":"Gemini 2.5 Flash"}` |
| http://localhost:8010/docs | API Gateway — Swagger UI |
| http://localhost:8012/docs | Risk Engine — Swagger UI |
| http://localhost:8014/docs | OCR Engine — Swagger UI |
| http://localhost:8015/docs | Text Summarizer — Swagger UI |
| http://localhost:8090 | Kafka UI — topic browser |
| http://localhost:3001 | Memgraph Lab — graph database UI |

---

## API Reference

### Underwriting — Async Path (recommended)

**POST /evaluate** — submits a proposal to Kafka and returns immediately.

```bash
curl -s -X POST http://localhost:8010/evaluate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: <tenant-id>" \
  -d '{
    "applicant": {
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

| Type | When | Payload |
|---|---|---|
| `progress` | each LangGraph node completes | `{node, data}` |
| `invalid` | validation failed | `{errors: [...]}` |
| `saved` | DB write complete | full assessment object |
| `error` | something failed | `{message}` |

---

### LangGraph Workflow — Decision Bands

The `decision_aggregation` node is fully deterministic:

```
composite_score = (40% × medical_score) + (40% × financial_score) + (20% × fraud_probability × 100)
```

| Decision | Condition |
|---|---|
| **Auto Approve** | composite < 30 AND fraud_probability < 0.10 |
| **Decline** | composite > 75 OR fraud_probability > 0.60 |
| **Human Review** | everything else |

The final `reasons` list includes XAI outputs from all three scoring nodes plus a plain-English math breakdown of the composite calculation.

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
    "applicant": { "cnic": "35201-1234567-1", "name": "Sara Ahmed", "dob": "1998-04-10", "gender": "female", "occupation": "software engineer", "declared_income": 500000 },
    "policy": { "product_name": "Term Life Insurance", "coverage_amount": 3000000, "term_years": 10 }
  }' | python3 -m json.tool
```

---

## Kafka Topics

| Topic | Producer | Consumer | Payload |
|---|---|---|---|
| `insurance.proposal.submitted.v1` | API Gateway | `consumer.py` | `ProposalSubmittedEvent` — applicant + policy data |
| `insurance.risk.evaluated.v1` | `consumer.py` | *(result consumer — future)* | `RiskEvaluatedEvent` — scores + decision |

Browse both topics live at **http://localhost:8090** (Kafka UI).

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

The `shared/` directory is bind-mounted into the gateway and risk-engine. Uvicorn reloads automatically. Schema changes to the DB models require a full reset:

```bash
docker compose down -v          # drops all volumes (wipes PostgreSQL and Kafka data)
docker compose up --build       # recreates everything from scratch
```

### `docker-compose.yml` or `.env` changed

```bash
docker compose down
docker compose up --build -d
```

---

## Common Commands

```bash
# Start everything (after first-time setup)
docker compose up -d

# Rebuild and start specific services
docker compose up --build api-gateway risk-engine -d

# Start the Kafka consumer (in a separate terminal)
docker compose exec risk-engine python consumer.py

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

# Connect to PostgreSQL
docker compose exec postgres psql -U insurance insurance
# or from host:
psql -h localhost -p 5434 -U insurance insurance

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

### Database doesn't exist

```bash
docker compose down
docker volume rm insurance-ai_postgres-data
docker compose up --build -d
```

### Service won't start — missing `.env`

```bash
cp .env.example .env
# fill in GEMINI_API_KEY and other credentials, then:
docker compose up -d
```

### Memgraph graph query returns no results

Memgraph starts empty. Fraud ring detection only returns connections for applicants who were previously evaluated and written to the graph. On a fresh instance, the `fraud_detection` node falls back gracefully (fraud_probability defaults to LLM-only assessment).
