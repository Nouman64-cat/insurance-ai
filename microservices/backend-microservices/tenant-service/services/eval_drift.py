"""The review queue behind the Drift Monitor: turns a scan (or a change in the change registry) into review items, and moves an item along the review
rules. The rules themselves are in shared/evaluation/drift.py; the database repeats them as CHECK constraints and append-only history.

  ingest_scan          one scan -> items. The same problem found twice is ONE item; an item the scan no longer finds is cleared; a problem that
                       comes back is reopened; an item a person has decided is never changed by a scan.
  record_config_change a change in the change registry -> a `config_changed` item (and suggested cases for a template change).
  transition           a person's decision on an item (start, accept, reject, dismiss, reopen), with the reason and, where it produces a case, the
                       expected value THEY wrote.
Nothing here edits a golden case, a dataset version or the lake.
"""
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import drift
from shared.models.evaluation import DRIFT_DECIDED, EvalCaseDependency, EvalDriftEvent, EvalDriftItem, EvalDriftScan, EvalVersionCase, EvalDatasetVersion, EvalDataset

# The kinds a scan can produce, and which of them a given scan actually looked at (a scan without two runs to compare says nothing about behaviour).
SCAN_KINDS = ("rule_changed", "oracle_error", "unconfirmed", "unpinned", "review_due", "coverage_gap", "proposal")
COMPARE_KINDS = ("behaviour_changed", "performance_changed")
ACTIONS = {"start": "in_review", "accept": "accepted", "reject": "rejected", "dismiss": "dismissed", "reopen": "open", "release": "open"}


async def _event(session: AsyncSession, item: EvalDriftItem, frm: Optional[str], to: str, *, actor_id: Optional[UUID], note: Optional[str], data: Optional[dict] = None) -> None:
    session.add(EvalDriftEvent(drift_item_id=item.id, from_state=frm, to_state=to, actor_kind="user" if actor_id else "system", actor_id=actor_id, note=note, data=data or {}))


def _view(item: EvalDriftItem) -> Dict[str, Any]:
    return {"state": item.state, "kind": item.kind, "expected": item.expected, "expected_source": item.expected_source, "decided_by": item.decided_by}


async def upsert(session: AsyncSession, f: Dict[str, Any], *, dataset_slug: Optional[str], scan_id: str, now: datetime) -> Tuple[EvalDriftItem, str]:
    """Create the item for a finding, or record that it was seen again. Returns (item, "created" | "seen" | "reopened")."""
    key = f["key"]
    item = (await session.exec(select(EvalDriftItem).where(EvalDriftItem.finding_key == key))).first()
    detail = f.get("detail") or {}
    if item is None:
        item = EvalDriftItem(finding_key=key, kind=f["kind"], severity=f.get("severity") or "medium", state="open", summary=f["summary"], dataset_slug=dataset_slug,
                             affected_cases=f.get("affected_cases") or [], detail=detail, registry_item_key=f.get("registry_item_key") or detail.get("registry_item"),
                             from_version=detail.get("from_version"), to_version=detail.get("to_version"), first_scan_id=scan_id, last_scan_id=scan_id, opened_at=now, last_seen_at=now)
        session.add(item)
        await session.flush()
        await _event(session, item, None, "open", actor_id=None, note=f"found by {scan_id}")
        return item, "created"
    item.times_seen += 1
    item.last_seen_at, item.last_scan_id = now, scan_id
    if item.state in ("open", "in_review", "cleared"):                 # what is shown follows what was found; a decision is left exactly as it is
        item.severity, item.summary, item.affected_cases, item.detail = f.get("severity") or item.severity, f["summary"], f.get("affected_cases") or [], detail
    outcome = "seen"
    if item.state == "cleared":
        item.state, item.cleared_at = "open", None
        await _event(session, item, "cleared", "open", actor_id=None, note=f"found again by {scan_id}")
        outcome = "reopened"
    session.add(item)
    return item, outcome


def _proposal_finding(p: Dict[str, Any]) -> Dict[str, Any]:
    return {"key": p["key"], "kind": "proposal", "severity": p.get("severity") or "medium", "summary": p["rationale"], "affected_cases": [p["seed_case"]] if p.get("seed_case") else [],
            "detail": {"stage": p.get("stage"), "scenario_type": p.get("scenario_type"), "seed_case": p.get("seed_case"), "from_finding": p.get("from_finding"),
                       "provenance": p.get("provenance"), "proposed_input": None, "expected": None}}


