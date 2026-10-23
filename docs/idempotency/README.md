# Idempotency

Every state-changing HTTP endpoint in GetInsuredAI has an explicit idempotency decision. A client sends an
`Idempotency-Key` header; the service performs the operation once, answers a retry with the original outcome, refuses a
reused key carrying different content, and never repeats money or external effects because a response was lost.

* **Where every endpoint stands:** [COVERAGE.md](COVERAGE.md) (readable) and [coverage.json](coverage.json) (machine form), generated
  by `python3 scripts/idempotency/inventory.py` from the code plus the reasoned decisions in [review.json](review.json).
  `python3 scripts/idempotency/test_coverage.py` fails when an endpoint has no decision, when an exemption has no reason, when the
  matrix is stale, or when a money path lacks a keyed test.
* **Decisions** (473 mutation handlers): 219 `INTEGRATED` (shared adapter), 35 `EXISTING` (the owning service's own durable
  mechanism, or it forwards the key to the service that has one), 52 `PROXY` (gateway hop), 91 `NATURAL` (overwrite, delete, state-guarded or
  converging sweep), 70 `NOT_APPLICABLE` (read, preview, stateless compute, conversation, credential flow), 6 `DEFERRED` (named gaps, below).

## Contract

| Rule | Behaviour |
| --- | --- |
| Key | `Idempotency-Key` **header only**, 8–128 characters (`A–Z a–z 0–9 . _ : -`, first alphanumeric), exactly one header. A key in the body is ignored/rejected. |
| New intent | New key, even with identical data. Never derive a key from payload equality or the current time. |
| Missing / invalid key | `400 IDEMPOTENCY_KEY_REQUIRED / IDEMPOTENCY_KEY_INVALID` on protected endpoints when `IDEMPOTENCY_ENFORCEMENT=required`; in `optional` (default) an unkeyed request takes the original path untouched, a malformed key is still `400`. |
| Same key, same content | Replays the stored outcome with its **original status** and `Idempotency-Replayed: true`. |
| Same key, different content | `409 IDEMPOTENCY_CONFLICT`. Exception: a key whose earlier attempt was *rejected* (4xx) can be reused with corrected content. |
| Same key, still running | `409 IDEMPOTENCY_PROCESSING` + `Retry-After`. Concurrent identical requests execute once. |
| Abandoned / uncertain | `409 IDEMPOTENCY_RECONCILIATION_REQUIRED` for work that may have happened (money, other systems). Never a blind takeover. Notifications opt into at-least-once instead (`recover="retry"`). |
| Authorization | Runs on **every** call, replays included. A receipt proves an earlier action, never the caller's current permission. |
| Identity | Unique `(scope_id, operation, idempotency_key)`; scope is the tenant (or, for public link endpoints, a digest of the link). The request fingerprint covers the authenticated actor, path, query and normalized body; an uploaded file contributes its name, type, size and SHA-256. |

## What is stored

Table `idempotency_records` (see `shared/idempotency/models.py`; created by the owning service's migration runner, never by a request):
scope, operation, key, request hash, status (`PROCESSING / COMPLETED / FAILED / UNKNOWN`), HTTP status, a **reviewed** replay receipt,
lease token/expiry (fencing), attempt count, timestamps, expiry. Never stored: tokens, passwords or one-time links, medical or payment-sensitive
data, free-form exception text, or personal data beyond what the receipt schema names. Receipts are one of:

* **Allowlisted fields** of a small non-personal response (`reviewed_operation`, `schema_ok` refuses any field not named).
* **Ids only** ("view receipts"): an authorized replay re-reads the records and rebuilds the body, so it is current and nothing is copied
  (`records_operation`, `read_model_operation`, `step_operation`, `workflow_operation`, billing helpers).
* **Masked outcome**: recipients are masked (`a***@example.com`), one-time secrets are blanked (`secret_link_operation`, `outcome_operation`).

## Adapters (`shared/idempotency/http.py`)

* `database_operation` – business writes, outbox events and the receipt commit in **one** transaction. The endpoint session uses
  savepoints, so a handler's own `commit()` cannot escape. A 4xx keeps work the handler already committed (for example a recorded failed
  payment attempt) and writes a `FAILED` marker; a 5xx rolls everything back. For database-only handlers.
