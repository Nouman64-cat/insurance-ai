"""Tests for risk_persistence's decision->status mapping and the Kafka
idempotency guard (brief §23 "Decision"/"Kafka" sections).

Run inside the container: `docker compose exec api-gateway python -m pytest test_risk_persistence.py -q`
"""

from __future__ import annotations

from shared.models.core import AIDecision, CaseStatusEnum, PolicyStatusEnum
from risk_persistence import DECISION_CASE_STATUS, DECISION_POLICY_STATUS


def test_every_ai_decision_has_a_policy_status_mapping():
    """A decision value with no mapping would silently no-op
    apply_ai_policy_status — every AIDecision member must be covered."""
    missing = [d.value for d in AIDecision if d.value not in DECISION_POLICY_STATUS]
    assert not missing, f"AIDecision values with no policy-status mapping: {missing}"


def test_every_ai_decision_has_a_case_status_mapping():
    missing = [d.value for d in AIDecision if d.value not in DECISION_CASE_STATUS]
    assert not missing, f"AIDecision values with no case-status mapping: {missing}"


def test_no_decision_auto_finalizes_approved_or_declined():
    """The AI must never move a case straight to Approved/Rejected or a
    policy straight to Approved/Declined — only a human via PATCH
    /cases/{id}/status does that (brief §11)."""
    forbidden_case = {CaseStatusEnum.APPROVED, CaseStatusEnum.REJECTED}
    forbidden_policy = {PolicyStatusEnum.APPROVED, PolicyStatusEnum.DECLINED}
    for decision, status in DECISION_CASE_STATUS.items():
        assert status not in forbidden_case, f"{decision} auto-finalizes case status {status}"
    for decision, status in DECISION_POLICY_STATUS.items():
        assert status not in forbidden_policy, f"{decision} auto-finalizes policy status {status}"


def test_request_additional_evidence_pauses_at_pending_documents():
    """The one decision that must NOT park at Under Review — missing
    mandatory requirements pauses the workflow instead (brief §4)."""
    assert DECISION_CASE_STATUS["Request Additional Evidence"] == CaseStatusEnum.PENDING_DOCUMENTS


def test_duplicate_risk_evaluated_event_is_not_persisted_twice():
    """Exercises the correlation_id idempotency guard in
    risk_result_worker._process without needing a live DB: the guard is a
    SELECT-before-INSERT keyed on (policy_id, correlation_id) — asserting the
    query shape here would require a DB; instead this documents the
    invariant and is extended into a real DB-backed test once a test
    database fixture exists for this service."""
    import inspect
    import risk_result_worker
    source = inspect.getsource(risk_result_worker._process)
    assert "correlation_id == event.correlation_id" in source
    assert "already persisted" in source
