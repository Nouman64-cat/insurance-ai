---
id: intro
slug: /
title: Overview
sidebar_position: 1
---

# insurance-ai

**insurance-ai** is an AI-powered, multi-tenant insurance underwriting platform built for Pakistani insurance companies. It automates the risk evaluation pipeline — from proposal submission to an explainable AI decision — using a microservices architecture backed by LLMs, a graph database, and an event-driven Kafka bus.

## What it does

1. An agent (or the frontend) submits an insurance proposal (applicant + policy) to the API Gateway.
2. The **Risk Engine** runs a LangGraph workflow powered by **Google Gemini 2.5 Flash** that scores the applicant across three dimensions:
   - **Medical risk** — age, gender, occupation hazard
   - **Financial risk** — income-to-coverage ratio, policy term, occupation stability
   - **Fraud probability** — graph ring detection via Memgraph + LLM evaluation
3. A deterministic **decision aggregation** step combines the scores into a composite risk score and emits one of four verdicts: `Auto Approve`, `Approve with Loading`, `Human Review`, or `Decline`.
4. Results are persisted to **PostgreSQL** and returned to the caller with an explainability chain — ordered human-readable reasons for the underwriter UI.

## Local ports

| Service | Host port | Description |
|---|---|---|
| Frontend (Next.js) | 3000 | Underwriter UI |
| Memgraph Lab | 3001 | Graph DB browser |
| **Docs (this site)** | 4991 | Documentation |
| API Gateway | 8010 | Single public entry point |
| Tenant Service | 8011 | Auth, users, tenants |
| Risk Engine | 8012 | LangGraph underwriting |
| Decision Engine | 8013 | (WIP) |
| OCR Engine | 8014 | Document extraction |
| Text Summarizer | 8015 | OCR summary generation |
| Kafka UI | 8090 | Topic browser |
| PostgreSQL | *(external)* | Not run via docker-compose — point `DATABASE_URL` at your own instance |
| Memgraph (Bolt) | 7688 | Graph store |

## Quick start

```bash
# 1. Copy env template, fill in GEMINI_API_KEY and DATABASE_URL
#    (PostgreSQL is external — see "PostgreSQL is external" note below)
cp .env.example .env

# 2. Start all services
docker compose up --build

# 3. Bootstrap a SuperAdmin (creates the "Platform" tenant + SuperAdmin user,
#    emails the generated credentials)
docker compose exec tenant-service python create_superadmin.py --email you@yourdomain.com

# 4. Log in as SuperAdmin, then create a tenant (name + a short unique code)
TOKEN=$(curl -s -X POST http://localhost:8010/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=you@yourdomain.com" \
  --data-urlencode "password=<password from step 3>" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -X POST http://localhost:8010/tenants \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Acme Insurance", "code": "ACME"}'

# 5. Submit a proposal (sync evaluate) — insurance_type is required
curl -X POST http://localhost:8010/evaluate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: <tenant_id from step 4>" \
  -d '{
    "applicant": {
      "cnic": "3520112345671",
      "name": "Muhammad Ali Khan",
      "dob": "1985-06-15",
      "gender": "Male",
      "occupation": "Software Engineer",
      "declared_income": 1200000
    },
    "policy": {
      "product_name": "Term Life 20",
      "insurance_type": "TERM_LIFE",
      "coverage_amount": 5000000,
      "term_years": 20
    }
  }'
```

**PostgreSQL is external.** It is not a docker-compose service — run your own instance (local install, managed cloud DB, etc.), create an empty database, and point `DATABASE_URL` at it. On macOS/Windows Docker Desktop, containers reach a host-installed Postgres via `host.docker.internal`.

Swagger UI is available at `http://localhost:8010/docs`.
