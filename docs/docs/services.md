---
id: services
title: Services Reference
sidebar_position: 7
---

# Services Reference

## API Gateway

**Port:** 8010 (host) / 8000 (container)  
**Source:** `services/api-gateway/`  
**Swagger:** `http://localhost:8010/docs`

Single public entrypoint for all clients. Owns the PostgreSQL writes for the evaluation path and proxies auth/user/role requests to the Tenant Service.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/evaluate` | Synchronous risk evaluation — calls Risk Engine and persists results |
| `POST` | `/auth/token` | Login → JWT (proxied to Tenant Service) |
| `GET` | `/auth/me` | Current user info (proxied) |
| `POST` | `/tenants` | Bootstrap: create a tenant |
| `GET` | `/tenants` | Bootstrap: list all tenants |
| `GET` | `/tenants/{tenant_id}` | Bootstrap: get a tenant |
| `POST` | `/tenants/{tenant_id}/users` | Create a user (Bearer required) |
| `GET` | `/tenants/{tenant_id}/users/` | List users (admin only, Bearer required) |
| `GET` | `/tenants/{tenant_id}/users/{user_id}` | Get a user (Bearer required) |
| `PATCH` | `/tenants/{tenant_id}/users/{user_id}` | Update a user (admin only, Bearer required) |
| `DELETE` | `/tenants/{tenant_id}/users/{user_id}` | Delete a user (admin only, Bearer required) |
| `POST` | `/tenants/{tenant_id}/applicants` | Create an applicant (admin only, Bearer required) |
| `GET` | `/tenants/{tenant_id}/applicants` | List applicants (admin only, Bearer required) |
| `GET` | `/tenants/{tenant_id}/applicants/{applicant_id}` | Get an applicant (Bearer required) |
| `PUT` | `/tenants/{tenant_id}/applicants/{applicant_id}` | Update an applicant (Bearer required) |
| `DELETE` | `/tenants/{tenant_id}/applicants/{applicant_id}` | Delete an applicant (Bearer required) |
| `GET` | `/roles` | List RBAC roles |
| `GET` | `/health` | Health check |

### Key env vars

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL async connection string |
| `KAFKA_BOOTSTRAP_SERVERS` | `kafka:9092` | Kafka broker address |
| `TENANT_SERVICE_URL` | `http://tenant-service:8001` | Internal Tenant Service URL |

---

## Tenant Service

**Port:** 8011 (host) / 8001 (container)  
**Source:** `services/tenant-service/`  
**Swagger:** `http://localhost:8011/docs`

Manages `tenants`, `users`, `user_profiles`, and `applicants`. Issues JWT tokens (HS256). Seeds RBAC roles at startup.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/token` | Login → `{ access_token, token_type }` |
| `GET` | `/auth/me` | Decode JWT → current user + role |
| `POST` | `/tenants/{tenant_id}/users` | Create user within a tenant |
| `GET` | `/tenants/{tenant_id}/users/` | List users (Admin role required) |
| `GET` | `/tenants/{tenant_id}/users/{user_id}` | Get user |
| `PATCH` | `/tenants/{tenant_id}/users/{user_id}` | Update user |
| `DELETE` | `/tenants/{tenant_id}/users/{user_id}` | Delete user |
| `POST` | `/tenants/{tenant_id}/applicants` | Create applicant (Admin only; enforces per-tenant CNIC uniqueness) |
| `GET` | `/tenants/{tenant_id}/applicants` | List all applicants for a tenant (Admin only) |
| `GET` | `/tenants/{tenant_id}/applicants/{applicant_id}` | Get applicant by ID (Admin only) |
| `PUT` | `/tenants/{tenant_id}/applicants/{applicant_id}` | Full update of an applicant (Admin only) |
| `DELETE` | `/tenants/{tenant_id}/applicants/{applicant_id}` | Delete applicant (Admin only) |
| `GET` | `/roles` | List all roles |
| `GET` | `/health` | Health check |

### RBAC roles

| Role | Access level |
|---|---|
| `Admin` | Full platform access — manage tenants, users, and all resources |
| `Underwriter` | Evaluate proposals, review risk assessments, make decisions |
| `Agent` | Submit proposals, track status |
| `Viewer` | Read-only access to dashboards and reports |

---

## Risk Engine

**Port:** 8012 (host) / 8002 (container)  
**Source:** `services/risk-engine/`  
**Swagger:** `http://localhost:8012/docs`

