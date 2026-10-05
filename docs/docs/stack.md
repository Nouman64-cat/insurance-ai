---
id: stack
title: Tech Stack
sidebar_position: 3
---

# Tech Stack

## Backend

| Layer | Technology | Notes |
|---|---|---|
| Language | Python 3.11+ | All microservices |
| Web framework | [FastAPI](https://fastapi.tiangolo.com/) | Async, auto OpenAPI |
| ORM | [SQLModel](https://sqlmodel.tiangolo.com/) | Wraps SQLAlchemy + Pydantic |
| DB driver | `asyncpg` | Async PostgreSQL |
| HTTP client | `httpx` | Async proxy calls in the gateway |
| Auth | `python-jose` + `passlib[bcrypt]` | JWT tokens, bcrypt password hashing |
| Secrets at rest | `cryptography` (Fernet) | Encrypts stored LLM API keys (`CONFIG_ENCRYPTION_KEY`) |
| Server | Uvicorn | ASGI server with `--reload` in dev |

## AI / ML

| Component | Technology | Notes |
|---|---|---|
| LLM providers | Gemini, OpenAI, Anthropic | Primary + fallback chosen by a SuperAdmin at runtime — default `gemini-2.5-flash`. See [LLM Providers](/llm-providers) |
| LLM clients | `langchain-google-genai`, `langchain-openai`, `langchain-anthropic` | Resolved per call from `GET /internal/llm-config` (cached ~60 s, env-var fallback) |
| Workflow orchestration | [LangGraph](https://langchain-ai.github.io/langgraph/) | Risk Engine underwriting DAG; Chat Agent tool loop with `interrupt()` |
| Structured output | LangChain `.with_structured_output()` | Pydantic schemas as LLM output contracts |
| Fraud graph queries | Neo4j Python driver | Against Memgraph's Bolt-compatible API |
| Deterministic engines | `shared/underwriting/*`, `shared/pricing/calculator.py` | Requirements, verification, decision chain, pricing — no LLM |

## Databases

| Database | Use case | Port |
|---|---|---|
| **PostgreSQL** | Relational store — all business entities (tenants, users, customers, cases, policies, assessments, claims, artifacts, rules, LLM config, token usage). Schema in `shared/models/core.py`; additive migrations in `services/tenant-service/migrate.py`. **External** — not a docker-compose container; point `DATABASE_URL` at your own instance. | *(external)* |
| **Memgraph** | Graph store — fraud ring detection over `Customer` nodes linked by `SAME_AREA` / `SAME_OCCUPATION_CLUSTER` (see [Fraud Layer](/fraud-layer)). | 7688 (Bolt) / 7445 (Lab UI) |

## Messaging

| Technology | Notes |
|---|---|
| Apache Kafka (KRaft, no Zookeeper) | Single broker, auto topic creation; `9092` internal, `9094` for host tools |
| `aiokafka` | Producers and consumers in api-gateway, tenant-service, risk-engine |

Six topics carry proposals, risk results, customer creation, OCR jobs, case events and policy lifecycle events — see the [Kafka topics table](/data-flow#kafka-topics). Envelopes are defined once in `shared/events/kafka_events.py`.

## Frontend

| App | Technology | Notes |
|---|---|---|
| Web portal (`frontend/`) | Next.js 14.2 (App Router), React 18, TypeScript, Tailwind CSS 3 | Operations / admin / super-admin portal on `:3000` |
| Agent app (`agent-app/`) | Expo 54, React Native 0.81 | Field-agent mobile app — see [Client Apps](/client-apps) |
| Docs (`docs/`) | Docusaurus 3 + Mermaid | This site, `:4991` |

## Infrastructure

| Technology | Notes |
|---|---|
| Docker Compose | All services, Kafka, Memgraph, tooling and the docs site (PostgreSQL is external) |
| AWS S3 | Artifact and policy-document storage |
| AWS SES | Credential and notification email (`EMAIL_PROVIDER`) |
| Docker bridge network `insurance-net` | Single shared network for inter-service DNS |
| Named volumes | `memgraph-data`, `kafka-data` — data survives restarts (PostgreSQL is external) |
| `WATCHFILES_FORCE_POLLING=true` | Enables Uvicorn `--reload` on macOS Docker Desktop (inotify workaround) |
| `CHOKIDAR_USEPOLLING=true` | Same workaround for Next.js HMR |

## Risk scoring & decision rules

The final decision is a **sequential rule chain** over three independent structured results (medical, financial, fraud) in `shared/underwriting/decision_rules.py` — not a weighted sum. A composite score (`0.40×medical + 0.40×financial + 0.20×fraud×100`) is still computed for the dashboard but never branched on. The full ordered chain is on the [Data Flow page](/data-flow#decision-rules-decision_engine).
