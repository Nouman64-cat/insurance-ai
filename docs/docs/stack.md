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
| Server | Uvicorn | ASGI server with `--reload` in dev |

## AI / ML

| Component | Technology | Notes |
|---|---|---|
| LLM | Google Gemini 2.5 Flash | `gemini-2.5-flash` via `langchain-google-genai` |
| Workflow orchestration | [LangGraph](https://langchain-ai.github.io/langgraph/) | Stateful DAG for the risk pipeline |
| Structured output | LangChain `.with_structured_output()` | Pydantic schemas as LLM output contracts |
| Fraud graph queries | Neo4j Python driver | Targeting Memgraph's Bolt-compatible API |

## Databases

| Database | Use case | Port |
|---|---|---|
| **PostgreSQL** | Relational store — all business entities (tenants, users, customers, policies, assessments, claims, artifacts, commissions). **External** — not a docker-compose container; point `DATABASE_URL` at your own instance. | *(external)* |
| **Memgraph** | Graph store — customer fraud ring detection. Nodes: `Customer`, `Policy`. Edges: `APPLIED_FOR`. | 7688 (Bolt) / 7445 (Lab UI) |

## Messaging

| Technology | Mode | Notes |
|---|---|---|
| Apache Kafka | KRaft (no Zookeeper) | Single broker, auto topic creation enabled |
| `aiokafka` | Producer | API Gateway publishes `ProposalSubmittedEvent` |
| `aiokafka` | Consumer | Risk Engine consumes and publishes `RiskEvaluatedEvent` |

### Kafka topics

| Topic | Schema | Direction |
|---|---|---|
| `insurance.proposal.submitted.v1` | `ProposalSubmittedEvent` | Gateway → Risk Engine |
| `insurance.risk.evaluated.v1` | `RiskEvaluatedEvent` | Risk Engine → downstream |

Both event envelopes are defined in `shared/events/kafka_events.py` and imported by both producer and consumer to prevent on-wire contract drift.

## Frontend

| Technology | Notes |
|---|---|
| Next.js 14+ (App Router) | Underwriter UI |
| TypeScript | Strict mode |
| Tailwind CSS | Styling |
| Axios / Fetch | API calls to `http://localhost:8010` |

## Infrastructure

| Technology | Notes |
|---|---|
| Docker Compose | All services, databases, and tooling |
| Docker bridge network `insurance-net` | Single shared network for inter-service DNS |
| Named volumes | `postgres-data`, `memgraph-data`, `kafka-data` — data survives restarts |
| `WATCHFILES_FORCE_POLLING=true` | Enables Uvicorn `--reload` on macOS Docker Desktop (inotify workaround) |
| `CHOKIDAR_USEPOLLING=true` | Same workaround for Next.js HMR |

## Risk scoring & decision rules

`decision_engine` (no LLM) picks the final decision from a rule chain over three
**independent** results — medical/financial/fraud — not a weighted sum. A composite score is
still computed for the dashboard only:

```
composite = (0.40 × medical_score) + (0.40 × financial_score) + (0.20 × fraud_probability × 100)
```

Decision rules (`shared/underwriting/decision_rules.py`), evaluated in order — first match wins:

| Condition | Decision |
|---|---|
| mandatory requirements unmet | `Request Additional Evidence` |
| fraud severity High/Critical | `Fraud Investigation` |
| medical classification Decline | `Decline` |
| medical classification Postpone | `Postpone` |
| financial not justified | `Decline` or `Human Review` |
| medical Substandard/Rated | `Approve with Loading` |
| unresolved discrepancies / referral flags | `Human Review` |
| everything clears | `Auto Approve` |

Because it's a sequential chain, a severe medical or fraud result can't be averaged away by
good scores elsewhere — see `shared/underwriting/decision_rules.py` for the exact logic.
