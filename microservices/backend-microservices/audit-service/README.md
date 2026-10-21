# Audit Service

A centralized, tenant-isolated, **SHA-256 hash-chained** audit ledger for GetInsuredAI.

* Every significant business operation is recorded as an immutable audit event: who, what, when, on which entity, before/after, outcome.
* Events are chained per tenant (and one platform chain for system events). Editing, deleting or reordering a recorded event is **detected** by verification.
* Append-only storage is enforced by the database itself (triggers + a least-privilege role), not only by application code.
* Delivery is reliable: producers write a **transactional outbox** row in the same database transaction as the business change.

> **Stage 1** is the hash-chained ledger (this document, first half). **Stage 2** adds Ed25519-signed checkpoints,
> an isolated signer, a trusted key registry, protected checkpoint storage and anchored verification
> ([jump to Stage 2](#stage-2-signed-checkpoints)). **Stage 3** adds monthly partitioning, compressed + encrypted + signed archives in a local
> MinIO AIStor Free bucket, retention policies, legal holds, retrieval and safe removal of archived months from PostgreSQL
> ([jump to Stage 3](#stage-3-archival-retention-and-cold-storage)). Still out of scope: AWS S3 / cloud KMS / Vault / HSM, blockchain, per-employee keys.
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
Identity comes from tenant-service `/auth/me` on the caller's own token; `AUDIT_READ_ROLES` (default `SuperAdmin`; add `Admin` to let tenant administrators read their own tenant's chain) decides who may read.

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
| `AUDIT_READ_ROLES` | `SuperAdmin` | roles allowed to read (`Admin` = tenant administrators, own tenant only) |
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


# Stage 3: archival, retention and cold storage

Hot storage (PostgreSQL) keeps recent history; older history is **compressed (zstd), encrypted (AES-256-GCM), signed and kept in a local MinIO AIStor Free bucket**, stays searchable and verifiable, and only then may leave PostgreSQL. Nothing in Stages 1 and 2 changed meaning: event hashes, chain ids, checkpoint signatures and every API contract are unchanged. Everything runs locally in Docker; no AWS, no external KMS, no blockchain.

```
 events (monthly partitions) ──► archive worker ──► local file ──encrypt/compress──► MinIO AIStor (private, versioned, Object Lock)
        ▲  (Stage 1 hash chain,        │  verify range, export, upload,            data.iaar  manifest.json  signature.json  checkpoints.json
        │   Stage 2 checkpoints)       │  read BACK and re-verify, then catalog
        │                              └──► audit-signer signs the manifest (same Ed25519 key as checkpoints, domain-separated)
        └── hot cleanup (separate, gated step) detaches whole fully-archived months; archives + signed manifests keep proving them
```

* **Hot window**: default **6 months** (`AUDIT_HOT_RETENTION_MONTHS`; the `retention_policies` table overrides it per tenant and category). The cut-off is the first day of the month, so archives line up with partitions.
* **Archive unit**: a contiguous range of **one chain**, ending exactly on a **signed checkpoint boundary**. Archives of a chain form their own hash chain (`previous_archive_hash`), so a deleted or substituted archive is detectable even if every remaining one is valid.
* **State machine** (durable, resumable, idempotent): `ELIGIBLE → VERIFYING → EXPORTING → UPLOADING → VALIDATING → ARCHIVED → HOT_CLEANUP_ELIGIBLE → HOT_CLEANUP_COMPLETED` (+ `FAILED`, remembering where to resume). The database trigger refuses skipped or backward transitions. Jobs are leased (a crashed worker's lease expires and another takes over); one open job per chain; the same job run twice at once archives exactly once.
* **VALIDATING** reads the archive **back from MinIO** and re-verifies checksum, signature, decryption and every event hash before the catalog entry is written. The catalog row and the `ARCHIVED` transition are one transaction.
* **Archiving never deletes or alters anything in PostgreSQL.** A failed job leaves all source records in place and raises an alert.

| Piece | Where |
|---|---|
| Archive worker, state machine, planner | `app/archive/worker.py`, `app/archive/scheduler.py` |
| Encryption, compression, archive format, Bloom filters | `app/archive/crypto.py`, `app/archive/format.py` |
| S3 adapter (MinIO / any S3-compatible server) | `app/archive/store.py` |
| Verification, retrieval, evidence packages, hot cleanup, retention policy | `app/archive/verify.py`, `retrieval.py`, `evidence.py`, `cleanup.py`, `policy.py` |
| Signed manifests (shared with the signer) | `shared/audit/archive_manifest.py`, signer `POST /v1/archives/sign` |
| Operator commands (`init-keys`, `status`, `seed-aged`) | `app/archive/cli.py` |
| MinIO bootstrap (bucket, Object Lock, identities) | `infrastructure/minio/init.sh`, `minio` + `minio-init` in `docker-compose.yml` |
| Migrations | `migrations/0003_partition_events.sql`, `0004_archive.sql` (+ `rollback/`, `optional/`) |
| Admin UI | `frontend/app/admin/audit-trail/ArchivePanel.tsx` (section **Archive & retention** on the Audit Trail page) |

## Trust model

| Thing | Trusted because | Where it lives |
|---|---|---|
| Event content | SHA-256 chain + signed checkpoints (Stage 1/2) | PostgreSQL, then the archive |
| Archive manifest | Ed25519 signature by the **existing** signer key, verified against the trusted registry | `audit-checkpoints` volume (`archives/…`), **outside PostgreSQL and outside MinIO**; a copy also sits beside the data in MinIO |
| Archive bytes | SHA-256 in the signed manifest + authenticated encryption | MinIO |
| Catalog table | **not** trusted; an index only. Every verification cross-checks it against the signed manifest | PostgreSQL |
| Master key (KEK) | operator-controlled | its own volume `audit-archive-keys`, mounted read-only; never in PostgreSQL, MinIO or the repo |

The signer signs a manifest only after **re-reading the ledger itself**: chain identity, the exact previous signed archive, checkpoint coverage re-derived from its own store, and the events' hashes and digest for the range. The audit service cannot make it sign anything else.

**Encryption.** Per archive a random 256-bit data key encrypts the file in 1 MiB AES-256-GCM chunks (bounded memory). The data key is wrapped (RFC 3394) by the master key and stored in the archive header; the key id is in the manifest, so master keys can be rotated by adding a new one (old archives keep naming theirs). Each chunk's AAD binds the header hash, the chunk index and a "final" flag: reordering, dropping, appending or truncating chunks fails authentication. Archives are encrypted **in the application before upload**; MinIO never sees plaintext or the key.

**Master key (KEK).** `docker compose run --rm audit-archive-init` creates it **once** (it refuses to run again, so it can never orphan archives). **Back up the `audit-archive-keys` volume separately from the database and MinIO.** If it is lost the archives cannot be decrypted; the signed manifests, checkpoints and the catalog stay verifiable, only content access is lost. Never commit it.

## MinIO AIStor Free: setup, ports and Docker commands

Object storage is **MinIO AIStor Free (single node)**, pinned to `quay.io/minio/aistor/minio:RELEASE.2026-09-19T17-05-25Z`. (The community MinIO used first is archived upstream, with no binaries and no maintenance, and has been removed.) The application talks plain S3 through boto3 with two least-privilege identities; the MinIO root account is used only by the one-off `minio-init` job.

### Ports and volumes

| What | Host address | Inside Docker | Notes |
|---|---|---|---|
| MinIO S3 API | `127.0.0.1:9000` | `http://minio:9000` | the audit service uses the Docker address; host tools use `localhost` |
| MinIO web console | `http://localhost:9001` | `minio:9001` | sign in with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from `.env` (the application keys cannot sign in) |
| Audit service API | `localhost:8030` (gateway: `localhost:8010/audit/v1`) | `audit-service:8020` | |
| Audit signer | not published | `audit-signer:8021` | reachable only by the audit service |

MinIO's ports are bound to `127.0.0.1`: nothing else on your network can reach them. If 9000/9001 are taken (`ss -ltn | grep -E ':(9000|9001) '`), change the left-hand numbers of the `minio` service's `ports:` in `docker-compose.yml`; the audit service is unaffected because it uses the Docker network.

| Volume | Holds | Back up? |
|---|---|---|
| `aistor-data` | the encrypted archive objects (the only copy once PostgreSQL months are removed) | **yes**, like any data volume |
| `audit-archive-keys` | the archive master key (read-only in the audit service) | **yes, separately and offline** |
| `audit-archive-work` | scratch space while building archives | no |
| `audit-checkpoints` | signed checkpoints, signed archive manifests, key registry (Stage 2) | yes |

### One-time setup per installation

```bash
# 1. Secrets in .env (see .env.example). Generate every value locally; nothing secret is committed:
python3 -c "import secrets; print(secrets.token_urlsafe(30))"
#    MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (16+ chars), AUDIT_ARCHIVE_WRITER_KEY/SECRET, AUDIT_ARCHIVE_READER_KEY/SECRET

# 2. AIStor Free license: download the free license file from MinIO and keep it OUTSIDE the repository
mkdir -p ~/.config/insurance-ai && chmod 700 ~/.config/insurance-ai
#    save it as ~/.config/insurance-ai/minio.license, then:
chmod 600 ~/.config/insurance-ai/minio.license
echo "AISTOR_LICENSE_FILE=$HOME/.config/insurance-ai/minio.license" >> .env

# 3. Start MinIO, create the bucket and identities (idempotent), create the archive master key (once)
docker compose up -d minio
docker compose run --rm minio-init            # ends with "object lock: VERIFIED" and the two identities
docker compose run --rm audit-archive-init    # prints the key id; BACK THE KEY UP (see "Master key")

# 4. Start the audit service and signer (see Stage 2 for audit-signer-init), then check everything the archive depends on
docker compose up -d audit-service audit-signer
docker compose exec audit-service python -m app.archive.cli status
```

`status` prints `master_key: true` and a bucket report with `reachable`, `versioning`, `object_lock` and `private` all `true`. The container **refuses to start** (and says why) without a license file or without a root password of 16+ characters. AIStor Free is under MinIO's license (not AGPL); read the terms before redistributing this stack.

### Everyday commands

```bash
docker compose ps minio                                    # healthy?
curl -fsS http://localhost:9000/minio/health/live          # liveness (200)
docker compose logs -f minio                               # server log
docker compose logs -f audit-service | grep -i archive     # archive scheduler / jobs
docker compose restart minio                               # data and settings survive (named volume)
docker compose up -d --force-recreate minio                # recreate the container; same data
docker compose stop minio                                  # archiving jobs park as FAILED and resume by themselves when it is back

# look inside with the MinIO client that ships in the image (root credentials come from the container's own environment)
docker compose exec minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null \
  && mc license info local && mc admin info local && mc ls --versions -r local/insurance-audit-archive'
```

### Back up, restore, upgrade

```bash
# back up the archive objects (stop MinIO first so the copy is consistent), then start it again
docker compose stop minio
docker run --rm -v insurance-ai_aistor-data:/data:ro -v "$PWD":/backup alpine:3.21 tar czf /backup/aistor-data-$(date +%F).tgz -C /data .
docker compose start minio

# restore into an empty volume (docker compose rm -sf minio; docker volume rm insurance-ai_aistor-data; docker compose up --no-start minio)
docker run --rm -v insurance-ai_aistor-data:/data -v "$PWD":/backup alpine:3.21 tar xzf /backup/aistor-data-YYYY-MM-DD.tgz -C /data

# upgrade AIStor: back up first, change the pinned tag in docker-compose.yml (minio and minio-init), then
docker compose pull minio && docker compose up -d minio && docker compose run --rm minio-init
```

Keep backups outside the repository and away from the machine's only disk. The volume name carries the compose project prefix (`insurance-ai_` here; check `docker volume ls`).

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `minio` exits: "AIStor Free license file missing" | `AISTOR_LICENSE_FILE` unset or wrong path in `.env`; the file must exist and be non-empty |
| `minio` exits: "MINIO_ROOT_USER … 16+ characters" | set both root variables in `.env` |
| Jobs `FAILED` with `STORE_UNAVAILABLE` | MinIO is down or restarting; they resume automatically once `docker compose ps minio` shows *healthy* |
| Jobs `FAILED` with `STORE_CAPABILITY` | the bucket lacks Object Lock/versioning or is public. Object Lock can only be set when a bucket is created: recreate the bucket (`minio-init` creates it correctly) |
| `STORE_ACCESS_DENIED` / `STORE_BUCKET_MISSING` | wrong writer/reader secrets in `.env`, or the bucket was never created: run `docker compose run --rm minio-init` |
| `KEK_UNAVAILABLE` | archive master key not initialised or its volume is missing: `docker compose run --rm audit-archive-init`, or restore the key from its backup |
| `port is already allocated` on 9000/9001 | see "Ports and volumes" |
| Compose warns that a volume "was not created by Docker Compose" | the volume was made by hand; recreate it through compose (copy the data out and back) |
| Real-MinIO tests leave test objects (1-day Object Lock) | clean them with the root account, keeping your real archive prefix (see "Stage 3 tests") |

### Migration from the community MinIO (done 2026-10-21)
The legacy volume was backed up, then AIStor was started on a **scratch copy** of that backup to prove it reads the legacy on-disk format: same objects and **same version ids**, retention intact, bucket private/versioned/locked, policies and identities intact, so no S3-level re-copy was needed and the catalog's pinned `data_version_id` values stayed valid. After cutover the migrated archive deep-verified on AIStor and the Stage 3 suites passed. After sign-off the old build, service, volume, image and migration backups were removed. AIStor now holds the only copy of the archive objects.

## Hot cleanup (separate and gated)
1. **Promote** (after the safety period, default 7 days): the archive is **re-verified in full from MinIO**, no legal hold may apply, and the policy must allow cleanup. Only then does the catalog entry get its one-time cleanup approval.
2. **Remove**: whole monthly partitions only. The SQL function `remove_event_partition()` independently refuses a partition unless the month is past, **every chain's events in it are covered by an approved archive**, and no legal hold applies. Default mode **detach** keeps the partition as `detached_events_pYYYYMM` (re-attachable); `drop` must be requested.
3. `AUDIT_AUTO_HOT_CLEANUP=false` by default. Manual: Archive & retention → Review hot cleanup, or `POST /v1/archive/cleanup` (dry run by default, a real run needs `confirm`).

After removal, chain verification starts at the archive boundary (`details.archived_prefix`), the signed checkpoints and manifests keep anchoring the removed history, new events keep chaining and checkpointing, and global idempotency survives through `event_sources`. A removed month is often in the middle of an archive; the hot chain then starts at the first surviving event, whose hash is authenticated by the later signed checkpoints.

## Retention
`retention_policies` is **data, versioned, tenant-aware**, per category (`underwriting_policy`, `claims`, `financial`, `administration`, `ai_decisions`, `operational`; an event's category comes from its `module`, see `app/archive/policy.py`). **No legal period is hard-coded**: the shipped defaults are "6 months hot, keep indefinitely, not approved". A chain mixes categories and archives are cut by position, so the chain's hot window is the **longest** of its categories'. **Archives are never deleted by this system**; `retention_until` only marks when deletion could first be reviewed, and a legal hold blocks even that. Holds are placed/released by the platform administrator, are append-only, and block hot cleanup.

## Retrieval (never into the live chain)
`POST /v1/archive/retrievals` picks the archives that may match (catalog range, module/action, then a per-archive **Bloom filter** for entity/actor/case), a background job **verifies each archive** and copies matching events to `archive_staging`, flagged *archived · verified*. The live `events` table and chain are untouched. Staged rows expire (`AUDIT_RETRIEVAL_TTL_HOURS`, 24). Tenants only see their own archives (a foreign archive answers 404). In the UI, a sequence number that has moved to cold storage is shown as *in cold storage, archive #n*, never as "missing".

## Stage 3 API (additions; same RBAC as Stage 1)

All under `/v1/archive/…` (gateway: `/audit/v1/archive/…`). Admin = own tenant, read-only; SuperAdmin = all, plus the controls.

| Method | Path | Who |
|---|---|---|
| GET | `/status` — storage capabilities, counts, ranges, jobs, holds, policies | Admin (own tenant) · SuperAdmin |
| GET | `/catalog` (search) · `/catalog/{id}` (with verification history) · `/jobs` · `/jobs/{id}` | same |
| POST | `/verify` (`deep` re-hashes every event) · `/verify-chain` (anchored, incl. archived history) | same |
| GET | `/catalog/{id}/evidence` — zip: signed manifest, covering checkpoints, trusted keys, report, standalone `verify_evidence.py` (`?include_data=true` adds the encrypted archive; the key is never included) | same |
| POST / GET | `/retrievals` · `/retrievals/{id}` · `/retrievals/{id}/events` (asynchronous) | same |
| GET | `/policies` · `/holds` | same |
| PUT / POST | `/policies` (versioned) · `/holds` · `/holds/{id}/release` · `/jobs/{id}/retry` · `/run` (plan archiving, dry run by default) | SuperAdmin |
| GET / POST | `/cleanup/plan` · `/cleanup` (dry run by default; a real run needs `confirm`) | SuperAdmin |

There is no delete/update route for archives. Every sensitive action (verify, evidence, retrieval, policy, hold, cleanup) is recorded in the audit ledger, and fails if it cannot be recorded.

## Stage 3 configuration

Set these in `.env` (names in **bold** are passed through `docker-compose.yml`; the rest keep their defaults unless you add them to the `audit-service` environment). Secrets are generated locally and never committed.

| Variable | Default | |
|---|---|---|
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | – (required) | MinIO root account: used only by `minio-init` and for the console |
| `AISTOR_LICENSE_FILE` | – (required) | path of the AIStor Free license file, **outside the repo**; mounted read-only |
| **`AUDIT_ARCHIVE_WRITER_KEY/SECRET`**, **`AUDIT_ARCHIVE_READER_KEY/SECRET`** | – (required) | application identities: writer = put/get/list (no delete), reader = get/list |
| **`AUDIT_ARCHIVE_BUCKET`** | `insurance-audit-archive` | private, versioned, Object-Lock bucket |
| **`AUDIT_ARCHIVE_S3_ENDPOINT`** | `http://minio:9000` | S3 endpoint the audit service uses |
| **`AUDIT_ARCHIVING_ENABLED`** | `true` | `false`: ledger, checkpoints and verification run, nothing is archived |
| **`AUDIT_HOT_RETENTION_MONTHS`** | `6` | fallback hot window; `retention_policies` overrides it |
| **`AUDIT_ARCHIVE_SCHEDULE`** | `monthly` | `monthly` (cut-off on a month boundary) or `continuous` (rolling) |
| **`AUDIT_ARCHIVE_INTERVAL_SECONDS`** | `300` | how often archivable history is looked for (planning is cheap and idempotent) |
| **`AUDIT_ARCHIVE_COMPRESSION`** | `zstd` | `zstd` or `none` |
| **`AUDIT_AUTO_HOT_CLEANUP`** | `false` | remove fully archived months from PostgreSQL automatically (keep `false` in development) |
| **`AUDIT_CLEANUP_MODE`** | `detach` | `detach` (re-attachable) or `drop` |
| **`AUDIT_CLEANUP_SAFETY_DAYS`** | `7` | wait this long after archiving before a hot copy may be removed |
| **`AUDIT_ARCHIVE_LOCK_MODE`**, **`AUDIT_ARCHIVE_LOCK_DAYS`** | `GOVERNANCE`, `30` | Object Lock retention on every archive object (anti-tamper window, **not** a legal period); `…_REQUIRE_OBJECT_LOCK=true` refuses buckets without it |
| **`AUDIT_ARCHIVE_TEST_MODE`**, **`AUDIT_ARCHIVE_TEST_HOT_SECONDS`** | `false`, `120` | **development only**: the hot window becomes N seconds so the cycle can be watched in minutes; refused unless `AUDIT_ENVIRONMENT_LABEL=local-dev` |
| `AUDIT_ARCHIVE_MAX_EVENTS`, `AUDIT_ARCHIVE_CHUNK_BYTES`, `AUDIT_ARCHIVE_FETCH_BATCH` | `2000000`, `1048576`, `2000` | bounds per archive / per encrypted chunk / per database read |
| `AUDIT_ARCHIVE_LEASE_SECONDS`, `AUDIT_ARCHIVE_RETRY_BASE_SECONDS`, `AUDIT_ARCHIVE_RETRY_MAX_SECONDS` | `600`, `30`, `1800` | job lease and retry backoff |
| `AUDIT_RETRIEVAL_TTL_HOURS`, `AUDIT_RETRIEVAL_MAX_EVENTS` | `24`, `200000` | staged retrieval lifetime and size cap |
| `AUDIT_ARCHIVE_KEY_DIRECTORY`, `AUDIT_ARCHIVE_WORK_DIRECTORY` | `/run/audit-archive-keys`, `/var/lib/audit-archive-work` | master key volume (read-only) and scratch space |

## Migrations (existing databases)
`0003_partition_events` converts `events` to monthly range partitions inside one transaction, validating row counts, per-chain heads and a content digest before committing (the old table is kept as `events_legacy_v1`, unreadable by the app roles). `migrations/rollback/0003_unpartition_events.sql` reverses it (tested); `migrations/optional/0003_drop_legacy_events.sql` reclaims the legacy copy once you are satisfied. `0004_archive` adds the archive tables and functions. Neither changes a single event hash. Migrations run automatically when `audit-service` starts.

## Stage 3 tests

```bash
docker compose exec -T audit-service python -m unittest discover -s tests          # Stage 1 + 2 + 3 (338 tests at the last full run)
docker compose exec -T audit-service python -m unittest tests.test_archive_core tests.test_archive_integrity tests.test_archive_operations tests.test_archive_api tests.test_rollback_0003
docker compose exec -T audit-service python -m unittest tests.test_archive_minio   # the real AIStor in the stack (skipped if unreachable)
docker compose exec -T audit-service python -m tests.benchmark_archive 50000       # benchmark: disposable DB + real MinIO
```

Real PostgreSQL roles, real Ed25519 signer, real encryption; an in-memory S3 stand-in (with outage injection and tampering) for the failure scenarios and the real MinIO for the integration tests. Coverage: eligibility and the 6-month window; per-category and per-tenant policies; compression and encryption (no plaintext in the object, chunk reorder/truncate/extend detected, wrong or missing key); signed manifests and domain separation; checkpoint boundaries; archive chain; flipped/truncated/replaced/deleted objects and manifests, forged and edited manifests, catalog tampering; object-store, signer and key outages with resume; crash and lease takeover; duplicate execution; unsafe cleanup refused by the database; legal holds; retrieval; tenant isolation; evidence packages; the 0003 rollback.

The real-MinIO tests write objects with a 1-day Object Lock under their own database's environment id (the application identities cannot delete them). Clean them with the root account, keeping your real archive prefix (`<environment_id>`, from `SELECT environment_id FROM audit.environment`):

```bash
docker compose exec -T minio sh -c 'B=insurance-audit-archive; KEEP=<your environment_id>
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  for p in $(mc ls local/$B/v1/ | cut -d" " -f7- | tr -d /); do [ "$p" = "$KEEP" ] || mc rm --recursive --versions --force --bypass local/$B/v1/$p/; done'
```

Measured on a developer laptop (50,000 events, real AIStor): ingestion ≈ 4,400 events/s; archive end to end 8 s (≈ 6,200 events/s) at **8.4× compression**; upload ≈ 219 MB/s, download ≈ 650 MB/s; deep verification of the archive 1.2 s; entity lookup in the archive ≈ 1.3 s; 5,000-event range retrieval ≈ 1.5 s; catalog search ≈ 1 ms; peak memory ≈ 190 MB; **53 MB reclaimed** from hot storage for that month. The expected workload (500–1,500 events/min, bursts of 5,000+) is far below these rates.

## Manual end-to-end guide (Stage 3)

```bash
# 0. one-time per installation: see "One-time setup per installation" above (license, secrets, minio, minio-init, audit-archive-init)

# 1. dev data: synthetic history aged 9 -> 7.5 months (archivable immediately); checkpoints appear within ~10 s
docker compose exec audit-service python -m app.archive.cli seed-aged --months 9 --newest-months-ago 7.5 --events 3000
docker compose logs -f audit-service | grep -i -E "checkpoint|archive"      # "archive job … is ARCHIVED" within ~5 minutes

# 2. Admin Portal -> Administration -> Security & Compliance -> Audit Trail -> "Archive & retention":
#    archives, sizes, compression ratio, storage / Object Lock / key status. Verify, Deep verify, Evidence.
#    "Search archived history" -> events marked "Archived · verified". Look at the bucket: http://localhost:9001 (root credentials)

# 3. hot cleanup (SuperAdmin): "Review hot cleanup" shows which months could leave PostgreSQL and why the others stay.
#    A real removal needs the safety period to pass (or ignore_safety_period via the API) and an explicit confirmation.

# 4. failure drills
docker compose stop minio             # jobs park as FAILED (resume at UPLOADING) with an alert; nothing is lost
docker compose start minio            # they finish by themselves
docker compose stop audit-signer      # same for signing; start it again to resume
docker compose up -d --force-recreate minio audit-service      # data, jobs and verification survive

# 5. evidence: download the package from the UI, unzip it, then
pip install cryptography && python3 verify_evidence.py
```

## Limitations (read this)
* **Hot verification of a mid-archive start** takes its starting hash from the first surviving event; it is authenticated by the later signed checkpoints (any change breaks them), not by a separately stored value.
* **Archives end at checkpoint boundaries ≤ the cut-off**, so a few recent events (up to one checkpoint interval) wait for the next cycle. Seeded data that straddles the cut-off in a single checkpoint stays hot until the whole checkpoint is old.
* **Full compromise of the host** (signer volumes plus MinIO plus master key) is out of scope, as in Stage 2. Object Lock GOVERNANCE can be bypassed by whoever holds the MinIO root account; use COMPLIANCE mode in production if that matters (it cannot be shortened).
* **Retention categories are inferred from `module`**; unmapped modules count as `operational`. The shipped periods are placeholders, not legal advice.
* **No automatic deletion of archives** exists by design; a deletion workflow would need approved periods, hold checks and a manual approval step (not built).
* **Master-key rotation** is supported by the format (archives name their key) but there is no re-wrap tool yet; losing the key loses content access.
* Retrieval is limited to `AUDIT_RETRIEVAL_MAX_EVENTS` (200,000) per request and reads whole archives (no range reads inside an archive).
* **Single AIStor Free node** (the license is single-node): durability is that of its volume; back it up like any other data. Multi-node is out of scope.