async def ingest_scan(session: AsyncSession, report: Dict[str, Any], *, created_by: Optional[UUID] = None, job_id: Optional[UUID] = None) -> Dict[str, Any]:
    """Store a scan report and bring the review queue in line with it. Loading the same scan twice changes nothing."""
    scan_id = report["scan_id"]
    existing = (await session.exec(select(EvalDriftScan).where(EvalDriftScan.scan_id == scan_id))).first()
    if existing is not None:
        return {"scan_id": scan_id, "already_ingested": True, **(existing.counts or {})}
    now = datetime.utcnow()
    ds = report.get("dataset") or {}
    slug, version = ds.get("dataset"), ds.get("version")
    kinds_checked = list(SCAN_KINDS) + (list(COMPARE_KINDS) if report.get("compared") else [])
    findings = list(report.get("findings", []))
    items = findings + [_proposal_finding(p) for p in report.get("proposals", [])]
    created = seen = reopened = 0
    present = set()
    for f in items:
        item, outcome = await upsert(session, f, dataset_slug=slug, scan_id=scan_id, now=now)
        present.add(item.finding_key)
        created, seen, reopened = created + (outcome == "created"), seen + (outcome == "seen"), reopened + (outcome == "reopened")
    # What this scan looked at and no longer finds is cleared (never a decided item, never one of a kind the scan did not look at).
    stale = (await session.exec(select(EvalDriftItem).where(EvalDriftItem.dataset_slug == slug, EvalDriftItem.kind.in_(kinds_checked),
                                                            EvalDriftItem.state.in_(["open", "in_review"])))).all()
    cleared = 0
    for item in stale:
        if item.finding_key in present or item.kind == "proposal" and (item.detail or {}).get("provenance", {}).get("kind") == "template_change":
            continue
        frm = item.state
        moved = drift.system_advance(_view(item), "cleared", scan_id=scan_id)
        item.state, item.cleared_at = moved["state"], now
        session.add(item)
        await _event(session, item, frm, "cleared", actor_id=None, note=f"not found by {scan_id}")
        cleared += 1
    counts = {"created": created, "seen_again": seen, "reopened": reopened, "cleared": cleared, "items_in_scan": len(items)}
    session.add(EvalDriftScan(scan_id=scan_id, dataset_slug=slug, dataset_version=version, source="published" if (ds.get("verified") or version not in (None, "working")) else "working",
                              compared=report.get("compared"), counts={**counts, **(report.get("counts") or {})},
                              summary={**(report.get("summary") or {}), "coverage": report.get("coverage"), "kinds_checked": kinds_checked}, job_id=job_id, created_by=created_by))
    await session.flush()
    return {"scan_id": scan_id, "already_ingested": False, **counts}


async def dependents_of(session: AsyncSession, item_key: str) -> List[Dict[str, Any]]:
    """Cases that depend on a watched item, in the latest dependency declaration of each dataset: [{dataset, version, case_id, severity}]."""
    from shared.evaluation import change_registry as cr
    rows = (await session.exec(select(EvalCaseDependency.dataset_slug, EvalCaseDependency.dataset_version, EvalCaseDependency.case_key, EvalCaseDependency.item_key))).all()
    latest: Dict[str, Tuple[int, ...]] = {}
    for slug, ver, _, _ in rows:
        v = tuple(int(x) for x in ver.split(".") if x.isdigit())
        latest[slug] = max(latest.get(slug, ()), v)
    out: List[Dict[str, Any]] = []
    for slug, ver in sorted(latest.items()):
        vtext = ".".join(map(str, ver))
        pairs = [(c, k) for s, v, c, k in rows if s == slug and v == vtext]
        sev: Dict[str, str] = {}
        vrow = (await session.exec(select(EvalDatasetVersion).join(EvalDataset, EvalDataset.id == EvalDatasetVersion.dataset_id).where(EvalDataset.slug == slug, EvalDatasetVersion.version == vtext))).first()
        if vrow is not None:
            for case_key, severity in (await session.exec(select(EvalVersionCase.case_key, EvalVersionCase.severity).where(EvalVersionCase.version_id == vrow.id))).all():
                sev[case_key] = severity or "medium"
        for d in cr.dependents(item_key, pairs, sev):
            out.append({"dataset": slug, "version": vtext, "case_id": d["case_id"], "severity": d["severity"]})
    return out


async def record_config_change(session: AsyncSession, observation: Dict[str, Any], reading: Dict[str, Any], *, template_diff: Optional[List[dict]] = None,
                               template_title: Optional[str] = None, scan_id: str = "registry") -> Dict[str, Any]:
    """A change in the change registry becomes a review item that lists the cases depending on it. A template change also yields suggested cases."""
    from shared.evaluation import change_registry as cr
    deps = await dependents_of(session, observation["key"])
    finding = cr.change_finding(observation, reading, [{"case_id": d["case_id"], "severity": d["severity"]} for d in deps])
    if finding is None:
        return {"recorded": False}
    now = datetime.utcnow()
    finding["detail"]["datasets"] = sorted({f"{d['dataset']} {d['version']}" for d in deps})
    item, outcome = await upsert(session, finding, dataset_slug=None, scan_id=scan_id, now=now)
    proposals = 0
    if observation["type"] == "template" and template_diff:
        content = (observation.get("summary") or {}).get("content")
        key = observation["key"].split(":", 1)[1]
        for p in drift.template_proposals(key, template_title or key, reading["version"], template_diff, content):
            await upsert(session, _proposal_finding(p), dataset_slug=None, scan_id=scan_id, now=now)
            proposals += 1
    return {"recorded": True, "item_id": str(item.id), "outcome": outcome, "affected_cases": len(finding["affected_cases"]), "suggestions": proposals}


