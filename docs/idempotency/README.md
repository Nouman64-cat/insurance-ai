# Idempotency implementation and rollout

This is an **in-progress integration**, not system-wide enforcement. The shared
framework and selected financial/request paths are implemented. Do not enable
required headers globally until the remaining callers and operations are reviewed.
The generated [coverage inventory](coverage.json) enumerates 473 HTTP mutation
handlers; router mount prefixes may apply. `PENDING_REVIEW` means no claim of
coverage, even where the scanner finds an existing protection. Regenerate with
`python scripts/idempotency/inventory.py`. Non-HTTP workers need separate review.

## Operation identity and API contract

Clients create an operation ID for an intended action and send it exclusively as
`Idempotency-Key`. Retry the same operation with the same key; new actions get new
keys even with identical data. The shared validator accepts 8–128 ASCII letters,
digits, periods, underscores, colons and hyphens; the first character must be
alphanumeric. Duplicate headers are invalid. Never derive operation identity from
payload equality, a token suffix or current time at each network attempt.

The tenant, operation name and key form the durable unique identity. The fingerprint
includes authenticated actor and normalized request content, with HTTP path/query
parameters. Only the fingerprint, approved response receipt and operational metadata
are stored. Never put credentials, raw medical records, payment links or arbitrary
exception messages in the receipt.

`IDEMPOTENCY_ENFORCEMENT=optional` (default) preserves unkeyed callers on opt-in
HTTP adapters. Supplied keys are always validated. `required` rejects missing keys
with 400. This setting does **not** protect handlers without an adapter. Customer
service ticket creation already requires the header; deploy its callers together.
Completed retries return the original successful status and approved body with
`Idempotency-Replayed: true`. Payload conflicts return 409. Concurrent processing
returns 409 `IDEMPOTENCY_PROCESSING` and `Retry-After: 2`. Uncertain or abandoned
external work returns `IDEMPOTENCY_RECONCILIATION_REQUIRED`, with retry delay 5.
Authentication and current resource permissions run on every HTTP request, including
replays. Request Management also checks current reviewer capability before replay.

## Transactions, migrations and existing protections

Each owner stores receipts in its own PostgreSQL schema. The shared Alembic revision
is `shared/idempotency/migrations/versions/0001_idempotency_records.py`; register its
version location in an owner's Alembic configuration if that owner uses Alembic.
Tenant-service uses its existing startup migration runner; Request Management uses
additive migration `0004_idempotency_records.sql`. HTTP requests never create tables.
Apply migrations with the existing migration owner, not the runtime application role.

The database adapter is only for reviewed DB-only handlers. One outer transaction
contains business writes, audit/outbox writes and the completed receipt. Handler
`commit()` calls become savepoint releases, so they cannot commit ahead of the
receipt. Do not apply this decorator to file generation, emails, network calls,
streaming, background tasks or unreviewed inline permission checks. Financial
business uniqueness and row locks remain necessary for different keys targeting the
same obligation.

Integrated paths include commission create/submit/approve/reject/payment recording,
initial-premium initiation by case and policy, remaining-premium initiation, and
direct claim payout. Initial premium confirmations by case and policy also use atomic receipts: only
financial fields are retained; authorized replay reloads transient links and notes
from the domain record. These transient fields reflect the current resource, while
the financial outcome is the original successful result. Request Management draft creation uses the shared table;
its existing action receipts, revision constraints, outbox and execution deduplication
remain in use. Ticket creation retains its existing unique domain key and outbox.
Audit ingestion/hash-chain protections remain unchanged.

Payment mock references now derive from the durable obligation. The external-provider
adapter in `shared/idempotency/external.py` commits reservation before network I/O
and uses provider lookup after a timeout. It is tested with a fake provider but is
**not wired to a live payment provider**. Future adapters must enforce business-level
uniqueness and implement authoritative lookup; producer retries or HTTP keys alone
do not guarantee exactly-once execution.

Customer Management forwards header keys with v2 service signatures that also bind
tenant, customer and caller identity. Deploy shared signing code, customer-service
verification and portal forwarding together. Existing non-keyed v1 signatures remain
supported. Body-only ticket keys are rejected, so old ticket writers need coordinated
upgrades. AI tool-call IDs survive the reviewed resume path and derive stable keys;
remaining subagent/journey paths still need auditing.

