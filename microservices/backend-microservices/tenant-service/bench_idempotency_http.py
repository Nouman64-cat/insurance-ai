"""HTTP-level cost of idempotency on real PostgreSQL (random schema, synthetic data; nothing else is touched).

Run inside tenant-service:  IDEMPOTENCY_TEST_DATABASE_URL=... python bench_idempotency_http.py
Compares three paths of the same endpoints: unkeyed (the original path), keyed first call, keyed replay.
Sequential requests through the ASGI app, so the numbers isolate server-side work (no network)."""
import asyncio
import json
import statistics
import time
import unittest
from unittest.mock import AsyncMock, patch

from idem_testkit import RouteCase
from routers import post_issuance
from shared.models.core import PolicyStatusEnum

SAMPLES = 150


def summary(times):
    ordered = sorted(times)
    return {'p50_ms': round(statistics.median(times), 2), 'p95_ms': round(ordered[int(len(ordered) * 0.95) - 1], 2), 'mean_ms': round(statistics.mean(times), 2)}


class Bench(RouteCase):
    routers = (post_issuance,)

    async def test_report(self):
        p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, policy_number='POL-BENCH')
        url = self.base(p.policy_id) + '/premiums/autopay'
        report = {'samples': SAMPLES, 'endpoint': 'POST /premiums/autopay (ledger write + billing view)'}
        async with self.client() as c:
            for _ in range(10):
                await c.post(url, json={'enabled': True}, headers=self.headers())
            for name in ('unkeyed', 'keyed_first_call', 'keyed_replay'):
                times = []
                for i in range(SAMPLES):
                    headers = self.headers() if name == 'unkeyed' else self.headers(f'bench-operation-{i:06d}' if name == 'keyed_first_call' else 'bench-operation-replay')
                    body = {'enabled': i % 2 == 0}
                    if name == 'keyed_replay':
                        body = {'enabled': True}
                        if i == 0:
                            await c.post(url, json=body, headers=headers)
                    t = time.perf_counter()
                    r = await c.post(url, json=body, headers=headers)
                    times.append((time.perf_counter() - t) * 1000)
                    assert r.status_code == 200, r.text
                report[name] = summary(times)
        base = report['unkeyed']
        report['overhead_vs_unkeyed'] = {k: {m: round(report[k][m] - base[m], 2) for m in ('p50_ms', 'p95_ms')} for k in ('keyed_first_call', 'keyed_replay')}
        print('\nBENCHMARK ' + json.dumps(report))


if __name__ == '__main__':
    unittest.main()
