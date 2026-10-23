"""What a conversation changed in the sandbox: the `state.*` of a case.

A snapshot of the tenant's data is taken before the conversation and after every turn; `build_state` compares them. Nothing here
guesses what the agent meant: it reports what the database holds. Targets it produces (every `state.*` target the dataset's chat
cases use; test_chat.py checks the list against the dataset):

  state.new_customers / new_users / new_cases / new_tenants / new_organizations   rows created during the conversation
  state.claims.new_count                                                           claims created
  state.customers.<fixture ref>.{declared_income, cnic, exists}                    a seeded customer, by its fixture reference
  state.customers.cnics                                                            every CNIC in the tenant
  state.lead.*                  the customer the conversation was about: profile_status, date_of_birth, occupation, declared_income,
                                city, assigned_to_actor, pending_plan.{coverage_amount, term_years, plan_id}
  state.turn.N.lead.pending_plan  the same lead after turn N
  state.policy.{status, policy_number_is_null}   the policy of the customer named in the conversation
  state.claim.{status, eligibility_status}       the claim created, or the one of the customer named in the conversation

"The customer the conversation was about" is, in order: a customer created in it, a customer whose row changed in it, a customer
whose name the user mentioned. With none of those the section is empty (`{}`), so an assertion about it fails honestly instead of
passing on nothing.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


COUNT_TABLES = {"customers": "customers", "users": "users", "cases": "cases", "tenants": "tenants", "organizations": "organizations", "claims": "claims"}


async def snapshot(conn, tenant_id: str) -> Dict[str, Any]:
    """The facts the observer compares, read with one connection."""
    from sqlalchemy import text            # here, not at the top: the pure part of this module imports without a database library
    async def rows(sql: str, **params):
        return [dict(r._mapping) for r in await conn.execute(text(sql), params)]
    customers = await rows("select id, name, cnic, dob, occupation, declared_income, city, profile_status, assigned_agent_id, details from customers where tenant_id = :t", t=tenant_id)
    policies = await rows("select p.id, p.customer_id, p.status, p.policy_number, p.updated_at from policies p where p.tenant_id = :t", t=tenant_id)
    claims = await rows("select c.id, c.policy_id, c.status, c.claimant_name, cp.eligibility_status from claims c left join claim_processes cp on cp.claim_id = c.id where c.tenant_id = :t", t=tenant_id)
    counts = {}
    for key, table in COUNT_TABLES.items():
        scoped = key in ("customers", "cases", "organizations", "claims")
        sql = f"select count(*) from {table}" + (" where tenant_id = :t" if scoped else "")
        counts[key] = (await conn.execute(text(sql), {"t": tenant_id} if scoped else {})).scalar_one()
    return {"counts": counts, "customers": {str(r["id"]): r for r in customers}, "policies": {str(r["id"]): r for r in policies}, "claims": {str(r["id"]): r for r in claims}}


def claim_status(raw: Any) -> Any:
    """A claim's status as the application shows it ("Under Investigation"). The claims table stores the enum's NAME (UNDER_INVESTIGATION),
    so the name is mapped back to the value; a value that is already one is kept."""
    if raw is None:
        return None
    try:
        from shared.models.core import ClaimStatusEnum
        return ClaimStatusEnum[str(getattr(raw, "name", raw))].value
    except Exception:                                  # noqa: BLE001 — not a name (already a value), or the models are not importable here
        return getattr(raw, "value", raw)


def _norm(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else (str(value) if value is not None and type(value).__name__ == "UUID" else value)


def _name_hit(name: Optional[str], texts: List[str]) -> bool:
    blob = " ".join(texts).lower()
    parts = [p for p in (name or "").lower().split() if len(p) > 2]
    return bool(parts) and all(p in blob for p in parts)


def _lead(before: Dict[str, Any], after: Dict[str, Any], texts: List[str], actor_id: Optional[str]) -> Dict[str, Any]:
    new = [r for k, r in after["customers"].items() if k not in before["customers"]]
    changed = [r for k, r in after["customers"].items() if k in before["customers"] and before["customers"][k] != r]
    named = [r for r in after["customers"].values() if _name_hit(r.get("name"), texts)]
    pick = (new or changed or named or [None])[0]
    if pick is None:
        return {}
    details = pick.get("details") or {}
    plan = details.get("pending_plan") if isinstance(details, dict) else None
    return {"profile_status": pick.get("profile_status") if not hasattr(pick.get("profile_status"), "value") else pick["profile_status"].value,
            "date_of_birth": _norm(pick.get("dob")), "occupation": pick.get("occupation"), "declared_income": pick.get("declared_income"), "city": pick.get("city"),
            "assigned_to_actor": bool(actor_id) and str(pick.get("assigned_agent_id")) == str(actor_id),
            "pending_plan": plan if plan else None}


def build_state(before: Dict[str, Any], after: Dict[str, Any], *, texts: List[str], ref_ids: Dict[str, str], actor_id: Optional[str] = None,
                per_turn: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """The `state` of an observation. `ref_ids` maps a fixture customer reference to the id the sandbox gave it; `per_turn` are the
    snapshots taken after each turn (for state.turn.N.*)."""
    counts = {k: after["counts"][k] - before["counts"][k] for k in before["counts"]}
    state: Dict[str, Any] = {f"new_{k}": v for k, v in counts.items() if k != "claims"}
    state["claims"] = {"new_count": counts["claims"]}
    customers: Dict[str, Any] = {"cnics": [r.get("cnic") for r in after["customers"].values() if r.get("cnic")]}
    for ref, cid in ref_ids.items():
        row = after["customers"].get(str(cid))
        customers[ref] = {"exists": row is not None, "declared_income": row.get("declared_income") if row else None, "cnic": row.get("cnic") if row else None}
    state["customers"] = customers
    state["lead"] = _lead(before, after, texts, actor_id)
    state["turn"] = [{"lead": _lead(before, snap, texts, actor_id)} for snap in (per_turn or [])]
    # the policy of the customer the conversation named, else of the lead
    names = [r for r in after["customers"].values() if _name_hit(r.get("name"), texts)]
    owners = {str(r["id"]) for r in names}
    pols = [p for p in after["policies"].values() if str(p["customer_id"]) in owners]
    changed = [p for p in pols if before["policies"].get(str(p["id"])) != p]
    policy = (changed or sorted(pols, key=lambda p: (str(p["status"]) != "Approved", str(p["policy_number"]))) or [None])[0]
    state["policy"] = ({"status": getattr(policy["status"], "value", policy["status"]), "policy_number_is_null": policy.get("policy_number") is None} if policy else {})
    created = [c for k, c in after["claims"].items() if k not in before["claims"]]
    on_owner = [c for c in after["claims"].values() if str(c.get("policy_id")) in {str(p["id"]) for p in pols} or _name_hit(c.get("claimant_name"), texts)]
    claim = (created or on_owner or [None])[0]
    state["claim"] = ({"status": claim_status(claim["status"]), "eligibility_status": claim.get("eligibility_status")} if claim else {})
    return state


# Every `state.*` target path the observer can produce, as patterns (a segment in <> stands for any single segment).
PRODUCED = (
    "state.new_customers", "state.new_users", "state.new_cases", "state.new_tenants", "state.new_organizations", "state.claims.new_count",
    "state.customers.cnics", "state.customers.<ref>.declared_income", "state.customers.<ref>.cnic", "state.customers.<ref>.exists",
    "state.lead.profile_status", "state.lead.date_of_birth", "state.lead.occupation", "state.lead.declared_income", "state.lead.city",
    "state.lead.assigned_to_actor", "state.lead.pending_plan", "state.lead.pending_plan.<field>",
    "state.turn.<n>.lead.pending_plan", "state.policy.status", "state.policy.policy_number_is_null", "state.claim.status", "state.claim.eligibility_status",
)


def is_produced(target: str) -> bool:
    parts = target.split(".")
    for pattern in PRODUCED:
        p = pattern.split(".")
        if len(p) == len(parts) and all(a == b or (a.startswith("<") and a.endswith(">")) for a, b in zip(p, parts)):
            return True
    return False
