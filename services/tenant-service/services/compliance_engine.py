"""
Pre-issuance compliance engine — AML, Sanctions/PEP, SECP.

AML and SECP have no live third-party feed to check against in this
environment, so those two stay a *believable internal engine*: rule sets over
the applicant's own data (occupation, declared income vs. sum assured, CNIC
format). Results are deterministic — the same applicant always yields the
same outcome — so seeded "flagged" customers reliably exercise the flag →
clear path in the UI.

Sanctions/PEP is different: services/pep_screening.py has a real integration
to OpenSanctions (covers Pakistani PEPs + NACTA proscribed persons in one
collection). When OPENSANCTIONS_API_KEY is configured, real matches are used;
otherwise this module falls back to the same internal fictional-watchlist
name-match it always used, so the screen never hard-fails for lack of a key.

Each screen returns a list of dicts:
    {"check_type", "status", "score", "details": {...}}
consumed by routers/pre_issuance.py to persist ComplianceCheck rows.
"""

from __future__ import annotations

import os
import re
from typing import Optional

from services import pep_screening
from shared.models.core import (
    ComplianceCheckTypeEnum,
    ComplianceStatusEnum,
    Customer,
    Policy,
)

# Fictional sanctions / PEP watchlist tokens. A name containing any token (word
# match, case-insensitive) is treated as a potential hit needing manual review.
_SANCTIONS_WATCHLIST = {
    "qadeer khan", "dawood", "shakil afridi", "hafiz saeed", "lakhvi",
}

# Occupations with elevated money-laundering exposure (cash-intensive / opaque).
_HIGH_RISK_OCCUPATION_TOKENS = (
    "trader", "import", "export", "real estate", "property dealer",
    "jewel", "gold", "currency", "money exchange", "crypto", "casino",
)


def _cnic_valid(cnic: Optional[str]) -> bool:
    """A Pakistani CNIC is 13 digits, usually written 00000-0000000-0."""
    if not cnic:
        return False
    digits = re.sub(r"\D", "", cnic)
    return len(digits) == 13


def _screen_sanctions_internal(customer: Customer) -> dict:
    """Fallback path — fictional internal watchlist, used when OpenSanctions
    isn't configured or the live call fails."""
    name = (customer.name or "").lower()
    hits = [tok for tok in _SANCTIONS_WATCHLIST if tok in name]
    if hits:
        return {
            "check_type": ComplianceCheckTypeEnum.SANCTIONS.value,
            "status": ComplianceStatusEnum.FLAGGED.value,
            "score": 100.0,
            "details": {"matched": hits, "list": "Internal watchlist (no live PEP/sanctions API configured)",
                        "note": "Potential name match — manual review required.", "source": "internal"},
        }
    return {
        "check_type": ComplianceCheckTypeEnum.SANCTIONS.value,
        "status": ComplianceStatusEnum.PASSED.value,
        "score": 0.0,
        "details": {"matched": [], "list": "Internal watchlist (no live PEP/sanctions API configured)",
                    "note": "No watchlist match.", "source": "internal"},
    }


async def _screen_sanctions(customer: Customer) -> dict:
    """Sanctions/PEP screen — real OpenSanctions match when configured,
    otherwise the internal fictional-watchlist fallback."""
    dob = customer.dob.isoformat() if customer.dob else None
    matches = await pep_screening.screen_person(customer.name or "", dob=dob)

    if matches is None:
        # Unconfigured, unreachable, or malformed response — degrade rather
        # than block the applicant on an infrastructure problem.
        return _screen_sanctions_internal(customer)

    if not matches:
        return {
            "check_type": ComplianceCheckTypeEnum.SANCTIONS.value,
            "status": ComplianceStatusEnum.PASSED.value,
            "score": 0.0,
            "details": {"matched": [], "list": "OpenSanctions (PEP + NACTA + global sanctions)",
                        "note": "No match found.", "source": "opensanctions"},
        }

    return {
        "check_type": ComplianceCheckTypeEnum.SANCTIONS.value,
        "status": ComplianceStatusEnum.FLAGGED.value,
        "score": matches[0]["score"],
        "details": {"matched": matches, "list": "OpenSanctions (PEP + NACTA + global sanctions)",
                    "note": f"{len(matches)} potential match(es) — manual review required.",
                    "source": "opensanctions"},
    }


def _screen_aml(customer: Customer, policy: Policy) -> dict:
    reasons: list[str] = []
    score = 0.0

    occ = (customer.occupation or "").lower()
    occ_hit = next((t for t in _HIGH_RISK_OCCUPATION_TOKENS if t in occ), None)
    if occ_hit:
        score += 45
        reasons.append(f"High-risk occupation signal: '{occ_hit}' (+45)")

    income = customer.declared_income or 0
    coverage = policy.coverage_amount or 0
    if income > 0 and coverage > 0:
        ratio = coverage / income
        if ratio >= 10:
            score += 40
            reasons.append(f"Sum assured {ratio:.1f}× declared income — affordability mismatch (+40)")
        elif ratio >= 6:
            score += 20
            reasons.append(f"Sum assured {ratio:.1f}× declared income — elevated (+20)")
    elif income == 0:
        score += 25
        reasons.append("Declared income unknown — source of funds unverified (+25)")

    if coverage >= 20_000_000:
        score += 15
        reasons.append("Large sum assured (≥ PKR 20M) (+15)")

    if score >= 90:
        status = ComplianceStatusEnum.FAILED.value
    elif score >= 60:
        status = ComplianceStatusEnum.FLAGGED.value
    else:
        status = ComplianceStatusEnum.PASSED.value

    return {
        "check_type": ComplianceCheckTypeEnum.AML.value,
        "status": status,
        "score": float(min(score, 100.0)),
        "details": {"reasons": reasons or ["No AML risk signals."],
                    "threshold": {"flag": 60, "fail": 90}},
    }


