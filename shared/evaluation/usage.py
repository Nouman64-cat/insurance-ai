"""Attribution of model usage to one evaluation execution, from the token ledger.

The services that call a model write a ledger row *after* they reply (a background task), so for the measurement of one case:
  * the row may arrive late (after the reply, sometimes after the caller has stopped looking);
  * it may never arrive (the poster failed, the secret was wrong, the ledger was unreachable);
  * the ledger itself may be unreadable.
None of those may become "this case cost nothing". The result says what is known and what is not:

  status "attributed"   the ledger shows at least the calls the reply proves were made, and has been quiet since
  status "missing"      the reply proves a model was called (it reported tokens) but the ledger has fewer rows than that:
                        the cost is unknown; the tokens the reply itself reported are kept, labelled as such
  status "unavailable"  the ledger could not be read: nothing is known, `calls` is None
  status "ambiguous"    another execution was measuring at the same time, so the rows cannot be told apart

`calls` is only a number when it is known. A late row found by `reconcile()` is added and marked `late`, never dropped.
Executions are measured one at a time per ledger: `begin` refuses while another window is open. The evaluation database holds
nothing else, and it is reset between executions, so a window's rows are exactly the rows that appeared during it.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

LedgerFetch = Callable[[], Awaitable[Sequence[Dict[str, Any]]]]     # every ledger row: id, service_name, model_name, *_tokens, created_at


class OverlappingExecution(RuntimeError):
    """A second execution tried to measure while one was already being measured."""


@dataclass
class Mark:
    execution_id: str
    started_at: float
    known_ids: frozenset
    readable: bool = True
    match: Optional[Any] = None              # which ledger rows belong to this execution (its thread id); kept so a failed execution can still be read afterwards


@dataclass
class UsageResult:
    execution_id: str
    status: str                                   # attributed | missing | unavailable | ambiguous
    calls: Optional[int]                          # None unless known
    rows: List[Dict[str, Any]] = field(default_factory=list)
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cached_tokens: Optional[int] = None
    by_model: Dict[str, Dict[str, int]] = field(default_factory=dict)
    by_service: Dict[str, Dict[str, Dict[str, int]]] = field(default_factory=dict)   # service -> model -> calls and tokens: which part of the application made the calls
    foreign: Dict[str, Any] = field(default_factory=dict)                            # rows seen in the window that carry another thread id: counted as spend, never as this reply's own calls
    reported_tokens: Optional[Dict[str, Any]] = None   # what the service's own reply said it used: a fallback, never the ledger's figure
    late_rows: List[Dict[str, Any]] = field(default_factory=list)
    waited_seconds: float = 0.0
    note: str = ""

    @property
    def known(self) -> bool:
        return self.calls is not None

    def as_dict(self) -> Dict[str, Any]:
        out = {"execution_id": self.execution_id, "status": self.status, "calls": self.calls, "input_tokens": self.input_tokens,
               "output_tokens": self.output_tokens, "cached_tokens": self.cached_tokens, "by_model": self.by_model, "by_service": self.by_service,
               "reported_tokens": self.reported_tokens, "late_rows": len(self.late_rows), "waited_seconds": round(self.waited_seconds, 2),
               "note": self.note}
        if self.foreign:
            out["foreign"] = self.foreign
        return out


def _tokens(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "by_model": {}, "by_service": {}}
    for r in rows:
        for key in ("input_tokens", "output_tokens", "cached_tokens"):
            out[key] += int(r.get(key) or 0)
        model = r.get("model_name") or "unknown"
        for bucket in (out["by_model"].setdefault(model, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0}),
                       out["by_service"].setdefault(r.get("service_name") or "unknown", {}).setdefault(model, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0})):
            bucket["calls"] += 1
            bucket["input_tokens"] += int(r.get("input_tokens") or 0)
            bucket["output_tokens"] += int(r.get("output_tokens") or 0)
            bucket["cached_tokens"] += int(r.get("cached_tokens") or 0)
    return out


def _foreign(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Rows that appeared during an execution but belong to another thread (a late row of an earlier execution, or a call that carries no thread id, such as a
    conversation title). They are real spend, so their tokens are kept; they are never counted as this reply's own calls."""
    if not rows:
        return {}
    t = _tokens(rows)
    return {"rows": len(rows), "input_tokens": t["input_tokens"], "output_tokens": t["output_tokens"], "cached_tokens": t["cached_tokens"], "by_model": t["by_model"], "by_service": t["by_service"]}