## Retention, recovery and operations

`IDEMPOTENCY_RETENTION_DAYS` defaults to 30 for the DB adapter. An owner maintenance
job can call `expire_responses(conn, limit=1000)` in bounded transactions. This
scrubs completed response bodies while preserving permanent identity tombstones.
Expired receipts reject retries; expiry never authorizes a second financial action.
UNKNOWN and PROCESSING rows are excluded. No maintenance scheduler is installed yet.

For external work, PROCESSING leases default to 120 seconds. Expiry does not permit
blind takeover: query the provider using the original reference, then call
`reconcile` with the observed fencing token. Only definitive non-execution permits
FAILED/retry. Missing or ambiguous evidence remains UNKNOWN. Stale workers cannot
overwrite the reconciled outcome because the token rotates. Do not manually delete
receipts to unblock financial retries. Investigate the domain resource and provider.

Logs expose operation names and reservation/replay events, not keys or raw payloads.
Operational dashboards/alerts for UNKNOWN age, processing leases, conflicts and
cleanup backlog remain to be integrated. Monitor growing tombstone storage.

## Validation evidence (local PostgreSQL, 2026-10-21)

- Shared contract/PostgreSQL: 13 tests; HTTP atomicity/replay: 4; external reconciliation:
  2; signature binding: 2 passed.
- Commission: 44 passed; initial premium six-way race passed; premium confirmation replay test passed
  (provider called once, restart replay, payload conflict, different-key rejection,
  sensitive fields absent from receipt).
- Customer service/outbox: 21 passed; customer-management support: 4 passed.
- Request Management: 20 passed, including current-role denial on replay.
- Audit hash/consumer/outbox: 40 passed; reviewed agent tool suite: 35 passed.
- Browser operation helper test passed. Frontend TypeScript checking reported 11
  pre-existing errors outside the changed files; a clean full build is not established.

Tests use disposable databases/schemas and preserve production records. This list is
suite-level evidence, not proof that all inventory endpoints have dedicated tests.

Run the shared tests in an environment containing the tenant-service dependencies:

```sh
python -m unittest shared.idempotency.tests.test_contract shared.idempotency.tests.test_postgres shared.idempotency.tests.test_http shared.idempotency.tests.test_external shared.idempotency.tests.test_signatures
```

Set `IDEMPOTENCY_TEST_DATABASE_URL` to a test PostgreSQL database whose test owner can
create/drop schemas. Never print the URL in logs.

## Synthetic performance measurement

Run `python -m shared.idempotency.benchmark` with the test URL above. It creates and
drops only a random `idem_bench_*` schema. At 200 sequential operations locally:

| Case | p50 ms | p95 ms | ops/sec | SQL statements/op |
| --- | ---: | ---: | ---: | ---: |
| Business + outbox baseline | 3.028 | 4.037 | 313.9 | 2 |
| Business + outbox + receipt | 4.263 | 6.005 | 217.0 | 6 |
| Completed replay | 3.998 | 5.070 | 241.9 | 4 |

Counts exclude driver transaction/pool commands. All eight concurrent contenders
against one uncommitted key received PROCESSING; maximum observed latency was
149.12 ms, including cold connection setup. The 202-row receipt table used 204800
bytes including indexes; average row size was 272 bytes. Small-table page overhead
makes the total-size-per-row unsuitable for production capacity extrapolation.
These are synthetic DB measurements, not API/LLM/provider or full-system benchmarks.

## Remaining work

Review and integrate the remaining P0 policy issuance, remaining-premium confirmations,
installments/bulk/prepaid/portal/renewal/reinstatement payments, settlements and
refund flows. Separate transactional intent from file/provider/notification effects.
Finish P1 workflows and all actual callers, including persistent ticket UI operation
identity. Audit P2 risk-evaluation Kafka offset handling, durable LLM result/job
storage, document publication, notification dispatch and evaluation datasets. Add
route-level concurrency/crash/recovery tests, rollout flags and operational metrics
before claiming system-wide coverage or enabling required mode broadly.
