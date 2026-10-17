"""ENV_VAR=demo lets a CNIC discrepancy continue; anywhere else it still blocks.

Run: docker compose exec -T tenant-service python -m pytest -q shared/underwriting/test_demo_tolerance.py
(The claim payee side is in services/tenant-service/test_claim_engine.py.)
"""
from shared.underwriting.profile import UnderwritingProfile
from shared.underwriting.requirements_rules import determine_requirements
from shared.underwriting.results import VerificationFindingSpec, VerificationSeverity
from shared.underwriting.verification import verify_profile


def _mismatch():
    return UnderwritingProfile(identity={"cnic": "35202-1111111-1", "evidence": {"cnic": "35202-2222222-2"}})


def _prior(field="cnic"):
    return [VerificationFindingSpec(field=field, severity=VerificationSeverity.HIGH, declared_value="a", observed_value="b",
                                    explanation="mismatch")]


def test_strict_outside_demo(monkeypatch):
    monkeypatch.setenv("ENV_VAR", "production")
    cnic = next(f for f in verify_profile(_mismatch()) if f.field == "cnic")
    assert cnic.severity == VerificationSeverity.HIGH
    assert any(s.code.endswith(":cnic") for s in determine_requirements(UnderwritingProfile(), _prior()))


def test_demo_lets_a_cnic_discrepancy_continue(monkeypatch):
    monkeypatch.setenv("ENV_VAR", " Demo ")
    cnic = next(f for f in verify_profile(_mismatch()) if f.field == "cnic")
    assert cnic.severity == VerificationSeverity.LOW and "demo mode" in cnic.explanation       # recorded, not blocking
    assert not any(s.code.endswith(":cnic") for s in determine_requirements(UnderwritingProfile(), _prior()))  # old High one too
    assert any(s.code.endswith(":dob") for s in determine_requirements(UnderwritingProfile(), _prior("dob")))  # only CNIC

