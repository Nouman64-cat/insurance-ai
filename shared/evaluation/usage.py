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
    reported_tokens: Optional[Dict[str, Any]] = None   # what the service's own reply said it used: a fallback, never the ledger's figure
    late_rows: List[Dict[str, Any]] = field(default_factory=list)
    waited_seconds: float = 0.0
    note: str = ""

    @property
    def known(self) -> bool:
        return self.calls is not None

    def as_dict(self) -> Dict[str, Any]:
        return {"execution_id": self.execution_id, "status": self.status, "calls": self.calls, "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens, "cached_tokens": self.cached_tokens, "by_model": self.by_model,
                "reported_tokens": self.reported_tokens, "late_rows": len(self.late_rows), "waited_seconds": round(self.waited_seconds, 2),
                "note": self.note}


def _tokens(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "by_model": {}}
    for r in rows:
        for key in ("input_tokens", "output_tokens", "cached_tokens"):
            out[key] += int(r.get(key) or 0)
        m = out["by_model"].setdefault(r.get("model_name") or "unknown", {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0})
        m["calls"] += 1
        m["input_tokens"] += int(r.get("input_tokens") or 0)
        m["output_tokens"] += int(r.get("output_tokens") or 0)
        m["cached_tokens"] += int(r.get("cached_tokens") or 0)
    return out


class UsageMeter:
    """Measures the model calls one execution caused. One meter per ledger."""

    def __init__(self, fetch: LedgerFetch, *, poll_seconds: float = 0.2, quiet_seconds: float = 0.6, max_wait_seconds: float = 8.0):
        self._fetch = fetch
        self._poll, self._quiet, self._max = poll_seconds, quiet_seconds, max_wait_seconds
        self._open: Optional[str] = None

    async def _rows(self) -> Optional[Sequence[Dict[str, Any]]]:
        try:
            return await self._fetch()
        except Exception:                          # noqa: BLE001 — an unreadable ledger is a result (unavailable), not a crash
            return None

    async def begin(self, execution_id: str) -> Mark:
        if self._open is not None:
            raise OverlappingExecution(f"execution {self._open!r} is still being measured; measure one execution at a time")
        self._open = execution_id
        rows = await self._rows()
        return Mark(execution_id=execution_id, started_at=time.monotonic(), known_ids=frozenset(str(r["id"]) for r in rows or ()),
                    readable=rows is not None)

    def abandon(self) -> None:
        """Close the open window without a result (the call itself failed before there was anything to measure)."""
        self._open = None

    async def end(self, mark: Mark, *, expected_min_calls: int = 0, reported_tokens: Optional[Dict[str, Any]] = None,
                  ambiguous: bool = False, match: Optional[Any] = None) -> UsageResult:
        """Wait for the ledger to settle, then say what the execution used. `expected_min_calls` is what the caller already
        knows must have happened (a reply that read a document proves at least one call); 0 means "none is proven".
        `match(row) -> bool` keeps only the rows that belong to this execution (a chat thread's rows, by thread id); rows that appeared in
        the window but do not match are reported in the note (they are another execution's, never counted here)."""
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
                foreign = 0
                if match is not None:
                    foreign = len(rows)
                    rows = [r for r in rows if match(r)]
                    foreign -= len(rows)
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
                                   note=f"the reply proves {expected_min_calls} call(s) but the ledger shows {len(rows)}: cost unknown")
            return UsageResult(mark.execution_id, "attributed", len(rows), rows=list(rows), reported_tokens=reported_tokens,
                               waited_seconds=waited, note=(f"{foreign} ledger row(s) in the window belong to other executions and are not counted" if foreign else ""),
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
