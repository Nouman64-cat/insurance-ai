# Audit Service

A centralized, tenant-isolated, **SHA-256 hash-chained** audit ledger for GetInsuredAI.

* Every significant business operation is recorded as an immutable audit event: who, what, when, on which entity, before/after, outcome.
* Events are chained per tenant (and one platform chain for system events). Editing, deleting or reordering a recorded event is **detected** by verification.
* Append-only storage is enforced by the database itself (triggers + a least-privilege role), not only by application code.
* Delivery is reliable: producers write a **transactional outbox** row in the same database transaction as the business change.

> **Stage 1** is the hash-chained ledger (this document, first half). **Stage 2** adds Ed25519-signed checkpoints,
> an isolated signer, a trusted key registry, protected checkpoint storage and anchored verification
> ([jump to Stage 2](#stage-2-signed-checkpoints)). Still out of scope: KMS/S3/Vault/HSM, blockchain, per-employee keys.
> See [Security limits](#security-limits-read-this).

Public API (through the gateway): `/audit/v1/…` · direct (dev): `http://localhost:8030/v1/healthz` · UI: Admin Portal →
**Administration → Security & Compliance → Audit Trail** (`/admin/audit-trail`).

---

## Architecture

```
 tenant-service ─┐   business change + audit_outbox row = ONE transaction
 request-mgmt  ──┤
 customer-mgmt ──┼─► OutboxRelay ─► Kafka  insurance.audit.events.v1 ─► audit-service consumer ─► audit.* (PostgreSQL)
 customer-svc  ──┘   (at-least-once)        (key = tenant id)            (assigns sequence + hashes)      │
                                                                                                          ▼
 Admin Portal ─► API gateway /audit/v1 ─► audit-service (read-only API + verification) ◄───────── scheduled verifier
```

| Piece | Where |
|---|---|
| Event contract, sanitizer, request context, outbox + relay | `shared/audit/` |
| Ledger service (this directory) | `microservices/backend-microservices/audit-service/` |
| Automatic capture of business changes (SQLAlchemy flush hook) | `tenant-service/services/audit_capture.py` |
| Explicit events (sign-in, denied access, document viewing) | `routers/auth.py`, `routers/artifacts.py` |
| Satellite services (existing audit choke points mirrored into the outbox) | `request-management-service/app/records.py`, `customer-management/app/accounts.py`, `customer-service/main.py` |
| Gateway proxy + correlation ids | `api-gateway/main.py`, `api-gateway/correlation.py` |
| Admin UI | `frontend/app/admin/audit-trail/`, `frontend/lib/audit.ts` |

**Kafka order is never trusted.** The Audit Service assigns the authoritative sequence number when it commits an event.
Redelivery, retries, two consumers racing and a crash mid-batch cannot duplicate or skip a number.

### Why an outbox

The producing service writes `audit_outbox` **in the same transaction** as the change it describes. So either both exist or neither does:
if the audit intent cannot be stored, the business write fails with it (an operation is never reported as audited when it is not).
Kafka is only the transport; if it is down the rows wait, and the business request never blocks on the broker or on this service.

---

## Event model

Stored in `audit.events` (see `migrations/0001_initial.sql`):

`event_id, tenant_id, environment_id, chain_id, sequence_number, timestamp (occurred_at), recorded_at, actor_id, actor_type, actor_role, service_name, module, action, entity_type, entity_id, case_id, correlation_id, source_event_id, previous_value, new_value, outcome, metadata, previous_hash, current_hash, hash_version`

* `module` ∈ administration · customers_leads · underwriting · ai_agents · documents · policies · payments · claims · customer_service.
* `action` is a dotted verb, e.g. `policy.status_changed`, `auth.login.failed`, `ticket.resolved`.
* `outcome` ∈ SUCCESS · FAILURE · DENIED. `actor_type` ∈ USER · SYSTEM · AI_AGENT · CUSTOMER · SERVICE.
* `previous_value` / `new_value` hold only the fields that changed (an update), the whole record (a creation) or the last state (a deletion).
* `correlation_id` is the gateway's `X-Correlation-Id`, so every event produced by one user action lines up across services.

### What is never stored

`shared/audit/sanitize.py` runs when an intent is built **and** again when the Audit Service receives it:

* credentials and secrets (passwords, hashes, tokens, API/private keys, OTPs, card numbers) → `[REDACTED]`;
* personal identifiers are masked (CNIC → `*****-*******-1`, phone → `***567`, e-mail → `a***@host`) or redacted (date of birth, address…);
* raw medical and document content (OCR text, lab results, diagnoses, files, base64) → `[OMITTED]`;
* per-model `summarize` lists (see `audit_capture.py`) note that a field changed (`[changed]`) without storing its value;
* long text is truncated, depth and size are bounded, floats become decimal strings (so hashing is deterministic).

---

## Hash chain

```
event_hash = SHA256( "insurance-ai/audit-event/v1\0" ||
                     canonical_json({ "hash_version": 1, "chain_id", "sequence_number", "previous_hash", "event": {…} }) )
genesis    = SHA256( "insurance-ai/audit-genesis/v1\0" || chain_id )
```

* **Chains**: `chain_id = "<environment_id>:<tenant_id | platform>"`. One chain per tenant per database, plus one platform chain.
  `environment_id` is generated when the schema is migrated, so independently initialised databases (every developer laptop)
  get different chain ids, genesis hashes and event hashes.
* **Hashed event fields**: `event_id, tenant_id, environment_id, timestamp, recorded_at, actor_*, service_name, module, action, entity_type, entity_id, case_id, correlation_id, source_event_id, previous_value, new_value, outcome, metadata`.
* **Canonical form (v1)**: sorted keys, no whitespace, ASCII-escaped, integers only (no floats), timestamps as UTC `YYYY-MM-DDTHH:MM:SS.ffffffZ`, lowercase UUIDs, missing optionals = `null`.
  Implemented in `app/services/hash_chain.py`; a new `hash_version` adds a function to `HASHERS`, existing events keep verifying under their own version.
* **First event** links to the chain's genesis hash. Every later event links to the previous event's `current_hash`.

### What the database enforces (independent of the application)

| Guarantee | How |
|---|---|
| Sequence is `head+1`, no gaps/duplicates/forks | `BEFORE INSERT` trigger on `events` locks the chain row, checks sequence and `previous_hash`, then advances the head |
| Chain head can't be forged | `chains` rows can only be updated from inside that trigger (`pg_trigger_depth()`); the app role has no `UPDATE` |
| Chain identity | `ensure_chain()` derives id + genesis; a `BEFORE INSERT` trigger re-derives and rejects anything else |
| Tenant / environment isolation | the events trigger rejects an event whose tenant/environment differs from its chain's |
| Idempotency | `UNIQUE (service_name, source_event_id)` |
| Append-only | `UPDATE`/`DELETE`/`TRUNCATE` triggers on `events`, `chains`, `environment`, `dead_letters`, `verification_runs` (they apply to the schema owner too) |
| Least privilege | `audit_app` can `SELECT`, `INSERT` (events, dead_letters, verification_runs) and `EXECUTE ensure_chain/lock_chain`. Nothing else — see `app/migrate.py: apply_grants` |

Concurrency: appenders for one chain serialise on `lock_chain()` (a row lock); different tenants run in parallel.

---

## Verification

`app/services/chain_verifier.py` re-reads a chain from the database in one `REPEATABLE READ` snapshot and recomputes it:

| Check | Reason code |
|---|---|
| event content vs its hash | `EVENT_HASH_MISMATCH` |
| link to the previous event | `PREVIOUS_HASH_MISMATCH` (`EVENTS_REORDERED` when the link points at another position) |
| first event vs genesis | `GENESIS_MISMATCH` |
| missing records | `SEQUENCE_GAP` (middle) · `CHAIN_HEAD_SEQUENCE_MISMATCH` (tail) |
| head hash | `CHAIN_HEAD_HASH_MISMATCH` |
| tenant / environment / identity / version | `TENANT_MISMATCH`, `ENVIRONMENT_MISMATCH`, `CHAIN_IDENTITY_MISMATCH`, `UNSUPPORTED_HASH_VERSION` |

The first violation is returned with diagnostics:

```json
{ "tenant_id": "…", "chain_id": "…", "status": "INVALID", "total_events_checked": 244,
  "first_invalid_sequence": 245, "reason": "EVENT_HASH_MISMATCH", "details": { "stored_hash": "…", "calculated_hash": "…" } }
```

* Full chain: `POST /v1/verification/run` (a tenant admin's request always means their own chain).
* Bounded range: add `from_sequence`, optional `to_sequence`, and `trusted_previous_hash` (the hash of the event before the range, obtained independently). The head is compared only if the range reaches it.
* Scheduled: every `AUDIT_VERIFY_INTERVAL_SECONDS` (default 6 h), one replica at a time; results go to `verification_runs` (append-only). Invalid chains log `INTEGRITY VIOLATION`.
* SuperAdmin: `POST /v1/verification/run-all`.

## Security limits (read this)

**SHA-256 chaining alone cannot prevent a privileged attacker from rewriting the entire chain and its database chain-head metadata**
(the test `test_a_perfectly_recomputed_chain_passes_stage_one_but_not_the_signed_checkpoints` and `python -m tests.demo_tamper` show it).
Stage 1 alone detects edits, deletions and reordering by anyone *without* that full-rewrite capability; the application and its
credentials cannot change history at all; tenants cannot see or write each other's records.

**Stage 2 closes that gap for history up to the newest signed checkpoint**: anyone who controls only the application database can no
longer rewrite or truncate anchored history without verification noticing, because the anchors (signed checkpoints and the trusted
keys) live outside the database. It does **not** make the system "tamper-proof": see
[What Stage 2 does and does not protect against](#what-stage-2-does-and-does-not-protect-against). The UI says
*Verified / Chain valid / Integrity violation / Verification pending* and never "tamper-proof".

## API (read-only + verification)

| Method | Path | Who |
|---|---|---|
| GET | `/v1/events` — filters: `from,to,actor,module,action,entity_type,entity_id,case_id,correlation_id,outcome,service_name,chain_id,sequence,q,tenant,page,page_size` | Admin (own tenant) · SuperAdmin (all) |
| GET | `/v1/events/{id}` (with previous/next neighbours) · `/v1/events/facets` · `/v1/chains` | same |
| POST | `/v1/verification/run` · GET `/v1/verification/runs` | same |
| POST | `/v1/verification/run-all` · GET `/v1/ops/dead-letters` | SuperAdmin |
| GET | `/v1/ops/status` · `/v1/healthz` | Admin/SuperAdmin · open |

There is **no** create/update/delete route for audit records; tests assert that every write method on `/v1/events*` is refused (405).
Identity comes from tenant-service `/auth/me` on the caller's own token; `AUDIT_READ_ROLES` (default `Admin,SuperAdmin`) decides who may read.

## Operations

* **Undelivered events**: each producer exposes its outbox backlog — tenant-service `GET /health/audit`, request-management `GET /v1/healthz/audit`,
  customer-management `GET /internal/v1/audit/health`, customer-service `GET /internal/v1/audit/health` (`pending`, `oldest_pending_seconds`, `consecutive_publish_failures`, `last_error`).
* **Consumer lag / failures**: `GET /v1/ops/status` (SuperAdmin sees consumer state, lag, rejected-message count); rejected messages are kept in `audit.dead_letters`.
* **Kafka down**: producers keep queuing in their outbox and the relay retries with backoff; the consumer retries database outages from the last committed offset.
* **Disable** (e.g. a laptop without Kafka): `AUDIT_ENABLED=false` stops producers queuing intents; business operations are unaffected.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUDIT_DB_OWNER_PASSWORD`, `AUDIT_DB_APP_PASSWORD` | – | passwords for the two roles created by `audit-provision` (required) |
| `AUDIT_DATABASE_URL` / `AUDIT_MIGRATION_DATABASE_URL` | set in compose | app role / owner role connection |
| `AUDIT_READ_ROLES` | `Admin,SuperAdmin` | roles allowed to read |
| `AUDIT_CONSUMER_ENABLED`, `AUDIT_CONSUMER_GROUP`, `AUDIT_CONSUMER_BATCH` | `true`, `audit-service`, `200` | Kafka consumer |
| `AUDIT_VERIFY_ENABLED`, `AUDIT_VERIFY_INTERVAL_SECONDS`, `AUDIT_VERIFY_BATCH` | `true`, `21600`, `1000` | scheduled verification |
| `AUDIT_ENABLED` (producers) | `true` | queue audit intents |

Run: `docker compose up -d audit-service` (the `audit-provision` job creates the schema and roles first, then migrations run at start-up).

## Tests

```bash
docker compose exec -T audit-service python -m unittest discover -s tests          # hashing, sanitizer, ledger, verifier, consumer/outbox, API
docker compose exec -T tenant-service python test_audit_capture.py                  # capture, atomicity, actor/correlation, sign-in
docker compose exec -T customer-management python -m unittest tests.test_audit_outbox
docker compose exec -T customer-service python -m unittest tests.test_audit_outbox
# request-management needs its roles' passwords (it is not provisioned in every dev DB):
docker compose run --rm --no-deps -T -e REQUEST_MGMT_DB_OWNER_PASSWORD=… -e REQUEST_MGMT_DB_APP_PASSWORD=… request-management-service python -m unittest tests.test_audit_outbox
```

Each class runs against a throw-away database with the real migrations and the real least-privilege roles.

## Manually trying it

**1. A valid chain.** Sign in to the Admin Portal as a tenant Admin, do something (edit a user, a customer…), open *Audit Trail*, click **Verify chain** → *Chain valid*.
Or: `curl -H "Authorization: Bearer $TOKEN" -X POST localhost:8010/audit/v1/verification/run -H 'content-type: application/json' -d '{}'`.

**2. A deliberate tampering.** The application role cannot do this (try it: `psql -U audit_app … -c "UPDATE audit.events SET action='x'"` → *permission denied*).
Simulate an attacker with administrative rights:

```bash
set -a; . ./.env; set +a
PGPASSWORD=$AUDIT_DB_OWNER_PASSWORD psql -h localhost -U audit_owner -d "${POSTGRES_DB:-insurance-ai}" <<'SQL'
SET search_path TO audit;
-- even the owner is stopped by the append-only trigger:
UPDATE events SET new_value = '{"status":"Hacked"}' WHERE sequence_number = 3 AND chain_id LIKE '%:<your-tenant-id>';   -- ERROR
-- ...unless the trigger is deliberately switched off:
ALTER TABLE events DISABLE TRIGGER USER;
UPDATE events SET new_value = '{"status":"Hacked"}' WHERE sequence_number = 3 AND chain_id LIKE '%:<your-tenant-id>';
ALTER TABLE events ENABLE TRIGGER USER;
SQL
```

Click **Verify chain** → *Integrity violation*, first invalid event `#3`, reason `EVENT_HASH_MISMATCH`, with the stored vs calculated hash under *Diagnostic details*.
(Do this on a scratch tenant or database: the ledger is append-only by design, and a tampered chain stays flagged.)

---

# Stage 2: signed checkpoints

A **checkpoint** is a small record, signed with Ed25519, saying: *"events `start..end` of this chain end in this hash, and follow that
previous checkpoint"*. The signing key lives in a separate, locked-down container (the **signer**) that the application, the gateway
and the database cannot reach, and copies of every signed checkpoint are kept outside PostgreSQL. Verification compares the ledger with
those independent copies, so rewriting history after a checkpoint is detected even when the rewritten chain is perfectly consistent.

```
 Audit Service (no keys)                      audit-signer (the only holder of a private key)
 ┌──────────────────────────┐   HMAC-signed   ┌──────────────────────────────────────────────┐
 │ scheduler: 500 events or │ ─── request ──► │ 1 re-reads the chain itself (read-only DB role)│
 │ 15 min per chain         │  "checkpoint    │ 2 uses ITS OWN record of the last checkpoint   │
 │ generator (lease, retry, │   this chain"   │ 3 recomputes every SHA-256 hash from that anchor│
 │ alerts)                  │ ◄─ signed ───── │ 4 builds payload, signs (Ed25519), stores file │
 │ records it in PostgreSQL │   checkpoint    │    atomically, advances its own state          │
 └───────────┬──────────────┘                 └──────────────┬───────────────────────────────┘
             │ reads READ-ONLY                               │ writes
             ▼                                               ▼
   audit-checkpoints volume:  <env>/<tenant|platform>/checkpoint-000001.json …   trust/signing-keys.json
   (independent of PostgreSQL)                                  audit-keys / audit-secrets / audit-signer-state: signer only
```

## Trust boundaries (who can touch what)

| | Audit Service | API Gateway / other services | PostgreSQL (and anyone who controls it) | audit-signer |
|---|---|---|---|---|
| Private key (`audit-keys` volume) | **no mount** | no | no | read |
| Key passphrase (`audit-secrets` volume) | no | no | no | read-only |
| Signer state (`audit-signer-state`) | no | no | no | read/write |
| Protected checkpoints + key registry (`audit-checkpoints`) | **read-only** | no | cannot reach | read/write |
| Ledger tables | read/append (`audit_app`) | via API only | owner can edit | **read-only** role `audit_signer` |
| Can ask the signer to act | yes (HMAC-signed requests) | no | no | – |

The signer publishes no port, does not receive the application's `.env`, runs as an unprivileged user (`uid 10001`) on a read-only
filesystem with all capabilities dropped. Its API has **no operation that accepts a hash, payload or signature**: the only signing
operation is "checkpoint chain X", and the signer works out the rest from the ledger. The private key is never returned by any
endpoint, log line or response (tested).

## What a checkpoint binds

`checkpoint_id, tenant_id, environment_id, chain_id, checkpoint_number, start_sequence, end_sequence, event_count, last_event_hash,
previous_checkpoint_hash, created_at, signer_id, signing_key_id, key_version, signature_algorithm (Ed25519), payload_version`

Signed over `"insurance-ai/audit-checkpoint/v1\0" || canonical_json(payload)` (the same deterministic encoding as event hashes). The
signature is stored **apart from** the canonical payload it signs. `previous_checkpoint_hash` is the SHA-256 of the previous signed
payload (the first checkpoint follows a per-chain checkpoint genesis), so checkpoints form their own chain. Checkpoints do not change
events, sequence numbers or any existing hash.

## What the signer checks before it signs

It signs only after all of this succeeds (otherwise it refuses with a code and nothing is written):

1. its keys belong to **this database's environment** (`ENVIRONMENT_MISMATCH` otherwise: another installation's keys, or a re-created database);
2. the chain's identity, tenant and environment are consistent;
3. the previous checkpoint comes from the **signer's own trusted state** (rebuilt from signed files if lost), never from the database;
4. the ledger still contains the event the previous checkpoint committed to (`ANCHOR_MISMATCH` = history was rewritten, `CHAIN_TRUNCATED`);
5. every new event recomputes (`HASH_CHAIN_BROKEN`, `SEQUENCE_GAP`) from that trusted anchor;
6. anything the Audit Service *proposed* (number, range, hashes) equals what the signer computed (`PROPOSAL_MISMATCH`).

Only then does it sign, store the file with an atomic never-overwrite write (temp file, `fsync`, hard link, directory `fsync`), update its
state, and answer. A checkpoint is recorded in PostgreSQL and called *protected* only after both signing **and** protected storage
succeeded, and the Audit Service has confirmed the protected copy is really there and identical.

## Schedule, concurrency and recovery

* Per chain, independently: due when `pending >= AUDIT_CHECKPOINT_EVENT_THRESHOLD` (500) **or** the oldest unsigned event is older than
  `AUDIT_CHECKPOINT_INTERVAL_SECONDS` (900). A chain with nothing new never gets a checkpoint. A backlog is caught up in order (at most
  `AUDIT_CHECKPOINT_MAX_EVENTS` per checkpoint).
* Several Audit Service instances can run the scheduler: a per-chain **lease** in `audit.checkpoint_state` (taken with a conditional `UPDATE`, expiring
  if a worker dies) gives one worker the chain; `UNIQUE(chain_id, checkpoint_number)`, a database trigger (strict numbering, contiguous
  ranges, linkage, ends on the event it names) and the signer's own per-chain lock make duplicates and misordering impossible.
* Durable state machine, no in-memory fire-and-forget: leased → signing → recorded, with failures kept in `checkpoint_state`
  (retry with exponential backoff) and raised as **alerts** (`audit.checkpoint_alerts`, the log at ERROR, and the dashboard):
  `SIGNER_UNAVAILABLE`, `SIGNER_KEY_UNAVAILABLE`, `STORAGE_FAILED`, `INTEGRITY_VIOLATION`, `SIGNING_FAILED`; one alert per incident, and
  `CHECKPOINT_RECOVERED` when it clears. A crash between "file stored" and "recorded" is recovered idempotently: the signer finds the stored file
  for the next number and returns it instead of signing again.
* Signing never runs inside a business request, and the signer reads the ledger in a snapshot without locks, so insurance workflows
  keep committing while checkpoints are made (tested).

## Verification states

`POST /v1/checkpoints/verify` (and the scheduled run) returns one overall state plus the four separate facts the dashboard shows:

| State | Meaning |
|---|---|
| `VERIFIED` | hash chain intact; every checkpoint contiguous, linked, signed by a trusted key active at the time, bound to this chain, identical in PostgreSQL and in protected storage, and the ledger still contains the event it committed to |
| `UNSIGNED_EVENTS_PENDING` | all of the above holds; the newest events are not covered by a checkpoint yet (normal) |
| `INVALID_HASH_CHAIN` | a Stage 1 problem (edited/deleted/reordered event) |
| `INVALID_SIGNATURE` | a signature does not verify |
| `UNTRUSTED_SIGNER` | unknown key, key not authorised for this tenant/environment, key not active at signing time, or an invalid/replaced registry |
| `MISSING_CHECKPOINT` | a checkpoint is missing from storage or the database, or numbering has a gap |
| `CHECKPOINT_MISMATCH` | history no longer matches a signed checkpoint (rewritten / truncated), a copy differs, or a checkpoint belongs to another chain/tenant/environment |
| `VERIFICATION_FAILED` | could not be completed (protected store or registry unreadable): **never** reported as verified |

Worst state wins. Flags: `hash_chain_valid`, `signatures_valid`, `signer_trusted`, `anchored`, plus `pending_events`. A checkpoint is never
trusted because it matches PostgreSQL; the protected files and the registry decide, and the database copy must equal them.

## Keys: initialisation, storage, backup, rotation, loss

* **One key pair per installation, created once, explicitly.** `docker compose run --rm audit-signer-init` generates an Ed25519 key,
  stores it as **PKCS#8 encrypted** PEM (`ed25519-private-v1.pem`, mode 0400, directory 0700) in the `audit-keys` volume, creates a random
  passphrase in the separate `audit-secrets` volume (0400), writes the bootstrap entry of the trust registry, prints the public-key
  **fingerprint**, and refuses to ever run again. Ordinary starts never generate or replace keys; a missing/invalid key or passphrase makes the
  signer report `KEY_UNAVAILABLE`/`KEY_INVALID` and stop signing (alerts fire; nothing is silently replaced).
* **Each developer gets their own** (their own database ⇒ their own `environment_id`, keys, volumes). Nothing is shared or copied between machines.
  Keys are bound to the environment: pointing a signer with another installation's keys at your database is refused (`ENVIRONMENT_MISMATCH`).
  `AUDIT_ENVIRONMENT_LABEL` (default `local-dev`) is a display name only; the *identity* is the UUID generated when the database is migrated, so two
  laptops can never accidentally share a chain identity.
* **Where it lives.** Docker-managed named volumes (`audit-keys`, `audit-secrets`, `audit-signer-state`, `audit-checkpoints`): outside the repository,
  they survive `docker compose down`/recreate and image rebuilds, and work the same on Linux, macOS and Windows. To use a host directory instead
  (`<HOST_PROTECTED_DATA_DIR>/audit/{keys,secrets,state,checkpoints}`) use `docker-compose.protected-dir.yml` (see the file for the three-line setup).
  `.gitignore` excludes `*.pem` and the protected-data folders. Nothing secret is in `.env.example`.
* **Backup / restore.** `docker compose run --rm audit-signer python -m shared.audit.signer.cli backup --out /tmp/audit.bak --passphrase-file ...` writes an
  *encrypted* archive (scrypt + Fernet) of checkpoints, registry, state and the already-encrypted keys; the key passphrase is deliberately **not** included, so back it up
  separately. `restore` never overwrites a differing file. **A backup folder on the same host does not protect against an attacker who controls that whole host.**
* **Rotation (administrator-controlled).** SuperAdmin only: *Rotate signing key* in the dashboard or `POST /v1/signing/rotate`. The new key is added to the registry
  with a statement signed by the new key (possession) **and** by the current key (authorisation); the old public key stays trusted *for the period it was active*, so
  older checkpoints keep verifying, and a retired key can no longer produce a valid new checkpoint.
* **Lost key.** Signing stops and alerts; history stays verifiable (public keys are in the registry). Restore the key volume and passphrase from backup. If both
  are truly lost, a new trust lineage must be started deliberately by an operator and verifiers given both registries; this stage does not automate that, on purpose.
* **Pin the trust root (recommended outside local dev).** Record the fingerprint printed by init (and shown in the UI) somewhere outside the machine and set
  `AUDIT_TRUST_ANCHOR_FINGERPRINT`; a replaced registry then fails verification as `UNTRUSTED_SIGNER`.

## Shared staging / production

Employees never touch keys: they use the Admin Portal, the backend signs. Run **one** signer service for the environment (a separate host or restricted network,
key volume only there), give the Audit Service the read-only checkpoint store (a read-only mount or a replicated directory) and `AUDIT_SIGNER_URL`/`AUDIT_SIGNER_SERVICE_KEY`,
set `AUDIT_TRUST_ANCHOR_FINGERPRINT`, and configure the **replica**:
`AUDIT_CHECKPOINT_REPLICA_DIRECTORY` (+ `AUDIT_CHECKPOINT_REPLICA_REQUIRED=true` to fail a checkpoint if the second copy can't be written) writes each checkpoint to a
second, separately administered location. The signing provider is behind `app/signing/interface.py` (`CheckpointSigner`) and `signer_factory.py`: a Vault-transit or KMS/HSM
provider is a new class plus one line; `AUDIT_SIGNING_PROVIDER` values `vault`/`kms`/`hsm` are reserved and refuse to start today. No cloud service is needed or deployed.

## What Stage 2 does and does not protect against

| Attacker | Result |
|---|---|
| Edits, deletes or reorders events | caught by the hash chain (`INVALID_HASH_CHAIN`) |
| Controls **only the database** (even the schema owner, disabling triggers): rewrites the whole chain + head, truncates, deletes/replaces checkpoint rows | caught for history up to the last checkpoint (`CHECKPOINT_MISMATCH`, `MISSING_CHECKPOINT`, `INVALID_SIGNATURE`, `UNTRUSTED_SIGNER`); they cannot sign |
| Rewrites events **newer than the last checkpoint** | **not detectable yet** (reported as `UNSIGNED_EVENTS_PENDING`); the exposure window is at most 500 events / 15 minutes of history |
| Also controls the protected checkpoint store (the signer's volume) | can delete or replace checkpoint files; replication to a second, separately administered location is the mitigation |
| Controls the **signer container or its key + passphrase** | can sign anything; **not protected**. Only an external HSM/KMS or a separately held key narrows this |
| Controls the whole host | **not protected**; a same-host backup does not help |
| Stops the signer | checkpoints stop and alerts fire; history stays verifiable; pending events grow |

This system is **not claimed to be tamper-proof** against full host or signing-key compromise.

## Stage 2 API (additions; same RBAC as Stage 1)

| Method | Path | Who |
|---|---|---|
| GET | `/v1/checkpoints/status` — signer/registry status, per-chain progress (pending events, threshold, countdown), failures, alerts | Admin (own tenant) · SuperAdmin |
| GET | `/v1/checkpoints?chain_id=` (history) · `/v1/checkpoints/{id}` (with canonical payload) | same |
| POST | `/v1/checkpoints/{id}/verify` (manual signature verification) · `/v1/checkpoints/verify` (full anchored verification) | same |
| GET | `/v1/checkpoints/verifications` (history) · `/v1/signing/keys` (trusted public keys) | same |
| POST | `/v1/checkpoints/create` · `/v1/signing/rotate` | SuperAdmin |

## Stage 2 configuration

| Variable | Default | |
|---|---|---|
| `AUDIT_SIGNING_ENABLED` | `true` | `false`: ledger works, nothing is signed |
| `AUDIT_SIGNING_PROVIDER` | `local` | the isolated signer container |
| `AUDIT_CHECKPOINT_EVENT_THRESHOLD` / `AUDIT_CHECKPOINT_INTERVAL_SECONDS` | `500` / `900` | the hybrid schedule |
| `AUDIT_CHECKPOINT_MAX_EVENTS` | `5000` | cap per checkpoint (backlogs are caught up in order) |
| `AUDIT_CHECKPOINT_POLL_SECONDS`, `…_LEASE_SECONDS`, `…_RETRY_BASE_SECONDS`, `…_RETRY_MAX_SECONDS` | `10`, `120`, `15`, `600` | scheduler timing |
| `AUDIT_SIGNER_SERVICE_KEY` | generated per install | shared secret for the HMAC between Audit Service and signer |
| `AUDIT_DB_SIGNER_PASSWORD` | generated per install | password of the read-only `audit_signer` role |
| `AUDIT_CHECKPOINT_DIRECTORY` | `/var/lib/audit-checkpoints` | protected store (signer: read/write, Audit Service: read-only) |
| `AUDIT_KEY_DIRECTORY`, `AUDIT_KEY_PASSPHRASE_FILE`, `AUDIT_SIGNER_STATE_DIRECTORY` | `/run/audit-keys`, `/run/audit-secrets/key-passphrase`, `/var/lib/audit-signer` | signer only |
| `AUDIT_CHECKPOINT_REPLICA_DIRECTORY`, `AUDIT_CHECKPOINT_REPLICA_REQUIRED` | unset, `false` | optional second location |
| `AUDIT_TRUST_ANCHOR_FINGERPRINT` | unset | pinned trust-root fingerprint |
| `AUDIT_ENVIRONMENT_LABEL` | `local-dev` | display label only |

(Where the requirement text names `AUDIT_ENVIRONMENT_ID=local-dev`: the environment *identity* is deliberately a UUID generated inside each database — a hand-set name such as
`local-dev` would be identical on every laptop, which is exactly the accidental sharing to avoid — and the human-readable name is `AUDIT_ENVIRONMENT_LABEL`.)

## Stage 2 tests

```bash
docker compose exec -T audit-service python -m unittest discover -s tests      # Stage 1 + Stage 2 (234 tests)
docker compose exec -T audit-service python -m tests.demo_tamper               # Stage 1 vs Stage 2 against real tampering (disposable DB)
```

They use real Ed25519 keys, real encrypted PEM files, real protected-store files, the real read-only DB role and the real HMAC-authenticated signer API, with the
signer running in-process; only the clock can be advanced. Coverage: key generation/persistence/permissions/restart/loss; the 500-event and 15-minute rules and empty chains;
concurrent workers, lease takeover, retries/backoff/alerts, storage and signer failures; crash recovery and state rebuild; modified/deleted/reordered events; a recomputed
whole chain; truncation; forged signatures; deleted/substituted checkpoints; untrusted/retired/unauthorised keys; replaced or foreign registries; rotation and historical
verification; installation and tenant isolation; API authorisation; Stage 1 regression.

## Manual end-to-end guide (Stage 2)

```bash
# 0. one-time per installation (add AUDIT_DB_SIGNER_PASSWORD and AUDIT_SIGNER_SERVICE_KEY to .env first: see .env.example)
docker compose up -d audit-service audit-signer
docker compose run --rm audit-signer-init            # prints the key fingerprint; run it ONCE
docker compose logs -f audit-service | grep -i checkpoint

# 1. create some audit events (sign in/out, edit a customer ...). A checkpoint appears after 500 events or 15 minutes:
#    Admin Portal -> Administration -> Security & Compliance -> Audit Trail -> "Signed checkpoints"
#    (to see it immediately as SuperAdmin: "Create checkpoint now")
# 2. "Verify signatures & anchors"  -> Verified (or Unsigned events pending)
# 3. Persistence: docker compose up -d --force-recreate audit-signer audit-service  -> same key, same checkpoints, signing continues
# 4. Rotation (SuperAdmin): "Rotate signing key" -> new key version; older checkpoints still verify
# 5. Failure handling: docker compose stop audit-signer -> alerts "SIGNER_UNAVAILABLE", pending events grow, nothing is faked;
#    docker compose start audit-signer -> "CHECKPOINT_RECOVERED"
# 6. Tampering: python -m tests.demo_tamper (safe, disposable) - or on a scratch installation, as the schema owner:
#    ALTER TABLE audit.events DISABLE TRIGGER USER;  (rewrite events and recompute hashes / truncate)  ALTER TABLE audit.events ENABLE TRIGGER USER;
#    then "Verify chain" says valid, while "Verify signatures & anchors" reports Checkpoint mismatch.
```
