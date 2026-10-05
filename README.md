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