* `side_effect_operation` – the reservation commits first, then the handler runs unchanged, then the receipt is stored. For e-mail, other
  services, file/object output, event publication. `recover="reconcile"` (money) or `"retry"` (notifications); an optional `evidence(values, record)`
  hook settles an abandoned attempt from domain state (for example "this premium is now realized").
* Tenant-service helpers in `services/idempotency.py`: `tenant_operation`, `reviewed_operation`, `read_model_operation`, `records_operation`,
  `step_operation`, `workflow_operation`, `sanitized_operation`, `billing_operation`, `notification_operation`, `outcome_operation`,
  `secret_link_operation`, `token_operation` (public link-token endpoints).
* A direct Python call (jobs, other handlers, tests passing a stand-in request) bypasses the HTTP adapter and keeps the business uniqueness
  guarantees. Only a real HTTP request with a key engages it.

Rule of thumb applied everywhere: **atomic only for database-only handlers**. Anything that publishes a case event, e-mails, or calls another
service uses `side_effect_operation`, because an event published before the outer commit could be observed ahead of its data.

## Money and external systems

Keys are never the only protection. Unique business constraints and row locks remain (premium obligation, receipt number, payout per claim, commission per
policy). Provider timeouts are `UNKNOWN` and must be reconciled with the provider using the original reference (`shared/idempotency/external.py`,
fake-provider tested; **no live payment provider is wired**). The mock gateway derives references from the durable obligation. Receipts for
PDF-generating paths use a receipt number, which fixed a pre-existing bug where receipt files overwrote each other.

## Callers

* **Web** (`frontend/lib/idempotency.ts`): `keyedPost` / `keyedRequest` / `operation` keep one key per UI intent in `sessionStorage`; a timeout, 5xx,
  "still processing" or "reconciliation required" keeps it, success or a final refusal consumes it. The axios error now carries `response`
  so refusals are recognised. All service modules for P0/P1 flows and the corresponding pages/components are keyed.
* **Customer portal** (web and mobile): keys per modal/form (`useRef`), pay, claims, surrender, support, renewal acceptance, claim documents and the
  walk-in payment link. Customer Management forwards the key with the v2 service signature, namespaced by account, to tenant-service.
* **Agent app** (`src/lib/idempotency.ts`, AsyncStorage-backed), **API gateway** (transparent: forwards the key, returns the replay headers;
  CORS exposes `Idempotency-Replayed`, `Retry-After`).
* **AI agent tools** (`chat-agent/tool_executor.py`): every write in a tool call gets its own key derived from the durable tool-call id, tenant, method,
  URL and body hash (`write_key`), so retries and `/chat/resume` are recognised and two different writes of one tool call never collide.
* **Kafka / outbox**: policy lifecycle events go through the business outbox in the same transaction (`shared/events/outbox.py`); risk-engine and
  gateway result consumers deduplicate by durable job/offset records; audit ingestion is unique per source event, checkpoints per number, archive jobs per range.

## Rollout

`IDEMPOTENCY_ENFORCEMENT=optional|required` (`.env.example`). Start `optional` (all callers keep working, keyed callers are protected), update remaining
callers, then switch to `required` per service. `required` rejects missing keys only on integrated endpoints.

## Retention, recovery and operations

* Retention: `IDEMPOTENCY_RETENTION_DAYS` (default 30) bounds how long a replay body is kept. A periodic job (`shared/idempotency/maintenance.py`, started by
  tenant-service, `IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS` default 3600, `0` disables) erases **expired response bodies in bounded batches**. Identity rows are kept: an expired key never
  re-authorizes a repeat. Storage is ~272 bytes per row; plan an archive policy for very long horizons.
* Health: `GET /health/idempotency` (tenant-service) returns counts by status, attempts stuck past their lease, unknown outcomes awaiting a decision and the
  cleanup backlog – no keys or business data. Logs carry `idempotency_reserved / replayed / refused operation=… code=…`, never keys or payloads.
