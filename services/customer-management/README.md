# Customer Management

The back end of the **individual customer portal**. Policyholders sign in with the credentials the post-issuance process
already generates, then see their policies, premiums, claims, documents and profile. Design: `docs/customer-portal/individual-portal-blueprint.md`.

It owns **only customer sign-in and portal state**. Every insurance fact (policies, premiums, claims, documents) stays in
tenant-service and is read through a narrow, signed, customer-safe adapter — no rule is duplicated here.

```
Browser ── customer-portal (Next.js, :3009) ── BFF, httpOnly cookies
                      │  server-to-server
                      ▼
              api-gateway  /customer-management/v1/*   (public routes only; /internal/* is never proxied)
                      ▼
              customer-management (:8009 / host :8019)  ── schema customer_management (own DB roles)
                      │  HMAC-signed (CM_TO_TENANT_KEY)
                      ▼
              tenant-service  /internal/customer-portal/v1/tenants/{t}/customers/{c}/…   (ownership checked per call)
```

## Credentials: who is the authority

| Moment | What happens |
|---|---|
| Ops press **Provision portal access** (post-issuance step 2) | tenant-service mints username (policyholder ID) + 10-char temporary password as before, shows the password to ops **once**, and sends the **bcrypt hash only** to `PUT /internal/v1/accounts`. Plaintext never crosses services. |
| Customer already signed in and chose a password (second policy, repeat click) | Customer Management answers `already_active`; **nothing changes**, no new password is issued. Only an explicit `reset: true` (the staff "Reset password" button) replaces it, revokes every session and is audited. |
| Customer signs in | Verified here against the hash. Temporary password → a `pwd_change`-scope token that can only change the password. |
| Customer changes password | Stored here (authority from now on) and mirrored one-way to the legacy `customer_portal_accounts` row so staff see "activated" and a rollback cannot lock customers out. |
| Accounts issued before this service existed | `python -m app.backfill` imports them with their existing hashes; already-handed-out temporary passwords keep working. Idempotent, never overwrites. |

`PORTAL_PROVISIONING_MODE=legacy` (tenant-service) switches the hand-off off and restores the original single-service behaviour.

## Public API (`/v1`, via the gateway at `/customer-management/v1`)

| | |
|---|---|
| `POST /auth/login` · `/auth/refresh` · `/auth/logout` | sign-in; rotating refresh token (reuse revokes the session; a 10 s race window is tolerated for two tabs) |
| `POST /auth/password/first-change` · `/auth/password/change` | forced change of the temporary password / voluntary change (ends other sessions) |
| `GET /me` · `PATCH /me/preferences` | account, language |
| `GET /dashboard` | aggregate with per-section availability (partial failures degrade, not fail) |
| `GET /policies` · `/policies/{id}` · `/policies/{id}/premiums` | individual policies only; 404 for anything not the caller's |
| `GET /payments` · `POST /policies/{id}/premiums/{sid}/pay` | premium overview; **simulated** payment, `Idempotency-Key` required, amount re-checked server-side |
| `GET /claims` · `/claims/{id}` · `/policies/{id}/claims/options` · `POST /policies/{id}/claims` · `POST /claims/{id}/documents/{key}` | self-claims (hospitalisation, disability); death claims are refused by design |
| `GET /documents` · `GET /documents/download?handle=` | opaque handles, streamed; no file paths |
| `GET/PATCH /profile(/contact)` | contact edits need the password; identity fields are read-only |
| `GET /notifications` · `POST /notifications/read` | derived from live data; only read marks are stored |
| `GET /healthz` · `/readyz` | liveness / readiness |

Internal (`/internal/v1`, HMAC `TENANT_TO_CM_KEY`, caller `tenant-service`): `PUT /accounts`, `GET /accounts/by-customer/{id}`, `POST /accounts/{id}/suspend|release`.

Errors: `{"error":{"code","message","details"}}` with stable codes; the portal translates by code.

## Security properties (each has a test)

* The customer is identified **only** from the session; `tenant_id`/`customer_id` for every upstream call come from the account row, never the request.
* Customer tokens: own secret (`CM_JWT_SECRET`), issuer, audience and `typ: at+jwt`; staff tokens are rejected and vice-versa.
* Sign-in throttling by typed username **and** by IP (counts unknown usernames too, so it cannot be used to enumerate); lockout; generic failures; constant-ish work for unknown users.
* Passwords: bcrypt (same scheme as the issued hashes), policy checks, history of events never contains secrets.
* Least-privilege DB roles; audit table is append-only for the app role; no access to other services' tables.

## Run

```bash
docker compose up -d --build customer-management      # provisions the schema + roles, migrates, starts (host :8019)
docker compose exec customer-management python -m unittest discover -s tests -t .      # 34 tests, disposable DB
docker compose exec tenant-service python test_customer_portal_internal.py              # 14 adapter tests
docker compose exec customer-management python -m app.backfill --dry-run                # legacy accounts
```

Configuration (all in `.env`, see `app/config.py`): `CM_DB_OWNER_PASSWORD`, `CM_DB_APP_PASSWORD`, `CM_JWT_SECRET`,
`CM_TO_TENANT_KEY`, `TENANT_TO_CM_KEY`, optional `CM_PAYMENTS_ENABLED`, throttling and session lengths.
