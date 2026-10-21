"""Synthetic PostgreSQL benchmark; creates and drops only its own random schema.

Run: IDEMPOTENCY_TEST_DATABASE_URL=... python -m shared.idempotency.benchmark
Counts SQL statements, excluding driver transaction/pool commands. No production data.
"""
import asyncio
import json
import os
import statistics
import time
from uuid import uuid4

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import create_async_engine
from .core import reserve, complete, fingerprint, IdempotencyError
from .models import metadata


async def main(samples=200):
    schema = 'idem_bench_' + uuid4().hex
    url = os.environ['IDEMPOTENCY_TEST_DATABASE_URL']
    admin = create_async_engine(url)
    engine = create_async_engine(url, pool_size=10, max_overflow=0,
        connect_args={'server_settings': {'search_path': schema}})
    queries = [0]
    @event.listens_for(engine.sync_engine, 'before_cursor_execute')
    def count(*args):
        queries[0] += 1
    report = {'samples': samples, 'concurrency': 1, 'sql_count_excludes': 'transaction and pool commands'}
    async with admin.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA {schema}'))
    try:
        async with engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
            await conn.execute(text('CREATE TABLE business (id UUID PRIMARY KEY)'))
            await conn.execute(text('CREATE TABLE outbox (id UUID PRIMARY KEY)'))
        digest = fingerprint({'amount': 10}, actor_id='benchmark')
        async def operation(kind, key):
            async with engine.begin() as conn:
                reservation = None
                if kind != 'baseline':
                    reservation = await reserve(conn, scope_id='benchmark', operation='payment', key=key, request_hash=digest)
                    if reservation.replay:
                        return
                rid = uuid4()
                await conn.execute(text('INSERT INTO business VALUES (:id)'), {'id': rid})
                await conn.execute(text('INSERT INTO outbox VALUES (:id)'), {'id': rid})
                if reservation:
                    await complete(conn, reservation, http_status=201, response={'id': str(rid)})
        await operation('protected', 'warmup-operation')
        for kind in ('baseline', 'protected', 'replay'):
            times = []
            queries[0] = 0
            start = time.perf_counter()
            for i in range(samples):
                t = time.perf_counter()
                await operation(kind, f'operation-{i:08}' if kind != 'replay' else 'warmup-operation')
                times.append((time.perf_counter() - t) * 1000)
            elapsed = time.perf_counter() - start
            report[kind] = {'p50_ms': round(statistics.median(times), 3),
                'p95_ms': round(sorted(times)[int(samples * .95) - 1], 3),
                'operations_per_second': round(samples / elapsed, 1),
                'sql_statements_per_operation': queries[0] / samples}
        # Keep the winning transaction uncommitted while contenders try the same key.
        async with engine.begin() as conn:
            await reserve(conn, scope_id='benchmark', operation='payment', key='contention-operation', request_hash=digest)
            async def contender():
                started = time.perf_counter()
                try:
                    await operation('protected', 'contention-operation')
                    return {'code': 'unexpected_success'}
                except IdempotencyError as exc:
                    return {'code': exc.code, 'ms': (time.perf_counter() - started) * 1000}
            outcomes = await asyncio.gather(*(contender() for _ in range(8)))
            report['contention'] = {'contenders': 8, 'processing_responses': sum(x['code'] == 'IDEMPOTENCY_PROCESSING' for x in outcomes),
                'max_ms': round(max(x.get('ms', 0) for x in outcomes), 3)}
        async with engine.connect() as conn:
            report['storage'] = dict((await conn.execute(text("SELECT count(*) AS records, round(avg(pg_column_size(r))) AS average_row_bytes, pg_total_relation_size('idempotency_records') AS table_and_indexes_bytes FROM idempotency_records r"))).mappings().one())
        print(json.dumps(report, indent=2, default=str))
    finally:
        await engine.dispose()
        async with admin.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        await admin.dispose()


if __name__ == '__main__':
    asyncio.run(main())
