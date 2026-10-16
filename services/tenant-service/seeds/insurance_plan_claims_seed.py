"""Import reviewed Adamjee claims reference terms into existing plans.

Dry run by default. Apply to selected tenants with --tenant-id (repeatable),
or explicitly select --all-tenants, then --apply --backup /path/to/backup.json.
Only claims_terms and updated_at change. No products are created or deleted.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from functools import lru_cache
import json
from pathlib import Path
import re
from urllib.parse import urlparse
from uuid import UUID

from sqlmodel import select

DATA_PATH = Path(__file__).with_name("data") / "adamjee_claims_terms.json"


def validate_catalog(data: dict) -> None:
    if data.get("schema_version") != 1 or not data.get("plans"):
        raise ValueError("Unsupported or empty claims catalog")
    for code, terms in data["plans"].items():
        if terms.get("status") not in {"published_summary", "conflicting_sources", "not_disclosed"}:
            raise ValueError(f"Invalid research status: {code}")
        if terms.get("operational_adjudication_enabled") is not False or terms.get("requires_policy_version_confirmation") is not True:
            raise ValueError(f"Claims research must remain a reference, not an adjudication rule: {code}")
        sources = terms.get("sources", [])
        ids = {s["id"] for s in sources}
        if not sources or len(ids) != len(sources) or "brochure" not in ids:
            raise ValueError(f"Missing or duplicate source identity: {code}")
        for source in sources:
            url = urlparse(source["url"])
            if url.scheme != "https" or url.hostname != "www.adamjeelife.com":
                raise ValueError(f"Nonofficial source: {code}")
            if not re.fullmatch(r"[0-9a-f]{64}", source["sha256"]):
                raise ValueError(f"Invalid source digest: {code}")
            if not source.get("pages") and not source.get("section"):
                raise ValueError(f"Missing page/section: {code}")
        facts = terms["benefits"] + (terms["waiting_periods"] or []) + (terms["exclusions"] or []) + list(terms["documents"].values()) + [terms["filing"]]
        if terms["notification"] is not None:
            facts.append(terms["notification"])
        for fact in facts:
            refs = fact.get("source_ids", [])
            if not refs or not set(refs) <= ids:
                raise ValueError(f"Missing or invalid fact provenance: {code}")
        if not terms["benefits"]:
            raise ValueError(f"Missing benefit summary: {code}")
        for benefit in terms["benefits"]:
            if benefit["scope"] not in {"base", "built_in", "optional_rider", "plan_benefit"}:
                raise ValueError(f"Invalid benefit scope: {code}")
        if terms["exclusions"] is None and terms["exclusions_disclosure"] != "not_disclosed_in_reviewed_brochure":
            raise ValueError(f"Undisclosed exclusions must be explicit: {code}")
        for wait in terms["waiting_periods"] or []:
            if not isinstance(wait["days"], int) or wait["days"] < 0:
                raise ValueError(f"Invalid waiting period: {code}")


@lru_cache(maxsize=1)
def _catalog() -> dict:
    data = json.loads(DATA_PATH.read_text())
    validate_catalog(data)
    return data["plans"]


def claims_terms_for(code: str) -> dict | None:
    """Independent copy for new seed records; generic/custom plans stay null."""
    return deepcopy(_catalog().get(code))


async def import_terms(tenant_ids: list[UUID], *, all_tenants: bool, apply: bool, backup: Path | None) -> dict:
    from database import _session_factory
    from shared.models.core import InsurancePlan, Tenant

    catalog = _catalog()
    async with _session_factory() as session:
        if all_tenants:
            tenants = list((await session.exec(select(Tenant))).all())
        else:
            tenants = list((await session.exec(select(Tenant).where(Tenant.id.in_(tenant_ids)))).all())
            if {t.id for t in tenants} != set(tenant_ids):
                raise ValueError("At least one requested tenant does not exist")
        stmt = select(InsurancePlan).where(InsurancePlan.tenant_id.in_([t.id for t in tenants]))
        if apply:
            stmt = stmt.with_for_update()
        plans = list((await session.exec(stmt)).all())
        changes, preserved, unchanged, unrelated = [], [], [], []
        for plan in plans:
            target = catalog.get(plan.code)
            if target is None or (plan.surrender_terms or {}).get("insurer") != target["insurer"]:
                unrelated.append(plan.code)
            elif plan.claims_terms == target:
                unchanged.append(plan.code)
            elif plan.claims_terms is not None:
                # Existing manual or other-source terms are never overwritten.
                preserved.append(plan.code)
            else:
                changes.append((plan, target))
        summary = {
            "applied": apply,
            "tenants": [{"id": str(t.id), "name": t.name} for t in tenants],
            "updates": len(changes), "unchanged": len(unchanged),
            "preserved_existing": preserved, "unrelated_plans_skipped": len(unrelated),
            "research_statuses": dict(Counter(t["status"] for _, t in changes)),
        }
        if apply and changes:
            if backup is None:
                raise ValueError("An apply operation requires a backup path")
            snapshot = {"created_at_utc": datetime.now(timezone.utc).isoformat(), "rows": [
                {"id": str(p.id), "tenant_id": str(p.tenant_id), "code": p.code,
                 "claims_terms": p.claims_terms, "updated_at": p.updated_at.isoformat()}
                for p, _ in changes
            ]}
            backup.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation prevents replacing an earlier rollback snapshot.
            with backup.open("x") as handle:
                json.dump(snapshot, handle, indent=2)
            for plan, target in changes:
                plan.claims_terms = deepcopy(target)
                plan.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                session.add(plan)
            await session.commit()
            summary["backup"] = str(backup)
        return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--tenant-id", action="append", type=UUID)
    scope.add_argument("--all-tenants", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    if args.apply and args.backup is None:
        parser.error("--apply requires --backup")
    print(json.dumps(asyncio.run(import_terms(args.tenant_id or [], all_tenants=args.all_tenants,
                                             apply=args.apply, backup=args.backup)), indent=2))


if __name__ == "__main__":
    main()