async def transition(session: AsyncSession, item: EvalDriftItem, action: str, *, actor_id: UUID, note: Optional[str], expected: Optional[dict] = None) -> EvalDriftItem:
    """A person's decision. The review rules are checked here (shared/evaluation/drift.advance) and again by the database."""
    if action not in ACTIONS:
        raise HTTPException(422, f"Unknown action '{action}'.")
    to = ACTIONS[action]
    try:
        moved = drift.advance({**_view(item), "kind": item.kind if item.kind != "proposal" else "proposal"}, to, actor=str(actor_id), note=note, expected=expected)
    except drift.DriftError as exc:
        raise HTTPException(422, str(exc))
    frm = item.state
    item.state = to
    now = datetime.utcnow()
    if to in DRIFT_DECIDED:
        item.decided_by, item.decided_at, item.decision_note = actor_id, now, (note or "").strip()
        if expected:
            item.expected, item.expected_source = expected, "reviewer"
    elif to == "open":
        item.decided_by = item.decided_at = item.decision_note = None
        item.expected = item.expected_source = None
    if to == "in_review":
        item.assigned_to = actor_id
    session.add(item)
    await _event(session, item, frm, to, actor_id=actor_id, note=note, data={"expected": expected} if expected else {})
    await session.flush()
    return item


async def overview(session: AsyncSession) -> Dict[str, Any]:
    by_state = dict((await session.exec(select(EvalDriftItem.state, func.count()).group_by(EvalDriftItem.state))).all())
    open_ = (await session.exec(select(EvalDriftItem.kind, EvalDriftItem.severity, func.count()).where(EvalDriftItem.state.in_(["open", "in_review"])).group_by(EvalDriftItem.kind, EvalDriftItem.severity))).all()
    by_kind: Dict[str, int] = {}
    by_sev: Dict[str, int] = {}
    for kind, sev, n in open_:
        by_kind[kind], by_sev[sev] = by_kind.get(kind, 0) + n, by_sev.get(sev, 0) + n
    last = (await session.exec(select(EvalDriftScan).order_by(EvalDriftScan.created_at.desc()).limit(1))).first()
    oldest = (await session.exec(select(func.min(EvalDriftItem.opened_at)).where(EvalDriftItem.state.in_(["open", "in_review"])))).one()
    return {"by_state": by_state, "open": by_state.get("open", 0) + by_state.get("in_review", 0), "open_by_kind": by_kind, "open_by_severity": by_sev,
            "last_scan": {"scan_id": last.scan_id, "at": last.created_at, "dataset": last.dataset_slug, "version": last.dataset_version, "counts": last.counts,
                          "coverage": (last.summary or {}).get("coverage")} if last else None, "oldest_open_since": oldest}


async def _template_changes(session: AsyncSession, obs: Dict[str, Any], reading: Dict[str, Any]) -> List[Dict[str, Any]]:
    """What a template change did, in the template editor's own terms (sections and fields added, removed, reworded), from the two recorded versions."""
    from shared import doc_templates as dt
    from shared.models.evaluation import EvalRegistryItem, EvalRegistryVersion
    item = (await session.exec(select(EvalRegistryItem).where(EvalRegistryItem.item_key == obs["key"]))).first()
    if item is None:
        return []
    old = (await session.exec(select(EvalRegistryVersion).where(EvalRegistryVersion.item_id == item.id, EvalRegistryVersion.version == reading["version"] - 1))).first()
    before = ((old.summary or {}).get("content") if old else None) or {}
    return dt.diff(before, (obs.get("summary") or {}).get("content") or {})


async def scan_registry(session: AsyncSession, *, captured_from: str = "scan", observations: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Read every watched item, record the versions that changed, and open a review item for each change. Commit is the caller's."""
    from services import eval_registry
    results = await eval_registry.snapshot(session, captured_from=captured_from, observations=observations)
    counts = {"new": 0, "unchanged": 0, "changed": 0}
    recorded: List[Dict[str, Any]] = []
    for r in results:
        obs, reading = r["observation"], r["reading"]
        counts[reading["status"]] += 1
        if reading["status"] == "changed":
            changes = await _template_changes(session, obs, reading) if obs["type"] == "template" else None
            out = await record_config_change(session, obs, reading, template_diff=changes, template_title=obs["title"], scan_id=f"registry-{captured_from}")
            recorded.append({"item": obs["key"], "version": reading["version"], **out})
    return {"watched": len(results), **counts, "recorded": recorded}
