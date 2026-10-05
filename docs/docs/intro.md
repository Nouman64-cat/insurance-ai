---
id: intro
slug: /
title: Overview
sidebar_position: 1
---

# insurance-ai

**insurance-ai** is an AI-powered, multi-tenant life-insurance platform built for Pakistani insurers. It covers the full policy journey — lead intake, quotation, pre-underwriting clearance, AI underwriting, issuance, in-force servicing, and claims — on a FastAPI microservice backend with LLMs, a Memgraph fraud graph, and a Kafka event bus.

## What it does

1. **Lead → quote.** An agent (web portal, mobile app, or the AI copilot) adds a customer. A `CustomerCreated` Kafka event triggers the gateway's quote worker, which prices every eligible plan so indicative quotes are ready immediately (`POST /quote` does the same on demand — pure actuarial math, no LLM).
2. **Case + pre-underwriting gates.** An underwriting case collects the evidence a decision needs: the customer's tokenised **E-Application**, the agent's **Confidential Report (ACR)**, **PEP/sanctions compliance**, **Initial Premium Payment**, an **insurance-history** check and, above the non-medical limit, a **medical exam** booked at a panel clinic. The deterministic **Requirements Engine** keeps the case in `Pending Documents` until mandatory requirements are satisfied or waived.
3. **AI underwriting.** The **Risk Engine** runs a LangGraph workflow that scores medical, financial, and fraud risk in parallel (LLM + deterministic floors/ceilings + Memgraph ring queries), then a rule-based `decision_engine` picks the verdict: `Auto Approve`, `Approve with Loading`, `Human Review`, `Request Additional Evidence`, `Fraud Investigation`, `Postpone`, or `Decline`.
4. **Post-underwriting → issuance.** Counter-offers, facultative reinsurance referral, compliance, beneficiaries and policy documents gate issuance; every policy status change goes through a single state machine with an immutable `PolicyEvent` audit trail.
5. **In-force life.** Free-look, onboarding/welcome kit, premium schedules and reminders, endorsements, renewals, and claims (FNOL → adjudication → payout → reinsurance recovery).

## Local URLs

| Service | URL / host port | Notes |
|---|---|---|
| Frontend (Next.js) | http://localhost:3000 | Operations / admin portal |
| **Docs (this site)** | http://localhost:4991/insurance-ai/ | Docusaurus |
| API Gateway | http://localhost:8010 — Swagger at `/docs` | Single public entry point |
| Tenant Service | 8011 | Tenants, users, cases, policies, claims, rules |
| Risk Engine | 8012 | LangGraph underwriting |
| Decision Engine | 8013 | Stub (health check only) |
| OCR Engine | 8014 | Document extraction |
| Text Summarizer | 8015 | Summaries and underwriter notes |
| Chat Agent | 8016 | AI copilot (LangGraph) |
| Kafka UI | http://localhost:8090 | Topic browser |
| Memgraph Lab | http://localhost:3001 | Graph browser (Bolt on 7688) |
| Kafka | 9092 (internal) / 9094 (host) | KRaft, single broker |
| PostgreSQL | *(external)* | Point `DATABASE_URL` at your own instance |

## Quick start

```bash
# 1. Copy the env template and fill in DATABASE_URL, JWT_SECRET_KEY,
#    CONFIG_ENCRYPTION_KEY and an LLM key (see below)
cp .env.example .env

# 2. Start everything
docker compose up --build -d

# 3. Bootstrap a SuperAdmin (creates the "Platform" tenant + SuperAdmin user,
#    emails the generated credentials)
docker compose exec tenant-service python create_superadmin.py --email you@yourdomain.com

# 4. Sign in at http://localhost:3000, then:
#    • Platform → LLM Configuration — set the primary/fallback model + API key
#    • Super Admin → Tenants — create a tenant (name + unique code)
#    • Super Admin → Admins — bootstrap the tenant's first Admin
```

**PostgreSQL is external.** It is not a docker-compose service — run your own instance, create an empty database, and point `DATABASE_URL` at it. Tables and additive migrations are applied on service startup (`services/tenant-service/migrate.py`). From Docker Desktop, a host-installed Postgres is reachable at `host.docker.internal`.

**LLM keys.** Provider keys are normally configured in the UI (**Platform → LLM Configuration**) and stored Fernet-encrypted; env vars are only the fallback. See [LLM Providers & Token Usage](/llm-providers).

### Try an evaluation from the command line

```bash
# Streams one SSE event per LangGraph node, then persists the RiskAssessment.
# Optional "case_id" runs the requirements/evidence gate first (see Data Flow).
# (POST /evaluate is the async Kafka variant — it returns 202 immediately.)
curl -N -X POST http://localhost:8010/evaluate/stream \
  -H "X-Tenant-Id: <tenant_id>" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "cnic": "3520112345671", "name": "Muhammad Ali Khan", "dob": "1985-06-15",
      "gender": "Male", "occupation": "Software Engineer", "declared_income": 1200000
    },
    "policy": {
      "product_name": "Term Life 20", "insurance_type": "TERM_LIFE",
      "coverage_amount": 5000000, "term_years": 20
    }
  }'
```

## Where to go next

- [Architecture](/architecture) — services, workers, and how they talk
- [Services Reference](/services) — every endpoint, grouped by domain
- [Underwriting & Policy Lifecycle](/policy-lifecycle) — pre-underwriting gates through claims
- [Data Flow](/data-flow) — evaluation paths, Kafka events, LangGraph internals
- [AI Copilot](/chat-agent) — the conversational agent and its permission gate
- [Contributing](/contributing) — branch and commit conventions
