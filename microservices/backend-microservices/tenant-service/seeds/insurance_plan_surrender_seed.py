"""Import reviewed Adamjee early-exit reference terms into existing plans.

Dry run by default. Apply to selected tenants with --tenant-id (repeatable),
or explicitly select --all-tenants, then --apply --backup /path/to/backup.json.
Only surrender_terms and updated_at change. No products are created or deleted.
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

DATA_PATH = Path(__file__).with_name("data") / "adamjee_surrender_terms.json"


def validate_catalog(data: dict) -> None:
    if data.get("schema_version") != 1 or not data.get("plans"):
        raise ValueError("Unsupported or empty surrender catalog")
    for code, terms in data["plans"].items():
        if terms["status"] not in {"verified", "conflicting_sources", "not_disclosed", "not_applicable"}:
            raise ValueError(f"Invalid research status: {code}")
        if terms.get("operational_calculation_enabled") is not False:
            raise ValueError(f"Reference data must not enable settlement calculations: {code}")
        if not terms.get("sources"):
            raise ValueError(f"Missing provenance: {code}")
        for source in terms["sources"]:
            url = urlparse(source["url"])
            if url.scheme != "https" or url.hostname != "www.adamjeelife.com":
                raise ValueError(f"Nonofficial source: {code}")
            if not re.fullmatch(r"[0-9a-f]{64}", source["sha256"]):
                raise ValueError(f"Invalid source digest: {code}")
            if source.get("format") == "html":
                if not source.get("section"):
                    raise ValueError(f"Missing source section: {code}")
            elif not source.get("pages") or any(p < 1 for p in source["pages"]):
                raise ValueError(f"Invalid source page: {code}")
        schedule = terms.get("charge_schedule")
        if terms["status"] in {"not_disclosed", "not_applicable"} and schedule is not None:
            raise ValueError(f"Unknown or inapplicable charges must not be zero-filled: {code}")
        if schedule:
            next_start = 1
            for index, band in enumerate(schedule):
                if band["from"] != next_start or not 0 <= band["charge_pct"] <= 100:
                    raise ValueError(f"Invalid charge interval: {code}")
                end = band["through"]
                if end is None:
                    if index != len(schedule) - 1:
                        raise ValueError(f"Open-ended band must be last: {code}")
                elif end < band["from"]:
                    raise ValueError(f"Reversed charge interval: {code}")
                next_start = end + 1 if end is not None else None
        fee = terms.get("processing_fee_pkr")
        if fee is not None and fee < 0:
            raise ValueError(f"Invalid processing fee: {code}")


@lru_cache(maxsize=1)
def _catalog() -> dict:
    data = json.loads(DATA_PATH.read_text())
    validate_catalog(data)
    return data["plans"]


def surrender_terms_for(code: str) -> dict | None:
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
            if target is None:
                unrelated.append(plan.code)
            elif plan.surrender_terms == target:
                unchanged.append(plan.code)
            elif plan.surrender_terms is not None:
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
                 "surrender_terms": p.surrender_terms, "updated_at": p.updated_at.isoformat()}
                for p, _ in changes
            ]}
            backup.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation prevents replacing an earlier rollback snapshot.
            with backup.open("x") as handle:
                json.dump(snapshot, handle, indent=2)
            for plan, target in changes:
                plan.surrender_terms = deepcopy(target)
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
