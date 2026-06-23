---
id: data-flow
title: Data Flow
sidebar_position: 5
---

# Data Flow

## Synchronous evaluate (primary path)

The API Gateway calls the Risk Engine directly and waits for the full result before writing to the database and returning to the client. This is the default path for `POST /evaluate`.

```mermaid
sequenceDiagram
    participant C as Client
    participant GW as API Gateway :8010
    participant RE as Risk Engine :8012
    participant MG as Memgraph
    participant LLM as Gemini 2.5 Flash
    participant PG as PostgreSQL

    C->>GW: POST /evaluate { applicant, policy }
    GW->>GW: Validate X-Tenant-Id header

    GW->>RE: POST /evaluate (httpx)

    rect rgb(240, 248, 255)
        note over RE: LangGraph workflow
        RE->>RE: validate_input (deterministic)
        RE->>LLM: medical_scoring prompt
        LLM-->>RE: { medical_score, medical_reasons }
        RE->>LLM: financial_scoring prompt
        LLM-->>RE: { financial_score, financial_reasons }
        RE->>MG: Cypher ring query (cnic, income, occupation, coverage)
        MG-->>RE: ring intelligence (income_ring, occupation_ring, prior flags)
        RE->>LLM: fraud_check prompt + graph context
        LLM-->>RE: { fraud_probability, fraud_reasons }
        RE->>RE: decision_aggregation (deterministic)<br/>composite = 0.40×medical + 0.40×financial + 0.20×fraud×100
    end

    RE-->>GW: EvaluationResponse

    GW->>PG: UPSERT applicant (by cnic + tenant_id)
    GW->>PG: INSERT policy
    GW->>PG: INSERT risk_assessment
    PG-->>GW: assessment_id, applicant_id, policy_id

    GW-->>C: EvaluateResponse { scores, ai_decision, reasons, ... }
```

## Asynchronous evaluate (Kafka path)

The API Gateway immediately returns a `202 Accepted` response and publishes the proposal to Kafka. The Risk Engine consumer picks it up, runs the same LangGraph workflow, and publishes the result to a downstream topic.

```mermaid
sequenceDiagram
    participant C as Client
    participant GW as API Gateway :8010
    participant KF as Kafka
    participant RE as Risk Engine consumer
    participant MG as Memgraph
    participant LLM as Gemini 2.5 Flash

    C->>GW: POST /evaluate/async { applicant, policy }
    GW->>KF: ProposalSubmittedEvent → insurance.proposal.submitted.v1
    GW-->>C: 202 { event_id, proposal_id, status: "accepted" }

    note over KF,RE: async — decoupled from HTTP request
    KF->>RE: consumer reads ProposalSubmittedEvent
    RE->>MG: Cypher ring query
    MG-->>RE: ring intelligence
    RE->>LLM: scoring prompts (medical, financial, fraud)
    LLM-->>RE: scores + reasons
    RE->>RE: decision_aggregation
    RE->>KF: RiskEvaluatedEvent → insurance.risk.evaluated.v1
```

### Kafka event schemas

Both envelopes are in `shared/events/kafka_events.py`:

```python
# Producer: API Gateway  →  Topic: insurance.proposal.submitted.v1
class ProposalSubmittedEvent(BaseModel):
    event_id: UUID          # correlation ID
    event_type: str         # "ProposalSubmitted"
    timestamp: datetime
    tenant_id: UUID
    payload: ProposalPayload  # { proposal_id, applicant, policy }

# Producer: Risk Engine  →  Topic: insurance.risk.evaluated.v1
class RiskEvaluatedEvent(BaseModel):
    event_id: UUID
    event_type: str         # "RiskEvaluated"
    timestamp: datetime
    correlation_id: UUID    # matches ProposalSubmittedEvent.event_id
    payload: RiskEvaluatedPayload  # { proposal_id, scores, ai_decision, reasons }
```

## LangGraph workflow (Risk Engine internals)

```mermaid
flowchart TD
    START([START]) --> V[validate_input\ndeterministic]
    V -->|invalid| END1([END — 422])
    V -->|valid| M[medical_scoring\nGemini 2.5 Flash]
    M --> F[financial_scoring\nGemini 2.5 Flash]
    F --> FR[fraud_detection\nMemgraph ring query\n+ Gemini 2.5 Flash]
    FR --> D[decision_aggregation\ndeterministic]
    D --> END2([END])

    style V fill:#f0f4ff
    style M fill:#fff3e0
    style F fill:#fff3e0
    style FR fill:#fce4ec
    style D fill:#e8f5e9
```

### Node details

| Node | Type | Inputs | Outputs |
|---|---|---|---|
| `validate_input` | Deterministic | `applicant`, `policy` | `is_valid`, `validation_errors` |
| `medical_scoring` | LLM (structured output) | `applicant` | `medical_score` (0–100), `medical_reasons` |
| `financial_scoring` | LLM (structured output) | `applicant`, `policy` | `financial_score` (0–100), `financial_reasons` |
| `fraud_detection` | Memgraph + LLM | `applicant`, `policy` + graph context | `fraud_probability` (0.0–1.0), `fraud_reasons` |
| `decision_aggregation` | Deterministic | all scores + reasons | `composite_risk_score`, `ai_decision`, `reasons` |

### Validation rules (validate_input)

- Applicant age must be 18–70 years
- `declared_income` > 0
- `coverage_amount` > 0
- `coverage_amount` ≤ 20 × `declared_income`
- `term_years` must be 1–40

### Decision bands (decision_aggregation)

```
composite = (0.40 × medical) + (0.40 × financial) + (0.20 × fraud × 100)

Auto Approve       → composite < 30  AND  fraud < 0.10
Decline            → composite > 75  OR   fraud > 0.60
Human Review       → everything else
```

If any upstream LangGraph node fails, the aggregation node defaults the missing score to 50 / 0.5, keeping the decision safely in the `Human Review` band rather than accidentally auto-approving.

## Streaming (SSE)

Both the Risk Engine and OCR Engine support `POST /evaluate/stream` and `POST /extract/stream` respectively. Each completed LangGraph node (or Gemini chunk) is emitted as a Server-Sent Event:

```json
// Progress event (one per LangGraph node)
{ "type": "progress", "node": "medical_scoring", "data": { "medical_score": 42, ... } }

// Final event
{ "type": "done", "data": { /* full RiskState */ } }

// Error event
{ "type": "error", "message": "..." }
```
