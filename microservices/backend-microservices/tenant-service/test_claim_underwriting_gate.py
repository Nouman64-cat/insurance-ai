"""A contestable claim goes through the Underwriting department before Claims approves or pays it.

Run: docker compose exec -T tenant-service python -m pytest -q test_claim_underwriting_gate.py
"""
import asyncio
from types import SimpleNamespace

from routers import claim_workflow as w
from shared.models.core import CaseStatusEnum, ClaimStatusEnum


class _Session:
    def __init__(self, cases):
        self.cases = cases

    async def exec(self, *_a, **_k):
        rows = self.cases
        return SimpleNamespace(all=lambda: rows)


def _state(*, contestable=True, flags=(), status=ClaimStatusEnum.UNDER_INVESTIGATION, cases=()):
    claim = SimpleNamespace(id="c1", status=status, underwriting_referral_reason=None, underwriting_decision_notes=None)
    proc = SimpleNamespace(eligibility_json={"contestable": contestable},
                           investigation_json={"flags": [{"code": c} for c in flags]})
    return asyncio.run(w._underwriting(_Session(list(cases)), claim, proc))


def _case(status):
    return SimpleNamespace(caseStatus=status, caseNumber="UW-CLM-2026-0008-AB12")


def test_underwriting_state():
    assert _state(contestable=False)["state"] == "not_required"
    assert _state(contestable=False, flags=["contestable"])["state"] == "not_referred"     # flagged by the investigation
    assert _state()["state"] == "not_referred"
    assert _state(status=ClaimStatusEnum.REUNDERWRITING_REQUIRED, cases=[_case(CaseStatusEnum.NEW)])["state"] == "in_review"
    assert _state(cases=[_case(CaseStatusEnum.APPROVED)])["state"] == "cleared"
    assert _state(cases=[_case(CaseStatusEnum.REJECTED)])["state"] == "declined"


def test_decisions_wait_for_underwriting():
    not_referred, in_review = _state(), _state(status=ClaimStatusEnum.REUNDERWRITING_REQUIRED)
    for d in ("Approve", "PartialApprove"):
        assert w._underwriting_blocks(not_referred, d) and w._underwriting_blocks(in_review, d)
    assert w._underwriting_blocks(in_review, "Reject")                 # nothing is decided mid-review
    for d in ("Reject", "RequestInfo", "Refer"):                       # an un-referred claim may still be rejected / referred
        assert w._underwriting_blocks(not_referred, d) is None
    assert w._underwriting_blocks(_state(cases=[_case(CaseStatusEnum.APPROVED)]), "Approve") is None


def test_claim_case_requirements_are_the_claims_documents(monkeypatch):
    from services import underwriting_gate as g

    async def docs(*_a):
        return [{"label": "Death certificate from the competent local authority", "required": True, "status": "Received",
                 "artifact_id": "00000000-0000-0000-0000-000000000001"},
                {"label": "Attested CNIC copies for insured and nominee(s)", "required": True, "status": "Waived"},
                {"label": "Payee bank account details / cancelled cheque", "required": True, "status": "Requested"},
                {"label": "Rescue report", "required": False, "status": "Requested"}]
    monkeypatch.setattr(g, "claim_documents_for", docs)
    specs = asyncio.run(g._current_specs(None, "t", SimpleNamespace(claim_id="c1", caseld="k1")))
    got = {s.code: (s.category.value, s.status.value) for s in specs}
    assert got == {"Death_certificate_from_the_competent_local_authority": ("Medical", "Satisfied"),
                   "Attested_CNIC_copies_for_insured_and_nominee_s": ("Identity", "Waived"),
                   "Payee_bank_account_details_cancelled_cheque": ("Other", "Missing")}
    assert not any(s.code in ("MEDICAL_EXAMINATION", "ECG", "LAB_REPORTS") for s in specs)
