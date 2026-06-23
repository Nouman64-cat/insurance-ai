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
| PostgreSQL | 5434 | Relational store |
| Memgraph (Bolt) | 7688 | Graph store |

## Quick start

```bash
# 1. Copy env template and fill in GEMINI_API_KEY
cp .env.example .env

# 2. Start all services
docker compose up --build

# 3. Create a tenant (required before calling /evaluate)
curl -X POST "http://localhost:8010/tenants?name=acme-insurance"

# 4. Submit a proposal (sync evaluate)
curl -X POST http://localhost:8010/evaluate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: <tenant_id>" \
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
      "coverage_amount": 5000000,
      "term_years": 20
    }
  }'
```

Swagger UI is available at `http://localhost:8010/docs`.
