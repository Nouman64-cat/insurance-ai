# Insurance AI

A multi-tenant, AI-assisted insurance platform covering customer acquisition, underwriting, policy servicing, claims, commissions, document intelligence, and agent workflows.

The platform combines deterministic insurance rules with LLM-assisted analysis, event-driven processing, and graph-based fraud intelligence.

## Features

- **AI-assisted underwriting** with medical, financial, fraud, and document evidence
- **Deterministic decision engine** for approve, loading, review, postpone, decline, and fraud investigation outcomes
- **Requirements engine** that determines required medical, identity, and financial evidence
- **Document intelligence** for OCR, visual analysis, verification, and summarization
- **Multi-provider LLM runtime** with configurable primary/fallback models
- **Fraud intelligence** backed by Memgraph
- **Event-driven workflows** using Kafka
- **AI copilot / chat agent** built with LangGraph
- **Multi-tenant administration** with JWT-based authentication and role-aware workflows
- **Agent mobile application** for leads, proposals, e-applications, underwriting, policies, commissions, and AI assistance
- **Policy, claims, commission, and post-issuance workflows**

## Architecture

```text
                        ┌─────────────────────┐
                        │   Next.js Web App   │
                        │ React Native Agent  │
                        └──────────┬──────────┘
                                   │
                                   ▼
                         ┌──────────────────┐
                         │   API Gateway    │
                         │      :8010       │
                         └────────┬─────────┘
                                  │
              ┌───────────────────┼────────────────────┐
              │                   │                    │
              ▼                   ▼                    ▼
      Tenant Service         Risk Engine          Chat Agent
          :8011                 :8012                :8016
              │                   │                    │
              │             LangGraph                 │
              │                   │               LangGraph
              │                   ▼                    │
              │            LLM Runtime ◄───────────────┘
              │             │    │    │
              │          Gemini OpenAI Anthropic
              │
      ┌───────┴────────┐
      │                │
      ▼                ▼
 PostgreSQL           Kafka
 System of Record   Event Backbone
                       │
                ┌──────┴──────┐
                ▼             ▼
           OCR Engine    Async Underwriting
             :8014
                │
                ▼
       Text Summarizer
             :8015

Risk Engine ───────────────► Memgraph
                             Fraud Graph
```

### Underwriting flow

```text
Case / Proposal
      │
      ▼
Requirements Engine
      │
      ├── missing evidence → Pending Documents
      │
      ▼
Evidence Bundle
      │
      ▼
Normalized Underwriting Profile
      │
      ├── Medical Assessment
      ├── Financial Assessment
      └── Fraud Assessment
             │
             ▼
      Deterministic Rules
             │
             ▼
      Underwriting Decision
```

LLMs assist with extraction, interpretation, and structured risk assessment. Final underwriting branching is governed by deterministic rules in `shared/underwriting/`.

## LLM Providers

The platform supports:

- Google Gemini
- OpenAI
- Anthropic

A SuperAdmin can configure the **primary** and **fallback** provider from:

```text
Platform → LLM Configuration
```

Configuration is shared by the Chat Agent, Risk Engine, OCR Engine, and Text Summarizer.

Provider credentials are encrypted at rest and services automatically fall back to the configured secondary provider when the primary provider fails.

## Tech Stack

| Layer               | Technology                                  |
| ------------------- | ------------------------------------------- |
| Web                 | Next.js 14, React, TypeScript, Tailwind CSS |
| Mobile              | React Native, Expo                          |
| APIs                | FastAPI, Python                             |
| AI orchestration    | LangGraph, LangChain                        |
| LLMs                | Gemini, OpenAI, Anthropic                   |
| Database            | PostgreSQL                                  |
| Event streaming     | Apache Kafka                                |
| Fraud graph         | Memgraph                                    |
| Object storage      | AWS S3                                      |
| Authentication      | JWT                                         |
| Documentation       | Docusaurus                                  |
| Local orchestration | Docker Compose                              |

## Repository Structure

```text
insurance-ai/
├── frontend/                 # Next.js operations/admin portal
├── automation-chat/          # Next.js Automation Chat (AI copilot) app, own container, :3004 (opt-in)
├── marketing-site/           # Next.js public marketing site (demo content, :3002)
├── agent-app/                # React Native / Expo agent application
├── services/
│   ├── api-gateway/
│   ├── tenant-service/
│   ├── risk-engine/
│   ├── chat-agent/
│   ├── ocr-engine/
│   ├── text-summarizer/
│   └── decision-engine/
├── shared/
│   ├── models/
│   ├── events/
│   ├── services/
│   └── underwriting/
├── docs/                     # Docusaurus documentation
└── docker-compose.yml
```

## Quick Start