def _screen_secp(customer: Customer) -> dict:
    if not _cnic_valid(customer.cnic):
        return {
            "check_type": ComplianceCheckTypeEnum.SECP.value,
            "status": ComplianceStatusEnum.FLAGGED.value,
            "score": 50.0,
            "details": {"cnic": customer.cnic,
                        "note": "CNIC missing or not a valid 13-digit identifier — "
                                "SECP/NADRA verification could not complete."},
        }
    return {
        "check_type": ComplianceCheckTypeEnum.SECP.value,
        "status": ComplianceStatusEnum.PASSED.value,
        "score": 0.0,
        "details": {"cnic": customer.cnic,
                    "note": "CNIC format valid; SECP regulatory checks passed."},
    }


async def screen(customer: Customer, policy: Policy) -> list[dict]:
    """Run all three mandatory checks for an applicant."""
    return [
        _screen_aml(customer, policy),
        await _screen_sanctions(customer),
        _screen_secp(customer),
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Screening as stored + read. Both the pre-underwriting gate
# (routers/cases.py::/cases/{id}/compliance/run) and the Stage A panel
# (routers/pre_issuance.py::/policies/{id}/compliance/run) screen the SAME
# policy and write the SAME ComplianceCheck rows, each deleting the other's
# results first. They used to disagree about what a result means: Stage A forced
# every check to Flagged and re-labelled stored Passed rows as Flagged on read,
# while the case queue reported those same rows as Passed. Running one screen
# therefore silently un-cleared the other's gate.
#
# Both now go through the two functions below, so there is one definition of
# "what did the screen say" and one definition of "is that good enough to pass".
# ─────────────────────────────────────────────────────────────────────────────

# When true (the demo default), a machine PASS is not enough on its own — a
# compliance officer has to countersign it before the gate reads as cleared.
# Set COMPLIANCE_REQUIRE_MANUAL_CLEARANCE=false to trust the engine outright.
REQUIRE_MANUAL_CLEARANCE: bool = (
    os.environ.get("COMPLIANCE_REQUIRE_MANUAL_CLEARANCE", "true").lower()
    not in ("false", "0", "no")
)


def effective_status(check) -> ComplianceStatusEnum:
    """The status a ComplianceCheck should be *presented and gated* on.

    Under REQUIRE_MANUAL_CLEARANCE an engine PASS that no officer has signed off
    still reads as FLAGGED — it needs a human. Anything an officer has actioned
    (``cleared_by`` set) is reported exactly as stored.
    """
    status = check.status
    if not REQUIRE_MANUAL_CLEARANCE or check.cleared_by:
        return status
    if status == ComplianceStatusEnum.PASSED:
        return ComplianceStatusEnum.FLAGGED
    return status


async def screen_and_store(session, tenant_id, customer: Customer, policy: Policy) -> list:
    """Re-run all three screenings for a policy, replacing any prior results.

    Idempotent: previous rows for this policy are removed first, so repeated
    runs (from either entry point) converge on the same three rows rather than
    accumulating. The engine's own verdict is stored verbatim — presentation
    rules belong in effective_status(), not in the stored data.

    Refresh, don't reset: deleting-and-recreating means a fresh officer
    clearance would otherwise be lost on every re-run, even when nothing
    riskier turned up. A prior clearance is carried forward per check_type
    unless the new score is higher than what was cleared — a materially
    worse re-screen still requires a fresh look, mirroring the same
    principle applied to the insurance-history re-screen
    (routers/insurance_history.py:run_insurance_history).
    """
    from sqlmodel import select
    from datetime import datetime

    from shared.models.core import ComplianceCheck

    prior_by_type: dict = {}
    for old in (await session.exec(
        select(ComplianceCheck).where(ComplianceCheck.policy_id == policy.id)
    )).all():
        if old.cleared_by is not None:
            prior_by_type[old.check_type] = old
        await session.delete(old)

    now = datetime.utcnow()
    created = []
    for result in await screen(customer, policy):
        check_type = ComplianceCheckTypeEnum(result["check_type"])
        status = ComplianceStatusEnum(result["status"])
        score = result.get("score")

        prior = prior_by_type.get(check_type)
        cleared_by = cleared_at = clearance_note = None
        if prior is not None:
            materially_worse = prior.score is not None and score is not None and score > prior.score
            if not materially_worse:
                status = ComplianceStatusEnum.PASSED
                cleared_by = prior.cleared_by
                cleared_at = prior.cleared_at
                clearance_note = prior.clearance_note

        chk = ComplianceCheck(
            tenant_id=tenant_id,
            policy_id=policy.id,
            customer_id=customer.id,
            check_type=check_type,
            status=status,
            score=score,
            details_json=result.get("details"),
            screened_at=now,
            cleared_by=cleared_by,
            cleared_at=cleared_at,
            clearance_note=clearance_note,
        )
        session.add(chk)
        created.append(chk)
    return created
