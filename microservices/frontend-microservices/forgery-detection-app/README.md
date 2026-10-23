# Forgery Detection App

Public Next.js frontend for the `docs-forgery` backend. No login, SSO cookie, or tenant is
required. This is an unauthenticated testing interface, available at
[http://localhost:3012](http://localhost:3012).

## Run with Docker Compose

From the repository root:

```sh
docker compose build docs-forgery forgery-detection-app
docker compose up -d docs-forgery forgery-detection-app
```

Compose starts the `docs-forgery` backend dependency and waits for its health check.
The frontend listens on port 3012 on the host's network interfaces, so it can also be
accessed at `http://<host-ip>:3012` where the host firewall permits. This does not provision
an internet domain or tunnel. The backend remains loopback-bound on host port 8032.

## Using the UI

1. Drop or select a PDF or supported image, up to 100 MiB, and choose a document type.
2. File and metadata checks always run. Optionally enable content consistency checks
   or experimental pixel forensics.
3. For content checks, choose Gemini or Groq and explicitly agree to send document pages
   to the provider. API keys belong in the repository-root `.env` used by the backend;
   they are never configured in browser code. Recreate the backend after changing its keys.
4. Select **Analyze document**. Review the verdict, layer statuses, errors, and findings.
   Expand evidence, include informational findings, or download the complete JSON report.

Pixel forensics uses the CPU-only PyTorch runtime and official TruFor weights bundled in
the backend Docker image. The first backend build downloads these dependencies. Enable
**Pixel forensics** and run analysis to see per-page model scores and anomaly heatmaps.
Without a validated document calibration file, these are explicitly uncalibrated outputs
and do not determine the verdict. Partial or failed inference is reported as incomplete.
The upstream model is licensed for informational and nonprofit use only.
The page limit applies to Layers 2 and 3. Layer 1 retains the backend's own limit.

The app provides upload validation, an image preview where the browser supports it,
loading and cancellation states, and backend error messages. Cancelling stops the browser
request; an analysis already running on the backend may continue. Results stay in page
memory and clear when another document is selected or the page reloads. The app does not
persist documents or reports. The backend/framework may spool multipart files temporarily.
`no_evidence` does not establish authenticity; findings require human review.

## Configuration and HTTP routes

| Setting / route | Purpose |
|---|---|
| `DOCS_FORGERY_URL` | Server-only backend base URL. Defaults to `http://localhost:8032` for local development; Compose sets `http://docs-forgery:8022`. |
| `POST /api/analyze` | Streams multipart uploads to the backend `/analyze` route; preserves its response status and JSON report. Ten-minute upstream timeout. |
| `GET /api/health` | Checks backend connectivity; returns 200 when healthy and 503 when unavailable. |

Requests use the frontend's origin. No browser CORS changes, direct backend URL, or API
Gateway session is needed. Public access also applies to the analysis proxy; any visitor
can invoke the enabled checks using the backend's configured providers.

## Local development

Start the backend on port 8032, then from this directory:

```sh
npm install
npm run dev
```

To use another backend:

```sh
DOCS_FORGERY_URL=http://localhost:8022 npm run dev
```

Validation and production build:

```sh
npm run typecheck
npm run build
npm start
```

The Dockerfile has `dev` and `runner` targets. Compose uses `dev` with source mounts and
polling. Build `runner` for a standalone production image; set `DOCS_FORGERY_URL` at runtime.

## Build and run standalone production images

Run from the repository root. Use this instead of the Compose development setup. If the
Compose containers are running, release their ports first:

```sh
docker compose stop docs-forgery forgery-detection-app

docker build -t insurance-docs-forgery:latest ./microservices/backend-microservices/docs-forgery
docker build --target runner -t insurance-forgery-detection-app:latest ./microservices/frontend-microservices/forgery-detection-app

docker network create forgery-net

docker run -d --name docs-forgery --network forgery-net \
  --env-file .env -p 127.0.0.1:8032:8022 \
  insurance-docs-forgery:latest

docker run -d --name forgery-detection-app --network forgery-net \
  -e DOCS_FORGERY_URL=http://docs-forgery:8022 \
  -p 3012:3012 insurance-forgery-detection-app:latest
```

Open [http://localhost:3012](http://localhost:3012). Create `forgery-net` only once.
For subsequent runs, start the existing containers with
`docker start docs-forgery forgery-detection-app`; rebuild and recreate them when source changes.
The backend uses FastAPI only, and the frontend uses Next.js; no Streamlit installation is needed.
