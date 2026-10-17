"""Live updates: what is announced, to whom, and that nothing is announced for what was already there."""
import json
from types import SimpleNamespace
from uuid import uuid4

from app.routers import live
from tests.support import Base


def parse(chunks):
    out = []
    for c in chunks:
        if c.startswith(":") or c.startswith("retry"):
            if "event:" not in c:
                continue
        for block in c.strip().split("\n\n"):
            lines = dict(l.split(": ", 1) for l in block.split("\n") if ": " in l and not l.startswith(":"))
            if "event" in lines:
                out.append((lines["event"], json.loads(lines["data"])))
    return out


class Live(Base):
    def principal(self):
        return SimpleNamespace(tenant_id=uuid4(), customer_id=uuid4(), display_name="Sana")

    async def run_stream(self, rounds_c, rounds_t):
        """Feed the stream one snapshot per round and return everything it announced."""
        cs, ts = iter(rounds_c), iter(rounds_t)
        last = {}

        async def claims(p):
            last["c"] = next(cs, last.get("c")); return last["c"]

        async def tickets(p):
            last["t"] = next(ts, last.get("t")); return last["t"]
        chunks = [c async for c in live.events(self.principal(), None, claims=claims, tickets=tickets, poll=0.05, max_seconds=0.05 * (len(rounds_c) + 0.5))]
        return parse(chunks), chunks

    async def test_nothing_is_announced_for_what_was_already_there(self):
        c = {"1": {"id": "1", "claim_number": "C-1", "status_key": "submitted", "last_update": "t1"}}
        t = {"9": {"id": "9", "title": "Q", "status": "OPEN", "updated_at": "t1"}}
        events, chunks = await self.run_stream([c, c, c], [t, t, t])
        self.assertEqual(events, [("ready", {"poll_seconds": 0.05})])
        self.assertTrue(chunks[0].startswith("retry:"))

    async def test_claim_and_ticket_changes_are_announced(self):
        c1 = {"1": {"id": "1", "claim_number": "C-1", "status_key": "submitted", "last_update": "t1", "approved_amount": None, "settled_amount": None}}
        c2 = {"1": {**c1["1"], "status_key": "documents_needed", "last_update": "t2"}}
        c3 = {"1": {**c2["1"], "status_key": "approved", "last_update": "t3", "approved_amount": 5000.0}}
        t1 = {"9": {"id": "9", "title": "Address", "status": "OPEN", "updated_at": "t1"}}
        t2 = {"9": {**t1["9"], "status": "IN_PROGRESS", "updated_at": "t2"}}
        t3 = {"9": {**t2["9"], "updated_at": "t3"}, "10": {"id": "10", "title": "New one", "status": "OPEN", "updated_at": "t3"}}
        events, _ = await self.run_stream([c1, c2, c3], [t1, t2, t3])
        got = [(e, d.get("kind"), d.get("status_key") or d.get("status")) for e, d in events if e != "ready"]
        self.assertEqual(got, [("claim", "status", "documents_needed"), ("ticket", "status", "IN_PROGRESS"),
                               ("claim", "status", "approved"), ("ticket", "update", "IN_PROGRESS"), ("ticket", "new", "OPEN")])
        self.assertEqual([d["previous"] for e, d in events if e == "claim"], ["submitted", "documents_needed"])
        self.assertEqual([d["approved_amount"] for e, d in events if e == "claim"][-1], 5000.0)

    async def test_an_upstream_failure_does_not_end_the_stream_or_invent_events(self):
        c = {"1": {"id": "1", "claim_number": "C-1", "status_key": "submitted", "last_update": "t1"}}
        calls = {"n": 0}

        async def claims(p):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("upstream down")
            return c

        async def tickets(p):
            return {}
        chunks = [x async for x in live.events(self.principal(), None, claims=claims, tickets=tickets, poll=0.03, max_seconds=0.2)]
        self.assertEqual([e for e, _ in parse(chunks) if e != "ready"], [])
        self.assertGreaterEqual(calls["n"], 3)                                 # it kept checking after the failure

    async def test_endpoint_needs_a_customer_session_and_sends_event_stream_headers(self):
        from app.config import settings
        self.assertEqual((await self.client.get("/v1/stream/events")).status_code, 401)
        token, _ = await self.active_session()
        self.fake.routes.update({"/claims": [], "/tickets": []})
        object.__setattr__(settings, "stream_max_seconds", 0.3); object.__setattr__(settings, "stream_poll_seconds", 0.1)
        try:
            async def no_tickets(p): return {}
            real = live._tickets; live._tickets = no_tickets
            try:
                r = await self.client.get("/v1/stream/events", headers=self.bearer(token))
            finally:
                live._tickets = real
        finally:
            object.__setattr__(settings, "stream_max_seconds", 600.0); object.__setattr__(settings, "stream_poll_seconds", 5.0)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/event-stream"))
        self.assertIn("event: ready", r.text)
