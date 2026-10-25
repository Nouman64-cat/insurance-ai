"""Embedding calls are metered (Phase 7 gap 1): the spend of an embedding reaches the token ledger as an input-only row, is counted off the request thread, never blocks or breaks the
caller, and a call that cannot be counted is not recorded as zero.

Run: docker exec insurance-tenant-service python test_usage_meter_embedding.py
"""
import asyncio
import sys
import threading

from services import usage_meter

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def settle() -> None:
    while usage_meter._pending:
        await asyncio.gather(*list(usage_meter._pending))


async def main() -> int:
    written, threads = [], []
    original = usage_meter._write

    async def fake_write(row):
        written.append(row)
    usage_meter._write = fake_write
    try:
        def counter(model, contents):
            threads.append(threading.current_thread().name)
            return 19
        main_thread = threading.current_thread().name
        usage_meter.record_embedding(usage_meter.SERVICE_AGENT_COPILOT_EMBEDDINGS, "models/gemini-embedding-001", "some question", counter=counter)
        await settle()
        row = written[0] if written else {}
        check("an embedding call becomes one ledger row: the service, the model without its path, input tokens only", row.get("service_name") == "Agent Copilot (embeddings)" and row.get("model_name") == "gemini-embedding-001"
              and row.get("input_tokens") == 19 and row.get("output_tokens") == 0 and row.get("total_tokens") == 19 and row.get("cached_tokens") == 0, row)
        check("the tokens are counted in a worker thread, so the request that embedded is never held up", threads and threads[0] != main_thread, threads)
        written.clear()
        usage_meter.record_embedding("S", "gemini-embedding-001", "x", counter=lambda m, c: None)
        await settle()
        check("a call whose tokens cannot be counted is NOT recorded (never recorded as zero)", written == [])
        usage_meter.record_embedding("S", "gemini-embedding-001", "x", counter=lambda m, c: (_ for _ in ()).throw(RuntimeError("provider down")))
        await settle()
        check("a failing counter is swallowed: metering never breaks the call it measures", written == [])
        usage_meter.record_embedding("S", "gemini-embedding-001", "x", tenant_id="00000000-0000-0000-0000-000000000001", counter=lambda m, c: 5)
        await settle()
        check("a tenant is carried through when there is one", written and str(written[0]["tenant_id"]) == "00000000-0000-0000-0000-000000000001")
    finally:
        usage_meter._write = original
    # the real counter, against the real provider, when a key is configured
    import os
    if os.getenv("GEMINI_API_KEY"):
        n = await asyncio.to_thread(usage_meter._count_embedding_tokens, "gemini-embedding-001", "Form: Lead acquisition. Section: Identity & Contact")
        check("the provider's own token counter answers for the embedding model", isinstance(n, int) and n > 0, str(n))
    from shared.evaluation.pricing import cost_of
    c = cost_of({"model_name": "gemini-embedding-001", "input_tokens": 1_000_000, "output_tokens": 0, "cached_tokens": 0})
    check("an embedding has a price (per million input tokens), so its spend is a known amount", c is not None and abs(c - 0.15) < 1e-9, str(c))
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
