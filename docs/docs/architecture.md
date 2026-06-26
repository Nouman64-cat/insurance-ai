---
id: architecture
title: Architecture
sidebar_position: 2
---

# Architecture

## System diagram

```mermaid
graph TB
    subgraph Clients
        B[Browser]
        RC[REST Client]
    end

    subgraph "Frontend :3000"
        FE["Next.js App Router"]
    end

    subgraph "API Layer :8010"
        GW["API Gateway\nFastAPI + httpx proxy"]
    end

    subgraph "Backend Services"
        TS["Tenant Service :8011\nFastAPI · JWT Auth · RBAC"]
        RE["Risk Engine :8012\nFastAPI · LangGraph · Gemini"]
        DE["Decision Engine :8013\nFastAPI (WIP)"]
        OCR["OCR Engine :8014\nFastAPI · Gemini 2.5 Flash"]
        SUMM["Text Summarizer :8015\nFastAPI · Gemini 2.5 Flash"]
    end

    subgraph "Data Layer"
        PG[("PostgreSQL 16\n:5434")]
        MG[("Memgraph\n:7688 Bolt")]
        KF[["Apache Kafka KRaft\n:9092 internal\n:9094 external"]]
        KUI["Kafka UI :8090"]
    end

    B --> FE
    RC --> GW
    FE --> GW
    GW -->|proxy /auth /users /roles| TS
    GW -->|POST /evaluate| RE
    GW -->|INSERT applicant + policy + assessment| PG
    GW -->|ProposalSubmittedEvent| KF
    TS --> PG
    RE -->|Cypher ring query| MG
    RE -->|RiskEvaluatedEvent| KF
    KF -->|consumer| RE
    KUI --> KF
```

All containers share a single Docker bridge network `insurance-net`. Named volumes (`postgres-data`, `memgraph-data`, `kafka-data`) persist data across container restarts.

## Multi-tenancy

Every table in PostgreSQL carries a `tenant_id` foreign key that scopes all reads and writes to a single insurance company. The Tenant Service issues tenants and JWT tokens; the API Gateway forwards `Authorization: Bearer <token>` to downstream services.

## Service responsibilities

| Service | Responsibility |
|---|---|
| **API Gateway** | Single public entrypoint. Routes `/auth`, `/users`, `/roles` to Tenant Service via httpx proxy. Calls Risk Engine directly for `/evaluate`. Owns the PostgreSQL writes for applicant, policy, and risk_assessment rows. |
| **Tenant Service** | Manages `tenants`, `users`, and `roles` tables. Issues and validates JWT tokens. Seeds four RBAC roles on startup: `Admin`, `Underwriter`, `Agent`, `Viewer`. |
| **Risk Engine** | Runs the LangGraph underwriting workflow (medical scoring → financial scoring → fraud detection → decision aggregation). Reads/writes the Memgraph fraud graph. Publishes `RiskEvaluatedEvent` to Kafka. |
| **OCR Engine** | Accepts PDF/image file uploads and extracts structured text using Gemini 2.5 Flash multimodal. Supports streaming via SSE. |
| **Text Summarizer** | Receives OCR-extracted text (one or more documents) and generates structured Markdown summaries via Gemini 2.5 Flash. |
| **Decision Engine** | Placeholder — will house deterministic rule execution and audit logging. |

## Authentication flow

```mermaid
sequenceDiagram
    participant C as Client
    participant GW as API Gateway :8010
    participant TS as Tenant Service :8011
    participant PG as PostgreSQL

    C->>GW: POST /auth/token (form: username+password)
    GW->>TS: proxy → POST /auth/token
    TS->>PG: SELECT user WHERE email=username
    PG-->>TS: user row + hashed_password
    TS->>TS: bcrypt.verify(password, hashed_password)
    TS-->>GW: { access_token, token_type }
    GW-->>C: { access_token, token_type }

    C->>GW: GET /auth/me (Bearer token)
    GW->>TS: proxy → GET /auth/me
    TS->>TS: decode JWT, fetch role
    TS-->>GW: CurrentUserResponse
    GW-->>C: CurrentUserResponse
```