* Recovery: `PROCESSING` leases are 120 s. After expiry the work is not repeated blindly; check the domain record or provider with the original reference, then
  `reconcile(...)` with the fencing token (stale workers cannot overwrite). Do not delete receipts to unblock a financial retry.
* One-time secrets (portal passwords, e-mailed links) are returned on the first call only; a replay never repeats the send and carries none, so the operator
  resets explicitly if the first response was lost.

## Tests

Real PostgreSQL in a disposable database/schema; nothing outside it is touched. Set `IDEMPOTENCY_TEST_DATABASE_URL` to a database whose owner can create schemas.

```sh
# shared library (inside tenant-service)
python -m unittest shared.idempotency.tests.test_contract shared.idempotency.tests.test_postgres shared.idempotency.tests.test_http \
  shared.idempotency.tests.test_modes shared.idempotency.tests.test_external shared.idempotency.tests.test_signatures \
  shared.idempotency.tests.test_business_outbox shared.idempotency.tests.test_maintenance shared.idempotency.tests.test_consumer_offsets
# route-level keyed tests (tenant-service; each uses tenant-service/idem_testkit.RouteCase)
python -m unittest test_policy_payment_idempotency test_post_issuance_idempotency test_post_issuance_more_idempotency test_ipp_lifecycle_idempotency \
  test_ipp_idempotency test_workflow_idempotency test_case_idempotency test_case_steps_idempotency test_enrollment_idempotency test_group_setup_idempotency \
  test_walkin_pay_idempotency test_artifact_idempotency test_admin_setup_idempotency test_preissuance_idempotency test_provisioning_idempotency \
  test_claim_register_idempotency test_exit_loan_idempotency
python test_claim_workflow_idempotency.py   # pytest, needs a migrated, role-seeded database; run it alone
# coverage guard (no database)
python3 scripts/idempotency/test_coverage.py
```

They cover: header validation, replay with the original status, conflict, concurrent duplicates executing once, restart replay, crash before/after commit, expired
leases, rollback of business+outbox+receipt, provider-timeout reconciliation, Kafka/outbox duplicates, agent tool key derivation, upload fingerprinting, tenant isolation,
new key = new operation, receipts holding no personal data, masked recipients, one-time secrets never stored.

## Measured cost (synthetic, local PostgreSQL over the Docker bridge)

HTTP level, `POST /premiums/autopay` (ledger write + billing view), 150 sequential requests (`tenant-service/bench_idempotency_http.py`):

| Path | p50 ms | p95 ms |
| --- | ---: | ---: |
| Unkeyed (original path) | 76.2 | 94.8 |
| Keyed, first call | 92.3 | 109.6 |
| Keyed, replay | 77.1 | 96.7 |

First keyed call adds ≈ 16 ms p50 (two short transactions: reservation and receipt); a replay costs ≈ +1 ms because it re-reads instead of re-writing.
Library level (`python -m shared.idempotency.benchmark`): baseline 3.0 ms p50, protected 4.0 ms, replay 4.1 ms; eight concurrent contenders on one key all received `PROCESSING`.
These are not LLM/provider/full-system numbers.

## Known gaps and risks

* `DEFERRED` (see COVERAGE.md): usage-ledger append (`/tokens/usage`), request-management attachment upload and routing-rule creation, specialist/policy-wording uploads.
  Each is low impact (a visible duplicate or a statistic), named with a reason and a follow-up.
* 88 of the 219 integrated handlers share an adapter that is tested on a sibling endpoint but have no route-level keyed test of their own (flagged `untested`
  in coverage.json; the guard fails if one appears on a money path).
* Uploads store the file before the database commit; a failed attempt can leave an orphaned object (never an orphaned record).
* A live payment provider is not integrated; reconciliation is proven against a fake only.
* Pre-existing failures unrelated to this work (also failing on the starting commit): `test_eval_lake_pure`, `test_policy_delivery` (2), `test_underwriting_tracks` (4), the HTTP-flow
  parts of `test_group_endorsements` / `test_group_renewal` / `test_group_isolation`.
