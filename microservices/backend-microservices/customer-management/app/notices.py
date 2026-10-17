"""Customer notifications, derived from the policy and claim records the portal already reads.

There is no separate notification store to drift out of date: the list is rebuilt from live data on every request, and
only the customer's read/unread marks are persisted (notification_state, keyed by a stable notice key)."""
from datetime import date, datetime, timedelta
from typing import Any, Optional

SEVERITY_ORDER = {"critical": 0, "warning": 1, "success": 2, "info": 3}


def _d(value: Optional[str]) -> Optional[date]:
    try:
        return date.fromisoformat(value[:10]) if value else None
    except ValueError:
        return None


def build(policies: list[dict], claims: list[dict], today: Optional[date] = None) -> list[dict]:
    today = today or date.today()
    out: list[dict] = []

    def add(key: str, kind: str, severity: str, *, policy: Optional[dict] = None, claim: Optional[dict] = None, at: Optional[str] = None, **params: Any) -> None:
        out.append({"key": key, "kind": kind, "severity": severity, "policy_id": policy["id"] if policy else (claim or {}).get("policy_id"),
                    "claim_id": claim["id"] if claim else None, "at": at or today.isoformat(),
                    "params": {"policy_number": (policy or claim or {}).get("policy_number"), **params}})

    for p in policies:
        prem, status = p.get("premium") or {}, p.get("status")
        if p.get("pending_issuance"):
            add(f"pending_issuance:{p['id']}", "policy_pending_issuance", "info", policy=p)
        if status == "Lapsed":
            add(f"policy_lapsed:{p['id']}", "policy_lapsed", "critical", policy=p)
        if not p.get("in_force"):
            continue
        due = _d(prem.get("next_due_date"))
        if prem.get("arrears_count"):
            add(f"premium_overdue:{p['id']}:{prem.get('next_due_date')}", "premium_overdue", "critical" if prem.get("lapse_due") else "warning",
                policy=p, amount=prem.get("due_now"), grace_until=prem.get("grace_until"), days_left=prem.get("grace_days_left"))
        elif due and 0 <= (due - today).days <= 14:
            add(f"premium_due:{p['id']}:{prem.get('next_due_date')}", "premium_due", "info", policy=p, amount=prem.get("next_due_amount"),
                due_date=prem.get("next_due_date"), days=(due - today).days)
        end = _d(p.get("expiry_date")) or _d(p.get("maturity_date"))
        if end and 0 <= (end - today).days <= 60:
            add(f"policy_expiry:{p['id']}:{end.isoformat()}", "policy_expiry", "info", policy=p, date=end.isoformat(), days=(end - today).days)

    recent = (today - timedelta(days=90)).isoformat()
    for c in claims:
        key = c.get("status_key") or "in_review"
        last = (c.get("last_update") or "")[:10]
        if key in ("closed", "settled", "declined") and last and last < recent:
            continue  # old, finished business is not a notification
        severity = {"documents_needed": "warning", "declined": "warning", "approved": "success", "partially_approved": "success", "settled": "success"}.get(key, "info")
        add(f"claim:{c['id']}:{key}", f"claim_{key}", severity, claim=c, claim_number=c.get("claim_number"), at=last or None)

    out.sort(key=lambda n: (SEVERITY_ORDER.get(n["severity"], 9), n["at"] or ""), reverse=False)
    return out
