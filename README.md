# insurance-ai

A **multi-tenant SaaS** platform for AI-driven insurance underwriting, risk assessment, and decision automation, built on a Python microservices architecture.

---

## Architecture Overview

```
                          ┌─────────────────────────────┐
                          │       Browser / Client       │
                          └──────────────┬──────────────┘
                                         │ :3000
                          ┌──────────────▼──────────────┐
                          │     Frontend (Next.js)       │
                          └──────────────┬──────────────┘
                                         │ REST
                          ┌──────────────▼──────────────┐
                          │    API Gateway  :8000        │  ← single entry point,
                          │      (FastAPI)               │    auth, rate-limiting,
                          └──┬──────────┬──────────┬────┘    request routing
                             │          │          │
              ┌──────────────▼──┐  ┌───▼──────┐  ┌▼──────────────┐
              │ Tenant Service  │  │ Risk     │  │ Decision      │
              │    :8001        │  │ Engine   │  │ Engine        │
              │  (FastAPI)      │  │ :8002    │  │ :8003         │
              │                 │  │(FastAPI) │  │ (FastAPI)     │
              └────────┬────────┘  └────┬─────┘  └──────┬────────┘
                       │               │                 │
          ┌────────────▼───────────────▼─────────────────▼────────┐
          │                     Shared Infrastructure              │
          │   ┌─────────────────────┐   ┌────────────────────┐    │
          │   │  PostgreSQL :5432   │   │  Memgraph  :7687   │    │
          │   │  (Relational data,  │   │  (Graph DB —       │    │
          │   │   multi-tenant      │   │   fraud detection, │    │
          │   │   row isolation)    │   │   entity linking)  │    │
          │   └─────────────────────┘   └────────────────────┘    │
          └────────────────────────────────────────────────────────┘
```

### Services

| Service | Port | Responsibility |
|---|---|---|
| **frontend** | 3000 | Next.js UI (placeholder — scaffold with `create-next-app`) |
| **api-gateway** | 8000 | Single public entry point. Auth, rate-limiting, proxying to downstream services. |
| **tenant-service** | 8001 | Tenant CRUD, onboarding, plan management, multi-tenant isolation enforcement. |
| **risk-engine** | 8002 | Actuarial risk scoring, ML model inference, integration with Memgraph for graph-based fraud signals. |
| **decision-engine** | 8003 | Policy decisioning (approve / refer / decline), rules engine, audit log. |

### Databases

| Database | Port | Purpose |
|---|---|---|
| **PostgreSQL 16** | 5432 | Primary relational store. Row-level tenant isolation via `tenant_id` columns. |
| **Memgraph** | 7687 | Property graph database for entity relationship analysis and fraud detection. Lab UI on `:3001`. |

---

## Getting Started

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) >= 4.x
- [Docker Compose](https://docs.docker.com/compose/) >= 2.x (bundled with Docker Desktop)

### 1. Configure environment variables

```bash
cp .env.example .env
# Edit .env and set strong passwords before running in any shared environment.
```

### 2. Start all services

```bash
docker compose up --build
```

> On first run, Docker will pull base images and build all service containers. This takes ~2–3 minutes. Subsequent starts are fast.

### 3. Verify health checks

```bash
curl http://localhost:8000/health   # API Gateway
curl http://localhost:8001/health   # Tenant Service
curl http://localhost:8002/health   # Risk Engine
curl http://localhost:8003/health   # Decision Engine
```

All should return `{"service": "<name>", "status": "healthy"}`.

### 4. Explore interactive API docs

Each FastAPI service exposes auto-generated Swagger UI:

| Service | Swagger URL |
|---|---|
| API Gateway | http://localhost:8000/docs |
| Tenant Service | http://localhost:8001/docs |
| Risk Engine | http://localhost:8002/docs |
| Decision Engine | http://localhost:8003/docs |

### 5. Memgraph Lab (Graph UI)

Open http://localhost:3001 to connect to the Memgraph instance and run Cypher queries.

---

## Project Structure

```
insurance-ai/
├── frontend/                   # Next.js app (scaffold with create-next-app)
│   └── Dockerfile
├── services/
│   ├── api-gateway/            # Public entry point
│   │   ├── main.py
│   │   ├── requirements.txt
│   │   └── Dockerfile
│   ├── tenant-service/         # Multi-tenancy management
│   │   ├── main.py
│   │   ├── requirements.txt
│   │   └── Dockerfile
│   ├── risk-engine/            # Risk scoring + graph fraud signals
│   │   ├── main.py
│   │   ├── requirements.txt
│   │   └── Dockerfile
│   └── decision-engine/        # Policy decisioning + rules
│       ├── main.py
│       ├── requirements.txt
│       └── Dockerfile
├── shared/
│   ├── db/
│   │   └── init.sql            # PostgreSQL bootstrap (runs once on first start)
│   ├── models/                 # Shared Pydantic / SQLAlchemy models
│   └── events/                 # Shared event schemas (AsyncAPI / CloudEvents)
├── infrastructure/             # Terraform / Helm / K8s manifests (to be added)
├── docker-compose.yml
├── .env.example
└── .gitignore
```

---

## Development Workflow

```bash
# Start only the databases (useful when running services locally with uvicorn)
docker compose up postgres memgraph

# Rebuild a single service after code changes
docker compose up --build risk-engine

# Tail logs for a specific service
docker compose logs -f decision-engine

# Stop and remove all containers (data volumes are preserved)
docker compose down

# Destroy everything including volumes (resets databases)
docker compose down -v
```

---

## Multi-Tenancy Design

All relational tables carry a `tenant_id UUID` foreign key referencing `tenants.id`. The **tenant-service** is the source of truth for tenant identity. The **api-gateway** extracts the tenant context from the JWT / API key on every inbound request and propagates it downstream via an `X-Tenant-Id` header.

Memgraph tenant isolation is enforced at the application layer by scoping all Cypher queries with a `tenantId` node property filter.

---

## Roadmap

- [ ] Scaffold Next.js frontend (`npx create-next-app@latest frontend`)
- [ ] Add Alembic for PostgreSQL schema migrations
- [ ] Wire JWT authentication into api-gateway
- [ ] Implement tenant-aware database session middleware
- [ ] Add Kafka / Redpanda for async event streaming between services
- [ ] Add Prometheus + Grafana observability stack to `infrastructure/`
- [ ] Kubernetes manifests (Helm charts) in `infrastructure/`