Runs the LangGraph underwriting workflow. Does **not** write to PostgreSQL — all DB writes are done by the API Gateway after calling this service. **Does** write evaluated applicants to Memgraph (fire-and-forget via `graph_writer.py`) after every successful evaluation on both the sync HTTP and async Kafka paths.

### Endpoints

Both endpoints accept an `X-Tenant-Id` header which is forwarded through the LangGraph workflow and used to scope all Memgraph queries to a single tenant.

| Method | Path | Description |
|---|---|---|
| `POST` | `/evaluate` | Sync evaluation → full `EvaluationResponse` |
| `POST` | `/evaluate/stream` | SSE streaming — emits one event per LangGraph node |
| `GET` | `/health` | Health check (polled by Docker `healthcheck`) |

### Request body

```json
{
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
}
```

### Response body

```json
{
  "is_valid": true,
  "validation_errors": [],
  "medical_score": 35,
  "financial_score": 42,
  "fraud_probability": 0.05,
  "composite_risk_score": 31,
  "ai_decision": "Human Review",
  "suggested_loading": null,
  "reasons": [
    "Age 40 — moderate actuarial risk",
    "Income-to-coverage ratio 4.2x — within acceptable range",
    "No prior fraud flags in graph database",
    "Composite score 31/100 = (40%×35) + (40%×42) + (20%×5) → falls in the 30–75 review band (fraud: 0.05) → decision: 'Human Review'"
  ]
}
```

### Key env vars

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Google AI Studio API key |
| `MEMGRAPH_URI` | `bolt://memgraph:7687` | Memgraph Bolt endpoint |
| `KAFKA_BOOTSTRAP_SERVERS` | `kafka:9092` | Kafka broker (async consumer) |

---

## OCR Engine

**Port:** 8014 (host) / 8004 (container)  
**Source:** `services/ocr-engine/`  
**Swagger:** `http://localhost:8014/docs`

Extracts text from uploaded documents and images using Gemini 2.5 Flash multimodal. Handles both text-heavy documents (forms, PDFs, prescriptions) and visual content (X-rays, MRIs, accident photos).

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/extract` | Upload file → extracted text (batch) |
| `POST` | `/extract/stream` | Upload file → SSE stream of text chunks |
| `POST` | `/extract-from-path` | Process a file from the shared `/data` volume |
| `GET` | `/health` | Health check |

### Supported formats

`PDF`, `PNG`, `JPG`, `JPEG`, `TIFF`, `BMP`

### Response example

```json
{
  "filename": "salary_slip.pdf",
  "extracted_text": "SALARY SLIP\nEmployee: Muhammad Ali Khan\nMonth: May 2026\nBasic Salary: PKR 80,000\n...",
  "token_usage": { "input": 1240, "output": 312, "total": 1552 }
}
```

### Shared volume

The container mounts `./shared/documents` to `/data` so the `/extract-from-path` endpoint can process files placed there without an HTTP upload.

---

## Text Summarizer

**Port:** 8015 (host) / 8005 (container)  
**Source:** `services/text-summarizer/`  
**Swagger:** `http://localhost:8015/docs`

Takes raw OCR-extracted text from one or more documents and returns structured Markdown summaries per document using Gemini 2.5 Flash.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/summarize` | Batch summarization → `{ summary, token_usage }` |
| `POST` | `/summarize/stream` | SSE streaming summarization |
| `GET` | `/health` | Health check |

### Request body

```json
{
  "documents": [
    "SALARY SLIP\nEmployee: Muhammad Ali Khan\nBasic Salary: PKR 80,000...",
    "X-RAY REPORT\nDate: 2026-01-15\nFindings: No acute cardiopulmonary..."
  ],
  "max_words": 200
}
```

Each document gets a distinct structured section in the response with a `### Key Takeaway` sub-section.

---

## Decision Engine

**Port:** 8013 (host) / 8003 (container)  
**Source:** `services/decision-engine/`

Currently a stub with a health check. Intended to host deterministic rule execution, audit logging, and underwriter override workflows.

---

## Kafka UI

**Port:** 8090  
**Image:** `provectuslabs/kafka-ui`

Browse Kafka topics and messages at `http://localhost:8090`. Cluster is pre-configured as `insurance-local` pointing to `kafka:9092`.

---

## Memgraph Lab

**Port:** 3001  
**Image:** `memgraph/memgraph-platform`

Visual graph browser for the fraud graph. Access at `http://localhost:3001`.

See the [DB Schemas — Memgraph section](/db-schemas#memgraph-graph-db) for full node/relationship documentation and example Cypher queries.