### Prerequisites

- Docker + Docker Compose
- PostgreSQL
- Node.js 18+
- At least one supported LLM provider account

### 1. Configure the environment

```bash
cp .env.example .env
```

At minimum configure:

```env
DATABASE_URL=postgresql+asyncpg://...
JWT_SECRET_KEY=...
CONFIG_ENCRYPTION_KEY=...
```

Generate a Fernet encryption key with:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

AWS S3, SES, OpenSanctions, and provider environment fallbacks are optional depending on the workflow being used.

### 2. Start the platform

```bash
docker compose up --build -d
```

Check services:

```bash
docker compose ps
```

### 3. Create the platform SuperAdmin

```bash
docker compose exec tenant-service \
  python create_superadmin.py --email you@example.com
```

Login at:

```text
http://localhost:3000
```

Then configure the primary/fallback LLM providers under **Platform → LLM Configuration**.

## Automation Chat

The AI copilot runs as its own app and container, separate from the web portal (`automation-chat/`, port **3004**).
It is **opt-in**: `docker compose up` does not start it. Start it when you want it:

```bash
docker compose up -d automation-chat   # start (builds on first run)
docker compose stop automation-chat    # stop
```

Then use the **Automation** button in the portal's top bar. It opens the chat in a new tab, or tells you the
container is not running. You can also open http://localhost:3004 directly.

**Single sign-on.** Nothing to type: signing in to the portal also sets an httpOnly session cookie (`insurance_sso`).
The chat app reads it, verifies it with the API Gateway and signs the same user in. If you are not signed in to the
portal you are sent to its login page and brought back. Signing out of the portal signs out of the chat as well.

| Setting                  | Where                | Purpose                                                             |
| ------------------------ | -------------------- | ------------------------------------------------------------------- |
| `NEXT_PUBLIC_AUTOMATION_URL` | portal (`frontend`) | Address the **Automation** button opens (default `http://localhost:3004`) |
| `NEXT_PUBLIC_PORTAL_URL` | `automation-chat`    | The portal: pages the chat embeds and the sign-in redirect (default `http://localhost:3000`) |
| `SSO_COOKIE_NAME`        | both                 | Cookie name, must match (default `insurance_sso`)                   |
| `SSO_COOKIE_DOMAIN`      | both                 | Leave empty on localhost. Set a shared parent domain (`.example.com`) when the apps are on different subdomains |
| `SSO_COOKIE_SECURE`      | both                 | `true` behind HTTPS                                                 |

The chat uses the same API Gateway and Chat Agent as before; it needs the rest of the stack running. Details:
[`automation-chat/README.md`](automation-chat/README.md).

## Agent Mobile App

The agent application runs separately through Expo:

```bash
cd agent-app
npm install
npm start
```

Set the gateway URL when required:

```env
EXPO_PUBLIC_API_URL=http://<your-host>:8010
```

A physical device must use an address reachable from the device rather than `localhost`.

## Local Services

| Service         |            URL / Port |
| --------------- | --------------------: |
| Web Portal      | http://localhost:3000 |
| Automation Chat | http://localhost:3004 (opt-in, see above) |
| API Gateway     | http://localhost:8010 |
| Tenant Service  | http://localhost:8011 |
| Risk Engine     | http://localhost:8012 |
| Decision Engine | http://localhost:8013 |
| OCR Engine      | http://localhost:8014 |
| Text Summarizer | http://localhost:8015 |
| Chat Agent      | http://localhost:8016 |
| Documentation   | http://localhost:4991 |
| Kafka UI        | http://localhost:8090 |
| Memgraph Lab    | http://localhost:3001 |
| Kafka           |           9092 / 9094 |
| Memgraph Bolt   |                  7688 |

PostgreSQL is external and configured through `DATABASE_URL`.

## Development

Branch names follow:

```text
<type>/<short-description>
```

Commit messages follow Conventional Commits:

```text
<type>(<scope>): <description>
```

Examples:

```text
feat(underwriting): add financial verification rules
fix(agent): handle expired session
docs(readme): update architecture overview
```

Useful commands:

```bash
npm run lint:branch
docker compose logs -f risk-engine
docker compose logs -f api-gateway
docker compose down
```

## Documentation

Detailed architecture, service APIs, data flows, database schemas, underwriting rules, and implementation notes live in `docs/`.

Run the documentation locally with:

```bash
cd docs
npm install
npm start
```

Then open:

```text
http://localhost:4991
```

## Development Status

Insurance AI is under active development. The `dev` branch contains the latest platform work and may include experimental or incomplete workflows.

The underwriting rules currently included in the repository are engineering/demo rules and must undergo actuarial, compliance, security, and regulatory validation before production insurance use.
