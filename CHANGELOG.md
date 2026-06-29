## [Unreleased] - 2026-06-23

### Added

- **Memgraph Integration:** Introduced `graph_writer.py` with `write_applicant_to_graph()` to persist `:Applicant` nodes and create bidirectional `SAME_AREA` (5-digit CNIC prefix) and `SAME_OCCUPATION_CLUSTER` edges.
- **Fraud-Ring Detection Queries:** Added new tenant-scoped graph queries for income-outlier and coverage-cluster detection to replace the placeholder ring query.

### Changed

- **Workflow & LLM Prompting:** Updated `workflow.py` to execute the new tenant-scoped graph queries and modified the LLM prompt/summary to correctly parse and utilize the new cluster-based fraud signals.
- **Tenant Isolation:** Enforced `tenant_id` threading across `RiskState`, `run_evaluation`, and `stream_evaluation` for strict tenant isolation.
- **API Gateway Routing:** Modified `api-gateway/routers/evaluate.py` to forward the `X-Tenant-Id` header to the risk-engine SSE call.
- **Event Consumption:** Replaced `_MockGraph` in `consumer.py` with the real `run_evaluation()` via `run_in_executor`, ensuring graph writing occurs prior to publishing.
- **Post-Evaluation Persistence:** Updated `main.py` endpoints to extract `X-Tenant-Id` and trigger graph persistence asynchronously (via a `_persist_to_graph()` helper) only after successful evaluations (`__done__` events).
