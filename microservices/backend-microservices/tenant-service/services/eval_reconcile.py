"""Provider billing reconciliation in the platform: statements typed in by a person, compared with the cost lines of their period.

The arithmetic is shared/evaluation/reconcile.py; this module supplies its inputs. A statement is append-only, and so is every reconciliation: the live
comparison is always recomputed from the lines, and the reconciliation table records who looked at it and what they wrote.

  statements   one provider and period each (inclusive dates, UTC); two active statements of the same provider may not overlap, so a bill cannot be counted
               twice. A correction is a new statement that names the one it replaces.
  recorded     the sum of the provider's cost lines whose cost was incurred in the period; lines that could not be priced are counted, never summed as 0
  certainty    confirmed (inside a period that matches its statement right now) / estimated / unknown, for any window
"""
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import case, func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import reconcile as rc
from shared.models.evaluation import EvalCostLine, EvalProviderStatement, EvalReconciliation

PROVIDERS = ("openai", "anthropic", "gemini")
SCOPE_NOTE = ("Enter what the provider billed for the API key or project that evaluations use. A key that other callers also use will always show more billed than was "
              "recorded, and that difference is not a missing attribution.")


def provider_expr():
    """The provider of a cost line: the stored one, or, for lines written before the provider was read from a `provider/model` label (the judge's name), the one in the label.
    Lines are append-only, so the old ones are read this way instead of being rewritten."""
    m = EvalCostLine.model
    return func.coalesce(EvalCostLine.provider, case((m.like("openai/%"), "openai"), (m.like("anthropic/%"), "anthropic"), (m.like("gemini/%"), "gemini"), (m.like("google/%"), "gemini"), else_=None))


def period_of(start: date, end: date) -> tuple:
    """Inclusive dates -> the moments they cover (UTC)."""
    return datetime.combine(start, time.min), datetime.combine(end, time.max)


async def recorded(session: AsyncSession, provider: str, start: datetime, end: datetime) -> Dict[str, Any]:
    """What the cost lines say for this provider in this period."""
    where = (provider_expr() == provider, EvalCostLine.incurred_at >= start, EvalCostLine.incurred_at <= end)
    usd, lines, unknown = (await session.exec(select(func.coalesce(func.sum(EvalCostLine.usd), 0.0), func.count(), func.count().filter(EvalCostLine.usd == None)).where(*where))).one()   # noqa: E711
    tokens = (await session.exec(select(func.coalesce(func.sum(EvalCostLine.input_units), 0), func.coalesce(func.sum(EvalCostLine.output_units), 0), func.coalesce(func.sum(EvalCostLine.cached_units), 0))
                                 .where(*where, EvalCostLine.unit_kind == "tokens"))).one()
    comps = (await session.exec(select(EvalCostLine.component, func.coalesce(func.sum(EvalCostLine.usd), 0.0), func.count()).where(*where).group_by(EvalCostLine.component))).all()
    runs = (await session.exec(select(EvalCostLine.run_id, func.coalesce(func.sum(EvalCostLine.usd), 0.0)).where(*where).group_by(EvalCostLine.run_id)
                               .order_by(func.coalesce(func.sum(EvalCostLine.usd), 0.0).desc()).limit(10))).all()
    return {"usd": float(usd or 0.0), "lines": int(lines), "unknown_lines": int(unknown), "tokens": {"input": int(tokens[0]), "output": int(tokens[1]), "cached": int(tokens[2])},
            "by_component": {c: {"usd": float(u), "lines": int(n)} for c, u, n in comps}, "top_runs": [{"run_id": r, "usd": float(u)} for r, u in runs if u]}


def _out(st: EvalProviderStatement) -> Dict[str, Any]:
    return {"id": str(st.id), "provider": st.provider, "period_start": st.period_start.date().isoformat(), "period_end": st.period_end.date().isoformat(), "billed_usd": st.billed_usd,
            "reference": st.reference, "source": st.source, "billed_tokens": {"input": st.billed_input_tokens, "output": st.billed_output_tokens, "cached": st.billed_cached_tokens},
            "tolerance_pct": st.tolerance_pct, "tolerance_usd": st.tolerance_usd, "supersedes_id": str(st.supersedes_id) if st.supersedes_id else None, "entered_by": str(st.entered_by),
            "created_at": st.created_at}


async def superseded_ids(session: AsyncSession) -> set:
    return {i for i in (await session.exec(select(EvalProviderStatement.supersedes_id).where(EvalProviderStatement.supersedes_id != None))).all()}   # noqa: E711