class UsageMeter:
    """Measures the model calls one execution caused. One meter per ledger."""

    def __init__(self, fetch: LedgerFetch, *, poll_seconds: float = 0.2, quiet_seconds: float = 0.6, max_wait_seconds: float = 8.0):
        self._fetch = fetch
        self._poll, self._quiet, self._max = poll_seconds, quiet_seconds, max_wait_seconds
        self._open: Optional[str] = None
        self._mark: Optional[Mark] = None
        self._abandoned: Optional[Mark] = None

    async def _rows(self) -> Optional[Sequence[Dict[str, Any]]]:
        try:
            return await self._fetch()
        except Exception:                          # noqa: BLE001 — an unreadable ledger is a result (unavailable), not a crash
            return None

    async def begin(self, execution_id: str, *, match: Optional[Any] = None) -> Mark:
        if self._open is not None:
            raise OverlappingExecution(f"execution {self._open!r} is still being measured; measure one execution at a time")
        self._open = execution_id
        rows = await self._rows()
        self._mark = Mark(execution_id=execution_id, started_at=time.monotonic(), known_ids=frozenset(str(r["id"]) for r in rows or ()), readable=rows is not None, match=match)
        self._abandoned = None
        return self._mark

    def abandon(self) -> None:
        """Close the open window without a result (the call itself failed). What the failed execution had already asked of a model was still paid for:
        `settle_abandoned` reads it, and the runner must call it before the next execution starts."""
        self._abandoned = self._mark if self._open is not None else self._abandoned
        self._open = None

    async def settle_abandoned(self) -> Optional["UsageResult"]:
        """The ledger rows of the execution whose window was abandoned, or None when no window was abandoned. Read once, then forgotten."""
        mark, self._abandoned = self._abandoned, None
        if mark is None or self._open is not None:
            return None
        self._open = mark.execution_id
        return await self.end(mark, match=mark.match)

    async def end(self, mark: Mark, *, expected_min_calls: int = 0, reported_tokens: Optional[Dict[str, Any]] = None,
                  ambiguous: bool = False, match: Optional[Any] = None) -> UsageResult:
        """Wait for the ledger to settle, then say what the execution used. `expected_min_calls` is what the caller already
        knows must have happened (a reply that read a document proves at least one call); 0 means "none is proven".
        `match(row) -> bool` keeps only the rows that belong to this execution (a chat thread's rows, by thread id); rows that appeared in
        the window but do not match are reported in the note (they are another execution's, never counted here)."""
        match = match if match is not None else mark.match
        try:
            if ambiguous:
                return UsageResult(mark.execution_id, "ambiguous", None, reported_tokens=reported_tokens,
                                   note="another execution was measuring at the same time")
            if not mark.readable:
                return UsageResult(mark.execution_id, "unavailable", None, reported_tokens=reported_tokens,
                                   note="the ledger could not be read before the call")
            waited, last_change, last_count = 0.0, 0.0, -1
            rows: Sequence[Dict[str, Any]] = ()
            while True:
                current = await self._rows()
                if current is None:
                    return UsageResult(mark.execution_id, "unavailable", None, reported_tokens=reported_tokens, waited_seconds=waited,
                                       note="the ledger could not be read after the call")
                rows = [r for r in current if str(r["id"]) not in mark.known_ids]
                foreign_rows: List[Dict[str, Any]] = []
                if match is not None:
                    matched = [r for r in rows if match(r)]
                    foreign_rows = [r for r in rows if r not in matched]
                    rows = matched
                foreign = len(foreign_rows)
                if len(rows) != last_count:
                    last_count, last_change = len(rows), waited
                enough = len(rows) >= expected_min_calls
                if enough and waited - last_change >= self._quiet:
                    break                          # has what is proven, and nothing has arrived for a while
                if waited >= self._max:
                    break
                await asyncio.sleep(self._poll)
                waited += self._poll
            if len(rows) < expected_min_calls:
                return UsageResult(mark.execution_id, "missing", None, rows=list(rows), reported_tokens=reported_tokens, waited_seconds=waited,
                                   foreign=_foreign(foreign_rows), note=f"the reply proves {expected_min_calls} call(s) but the ledger shows {len(rows)}: cost unknown")
            return UsageResult(mark.execution_id, "attributed", len(rows), rows=list(rows), reported_tokens=reported_tokens, foreign=_foreign(foreign_rows),
                               waited_seconds=waited, note=(f"{foreign} ledger row(s) in the window carry another thread id: counted as spend, not as this reply's calls" if foreign else ""),
                               **_tokens(rows))
        finally:
            self._open = None

    async def reconcile(self, mark: Mark, result: UsageResult) -> UsageResult:
        """Look again later. Rows that arrived after `end` are added and marked late, so cost is never lost. Returns a NEW
        result: the verdict that was reported at the time stays as it was."""
        rows = await self._rows()
        if rows is None:
            return result
        seen = {str(r["id"]) for r in result.rows}
        late = [r for r in rows if str(r["id"]) not in mark.known_ids and str(r["id"]) not in seen]
        if not late:
            return result
        merged = result.rows + late
        return replace(result, status="attributed", calls=len(merged), rows=merged, late_rows=result.late_rows + late,
                       note=(result.note + " " if result.note else "") + f"{len(late)} row(s) arrived after the call returned", **_tokens(merged))
