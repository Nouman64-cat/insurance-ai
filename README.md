# insurance-ai — Running the System

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) ≥ 4.x (includes Docker Compose v2)

---

## Port Configuration

The services run on the following host ports to avoid conflicts with other local services:

| Service | Port | Purpose |
|---|---|---|
| Frontend | 3000 | Next.js underwriting dashboard |
| API Gateway | 8010 | Main service entry point |
| Tenant Service | 8011 | Tenant management |
| Risk Engine | 8012 | Risk evaluation engine |
| Decision Engine | 8013 | Decision logic |
| Memgraph Bolt | 7688 | Graph database (bolt protocol) |
| Memgraph Lab | 7445 | Graph database UI |
| Memgraph Lab Web | 3001 | Graph database web UI |
| PostgreSQL | 5434 | Relational database (internal: 5432) |

---

## First Time Setup

**1. Copy the environment file and set your credentials**

```bash
cp .env.example .env
```

Open `.env` and replace the placeholder passwords before running anything.

**2. Build images and start every service**

```bash
docker compose up --build
```

Docker will pull base images, install dependencies, and start all containers. This takes **2–4 minutes** on a cold machine. You will see log output from every service; wait until you see uvicorn and Next.js report they are ready.

**3. Create your first tenant**

The API Gateway starts with an empty database. Before calling the underwriting endpoint you need at least one tenant:

```bash
curl -s -X POST "http://localhost:8010/tenants?name=Acme+Insurance" | python3 -m json.tool
```

Copy the `id` field from the response — you will use it as `X-Tenant-Id` in every subsequent request.

**4. Verify everything is up**

| URL | Expected |
|---|---|
| http://localhost:3000 | Underwriting dashboard (Next.js) |
| http://localhost:8010/health | `{"service":"api-gateway","status":"healthy"}` |
| http://localhost:8012/health | `{"service":"risk-engine","status":"healthy"}` |
| http://localhost:8010/docs | Interactive API docs (Swagger UI) |
| http://localhost:8012/docs | Risk Engine API docs |
| http://localhost:3001 | Memgraph Lab (graph database UI) |
| http://localhost:5434 | PostgreSQL on port 5434 (internal DB) |
| http://localhost:7688 | Memgraph Bolt port |

**5. Run a test evaluation**

```bash
curl -s -X POST http://localhost:8010/evaluate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: <paste-tenant-id-here>" \
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
  }' | python3 -m json.tool
```

---

## After Making Code Changes

### Python service changed (`api-gateway`, `risk-engine`, `tenant-service`, `decision-engine`)

Because the source directories are volume-mounted, **uvicorn's `--reload` flag picks up `.py` file saves automatically** — no restart needed.

If you added a new dependency to `requirements.txt`, rebuild that service's image:

```bash
docker compose up --build api-gateway
# or
docker compose up --build risk-engine
```

### Frontend changed (`frontend/`)

Next.js dev server has hot-reload enabled. Saving any file under `frontend/` refreshes the browser automatically — no action needed.

If you added a new npm package to `package.json`:

```bash
docker compose up --build frontend
```

### Shared models changed (`shared/models/core.py`)

The `shared/` directory is bind-mounted into the `api-gateway` container. Uvicorn will reload automatically. The database schema is managed by SQLModel's `create_all` on startup — new columns require a full reset:

```bash
docker compose down -v          # drops volumes (wipes the database)
docker compose up --build       # recreates everything from scratch
```

### `docker-compose.yml` or `.env` changed

```bash
docker compose down
docker compose up --build
```

---

## Common Commands

```bash
# Start everything (after first-time setup)
docker compose up

# Start only the databases (run services locally for faster iteration)
docker compose up postgres memgraph

# Watch logs for one service
docker compose logs -f risk-engine

# Stop all containers (data is preserved)
docker compose down

# Stop and wipe all data volumes (full reset)
docker compose down -v

# Open a shell inside a running service
docker compose exec api-gateway sh
docker compose exec postgres psql -U insurance insurance
# or connect from host (port 5434 on host maps to 5432 inside container)
# psql -h localhost -p 5434 -U insurance insurance
```

---

## Troubleshooting

### Port conflicts

If you see `address already in use` error, another service is occupying the port:

```bash
# Find which process is using a port (e.g., 8010)
lsof -i :8010

# Stop a docker container if needed
docker stop <container-name>

# Or stop all containers and volumes for a fresh start
docker compose down -v
```

### Database doesn't exist

If you see `database "insurance" does not exist`, the PostgreSQL volume was initialized with old settings:

```bash
docker compose down
docker volume rm insurance-ai_postgres-data
docker compose up --build
```

### Service won't start

Check logs for the specific service:

```bash
docker compose logs -f <service-name>
```

Common issues:
- Missing `.env` file → copy `.env.example` to `.env`
- Database not ready → PostgreSQL takes 10-15 seconds to initialize on cold start
- Port conflicts → see "Port conflicts" section above