async def compare(session: AsyncSession, st: EvalProviderStatement) -> Dict[str, Any]:
    """The live comparison of a statement with the lines of its period (recomputed every time: new lines change it)."""
    rec = await recorded(session, st.provider, st.period_start, st.period_end)
    verdict = rc.compare(billed_usd=st.billed_usd, recorded_usd=rec["usd"], unknown_lines=rec["unknown_lines"], line_count=rec["lines"], tolerance_pct=st.tolerance_pct, tolerance_usd=st.tolerance_usd,
                         billed_tokens={"input": st.billed_input_tokens, "output": st.billed_output_tokens, "cached": st.billed_cached_tokens}, recorded_tokens=rec["tokens"])
    return {**verdict, "recorded": rec}


async def list_statements(session: AsyncSession, provider: Optional[str] = None) -> List[Dict[str, Any]]:
    stmt = select(EvalProviderStatement).order_by(EvalProviderStatement.period_start.desc(), EvalProviderStatement.created_at.desc())
    if provider:
        stmt = stmt.where(EvalProviderStatement.provider == provider)
    gone = await superseded_ids(session)
    out = []
    for st in (await session.exec(stmt)).all():
        last = (await session.exec(select(EvalReconciliation).where(EvalReconciliation.statement_id == st.id).order_by(EvalReconciliation.created_at.desc()).limit(1))).first()
        item = {**_out(st), "superseded": st.id in gone, "last_reconciliation": None if last is None else {"id": str(last.id), "status": last.status, "at": last.created_at, "by": str(last.performed_by),
                                                                                                       "note": last.note, "recorded_usd": last.recorded_usd, "difference_usd": last.difference_usd}}
        item["live"] = None if st.id in gone else await compare(session, st)
        out.append(item)
    return out


async def create_statement(session: AsyncSession, *, actor_id: UUID, provider: str, period_start: date, period_end: date, billed_usd: float, reference: Optional[str], source: str,
                           billed_tokens: Optional[Dict[str, Optional[int]]] = None, tolerance_pct: float = rc.DEFAULT_TOLERANCE_PCT, tolerance_usd: float = rc.DEFAULT_TOLERANCE_USD,
                           supersedes_id: Optional[UUID] = None, note: Optional[str] = None) -> Dict[str, Any]:
    if provider not in PROVIDERS:
        raise HTTPException(422, f"provider is one of {', '.join(PROVIDERS)}")
    if period_end < period_start:
        raise HTTPException(422, "The period cannot end before it starts.")
    if period_end > datetime.utcnow().date():
        raise HTTPException(422, "A statement cannot cover days that have not happened yet.")
    if not source.strip():
        raise HTTPException(422, "Say where the figure came from (for example: typed from the OpenAI usage page, project 'evaluation').")
    start, end = period_of(period_start, period_end)
    replaced: Optional[EvalProviderStatement] = None
    if supersedes_id is not None:
        replaced = await session.get(EvalProviderStatement, supersedes_id)
        if replaced is None or replaced.provider != provider:
            raise HTTPException(422, "The statement to replace does not exist for this provider.")
        if replaced.id in await superseded_ids(session):
            raise HTTPException(409, "That statement has already been replaced by a later one.")
    gone = await superseded_ids(session)
    for other in (await session.exec(select(EvalProviderStatement).where(EvalProviderStatement.provider == provider))).all():
        if other.id in gone or (replaced is not None and other.id == replaced.id):
            continue
        if rc.overlaps(start, end, other.period_start, other.period_end):
            raise HTTPException(409, detail={"message": f"A statement for {provider} already covers part of this period "
                                                        f"({other.period_start.date()} to {other.period_end.date()}, ${other.billed_usd:.2f}). Counting both would count one bill twice. "
                                                        "To correct it, replace that statement instead.", "conflicts_with": str(other.id)})
    st = EvalProviderStatement(provider=provider, period_start=start, period_end=end, billed_usd=billed_usd, reference=(reference or None), source=source.strip(),
                               billed_input_tokens=(billed_tokens or {}).get("input"), billed_output_tokens=(billed_tokens or {}).get("output"), billed_cached_tokens=(billed_tokens or {}).get("cached"),
                               tolerance_pct=tolerance_pct, tolerance_usd=tolerance_usd, supersedes_id=supersedes_id, entered_by=actor_id)
    session.add(st)
    await session.flush()
    first = await reconcile(session, st, actor_id=actor_id, note=note)
    return {"statement": _out(st), "reconciliation": first, "scope_note": SCOPE_NOTE}


async def reconcile(session: AsyncSession, st: EvalProviderStatement, *, actor_id: UUID, note: Optional[str] = None) -> Dict[str, Any]:
    """Compare now, and keep what was compared, who asked, and what they said about it."""
    if st.id in await superseded_ids(session):
        raise HTTPException(409, "That statement has been replaced by a later one; reconcile the later one.")
    live = await compare(session, st)
    row = EvalReconciliation(statement_id=st.id, status=live["status"], billed_usd=live["billed_usd"], recorded_usd=live["recorded_usd"], difference_usd=live["difference_usd"],
                             difference_pct=live["difference_pct"], unknown_lines=live["unknown_lines"], line_count=live["line_count"], note=(note or "").strip() or None,
                             detail={"tokens": live["tokens"], "explanation": live["explanation"], "by_component": live["recorded"]["by_component"], "top_runs": live["recorded"]["top_runs"],
                                     "tolerance_pct": live["tolerance_pct"], "tolerance_usd": live["tolerance_usd"], "allowed_usd": live["allowed_usd"]}, performed_by=actor_id)
    session.add(row)
    await session.flush()
    return {"id": str(row.id), **live, "note": row.note, "at": row.created_at}


async def matched_periods(session: AsyncSession) -> List[Dict[str, Any]]:
    gone = await superseded_ids(session)
    out = []
    for st in (await session.exec(select(EvalProviderStatement))).all():
        if st.id in gone:
            continue
        if (await compare(session, st))["status"] == "matched":
            out.append({"provider": st.provider, "start": st.period_start, "end": st.period_end, "statement_id": str(st.id), "billed_usd": st.billed_usd})
    return out


async def certainty(session: AsyncSession, start: datetime, end: datetime) -> Dict[str, Any]:
    """How sure the money in a window is: confirmed (inside a period that matches its provider's statement right now), estimated, or unknown (could not be priced)."""
    where = (EvalCostLine.incurred_at >= start, EvalCostLine.incurred_at <= end)
    by_provider: Dict[str, Dict[str, Any]] = {}
    prov = provider_expr()
    rows = (await session.exec(select(prov, func.coalesce(func.sum(EvalCostLine.usd), 0.0), func.count(), func.count().filter(EvalCostLine.usd == None)).where(*where).group_by(prov))).all()   # noqa: E711
    for provider, usd, n, unknown in rows:
        by_provider[provider or "unknown"] = {"total_usd": float(usd), "lines": int(n), "unknown_lines": int(unknown), "confirmed_usd": 0.0, "estimated_usd": float(usd)}
    covering = []
    for p in await matched_periods(session):
        lo, hi = max(start, p["start"]), min(end, p["end"])
        if lo > hi:
            continue
        usd = float((await session.exec(select(func.coalesce(func.sum(EvalCostLine.usd), 0.0)).where(prov == p["provider"], EvalCostLine.incurred_at >= lo, EvalCostLine.incurred_at <= hi))).one())
        b = by_provider.setdefault(p["provider"], {"total_usd": 0.0, "lines": 0, "unknown_lines": 0, "confirmed_usd": 0.0, "estimated_usd": 0.0})
        b["confirmed_usd"] += usd
        b["estimated_usd"] -= usd
        covering.append({"statement_id": p["statement_id"], "provider": p["provider"], "period_start": p["start"].date().isoformat(), "period_end": p["end"].date().isoformat(), "billed_usd": p["billed_usd"]})
    totals = {k: round(sum(b[k] for b in by_provider.values()), 6) for k in ("total_usd", "confirmed_usd", "estimated_usd")}
    totals["unknown_lines"] = sum(b["unknown_lines"] for b in by_provider.values())
    for b in by_provider.values():
        b["estimated_usd"] = round(max(b["estimated_usd"], 0.0), 6)
        b["confirmed_usd"] = round(b["confirmed_usd"], 6)
    return {"from": start, "to": end, "totals": totals, "by_provider": by_provider, "confirmed_by": covering,
            "meaning": {"confirmed": "recorded amounts inside a period whose provider statement matches the recorded total", "estimated": "priced from recorded tokens and a recorded price, not matched to a statement",
                        "unknown": "used but not priced: the cost is in no total"}}
