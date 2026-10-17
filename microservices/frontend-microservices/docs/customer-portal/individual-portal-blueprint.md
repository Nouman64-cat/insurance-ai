# Customer Portal — Individual Customers: System Blueprint (Stage 0)

| | |
|---|---|
| **Status** | Draft for review — **no application code has been written for this stage** |
| **Stage** | 0 of N — architecture, boundaries, migration, APIs, screens, test matrix, deployment |
| **Scope** | Individual life-insurance customers (retail policies). Family and Corporate follow in later stages; this design leaves room for them (§5.2) |
| **Date** | 2026-10-13 |
| **Branch** | `feat/dev-customerportal` |
| **Companion work already in the repo** | Stage B post-issuance journey (steps 1–9) in `tenant-service` + `frontend/components/policy/*` |

---

## Contents

1. [Executive summary](#1-executive-summary)
2. [What the codebase actually contains (verified findings)](#2-what-the-codebase-actually-contains-verified-findings)
3. [Requirements traceability](#3-requirements-traceability)
4. [Target architecture](#4-target-architecture)
5. [Identity, authentication and authorization](#5-identity-authentication-and-authorization)
6. [Credential migration and the post-issuance integration](#6-credential-migration-and-the-post-issuance-integration)
7. [Integration with existing services (no duplicated business logic)](#7-integration-with-existing-services-no-duplicated-business-logic)
8. [Database design](#8-database-design)
9. [API specification](#9-api-specification)
10. [Frontend — customer-portal-app](#10-frontend--customer-portal-app)
11. [Full lifecycle coverage](#11-full-lifecycle-coverage-what-a-customer-can-do-per-phase)
12. [Security, authorization and fraud controls](#12-security-authorization-and-fraud-controls)
13. [Scenario and test matrix](#13-scenario-and-test-matrix)
14. [Deployment and integration strategy](#14-deployment-and-integration-strategy)
15. [Implementation roadmap](#15-implementation-roadmap)
16. [Risks, blockers and open decisions](#16-risks-blockers-and-open-decisions)
17. [Appendices](#17-appendices)

---

## 1. Executive summary

**What we are building.** A customer-facing product that is *separate from the staff platform in code, data, authentication, deployment and UI*:

| Piece | Name (proposed) | Tech | Owns |
|---|---|---|---|
| Backend | **`customer-portal-service`** | FastAPI, Python 3.12 | Customer **login identities**, sessions, step-up verification, notification inbox, payment sessions, customer-facing service requests, portal audit — in its **own PostgreSQL schema `customer_portal`** |
| Frontend | **`customer-portal-app`** | Next.js 14 (app router), Tailwind | The customer UI, and a server-side BFF that keeps tokens in `httpOnly` cookies |
| Existing | `tenant-service` (unchanged ownership) | FastAPI | Customers, policies, premiums, claims, renewals, reinstatement, endorsements, exits — **all insurance business logic stays here** |

**Five decisions that shape everything** (rationale in the sections referenced):

1. **The portal never reaches the staff API surface.** Customers talk only to `customer-portal-app` → `customer-portal-service`. The service reaches `tenant-service` through a **new, narrow, HMAC-signed internal router** that enforces ownership and returns customer-safe views (§7). The staff gateway gets **no** customer route.
2. **`customer-portal-service` is the credential authority.** The existing ops workflow ("Provision portal access" → username + one-time temporary password) is **preserved unchanged for ops**; behind it, `portal_service.py` stops minting+storing and instead calls the new service (§6). Existing `customer_portal_accounts` rows are imported with their bcrypt hashes, so already-issued temporary passwords keep working.
3. **One account per customer, many policies.** The account is keyed by `(tenant_id, customer_id)`. Issuing another policy never creates or resets credentials (§6.5). A policy list is resolved live from `tenant-service`, never copied into the portal as a source of truth.
4. **Customer tokens and staff tokens cannot be confused.** Different signing secret, issuer, audience, token type, cookie names, user table and verification code path (§5.6).
5. **Hardening of the existing unauthenticated staff routes is a hard prerequisite for go-live** (blocker **B-01**, §16). Today `post_issuance.py` (34 routes) and `pre_issuance.py` (19 routes) have **no authentication at all** and are reachable through the gateway. Without closing this, "prevent cross-customer access" cannot be guaranteed no matter how good the portal is.

**Top blockers before real customers can use this** (full register in §16): B-01 unauthenticated staff routes · B-02 no customer-verified contact channel / SMS provider for OTP · B-03 payment gateway is a mock whose `realize` flag comes from the caller · B-04 policyholder IDs are per-tenant counters (not globally unique, racy) · B-05 permissive gateway CORS · B-06 no login throttling anywhere in the platform.

**What Stage 0 delivers:** this document. Nothing else was changed in the repository.

---

## 2. What the codebase actually contains (verified findings)

Everything in this section was read from the repository on branch `feat/dev-customerportal`. File paths are given as `path` or `path::symbol` (line numbers are avoided because they drift). Anything *not* verified is marked **(unverified)**.

### 2.1 The post-issuance credential workflow today

| # | Finding | Evidence |
|---|---|---|
| F-01 | Credentials are minted by `provision()`: **username** = the customer's policyholder ID (fallback: email, then `user-<8 chars of customer id>`); **temporary password** = 10 random alphanumerics; **bcrypt hash**; an `invite_token` and `invite_expires_at` (7 days, env `PORTAL_INVITE_VALID_DAYS`); and a **placeholder** portal URL (`https://portal.insurance-ai.example/login`, env `CUSTOMER_PORTAL_URL`). | `services/tenant-service/services/portal_service.py` |
| F-02 | The module's own docstring says the portal is **mocked** and that "a real integration would swap this for the actual IdP / portal registration call; the router and DB shape would not change." The intended seam is exactly where this design plugs in. | same file |
| F-03 | The plaintext temporary password is returned **once** by `POST …/policies/{id}/onboarding/portal` and shown once in the ops UI with a *Copy* button. It is **never stored and never emailed**. | `routers/post_issuance.py::provision_portal`; `frontend/app/post-issuance/[policyId]/page.tsx` (`creds.temp_password`) |
| F-04 | The welcome email (`send_welcome`) carries the policyholder ID and the welcome-kit PDF, and tells the customer to "sign in to the customer portal" — **it contains no password**. | `routers/post_issuance.py::send_welcome` |
| F-05 | `CustomerPortalAccount` is **unique per `customer_id`** (not per policy) → the data model already means "one account, many policies". Columns: `tenant_id, customer_id, username, password_hash, status (Pending/Active/Suspended), must_reset, invite_token, invite_expires_at, last_login_at`. | `shared/models/core.py::CustomerPortalAccount` |
| F-06 | **`username` is not unique** anywhere (only `customer_id` is). | same |
| F-07 | **Nothing consumes `invite_token`, `invite_expires_at`, `must_reset` or `last_login_at`.** There is **no customer login endpoint** and no "set your password" flow — a repository-wide search finds the fields only in the model, the provisioning code and the onboarding read-model. | grep over `*.py`, `*.ts`, `*.tsx` |
| F-08 | `provision_portal` called on an **existing** account **regenerates** the password and sets `must_reset=True` (the UI labels it "Reset password"). It does not touch other policies. The onboarding checklist treats the portal step as done once any account row exists, so a second policy for the same customer does not need provisioning. | `provision_portal`; `services/onboarding_gate.py::compute_onboarding` |
| F-09 | `POST …/onboarding/reset` is a **DEV/TEST utility** that clears the customer's policyholder ID, contact details, **deletes the portal account** and the onboarding tracker. It has no environment guard. | `post_issuance.py::reset_onboarding` |
| F-10 | The policyholder ID is minted by `_next_policyholder_id` as `PH-{year}-{count of this tenant's customers that already have one + 1}` — **per tenant, count-based**. Two tenants will mint the same value; two concurrent requests can mint the same value; a deleted customer lowers the counter. It is reused across policies once assigned. | `post_issuance.py::_next_policyholder_id` |
| F-11 | Contact details live in `Customer.details` JSON (`contact_email`, `contact_phone`, …). There is **no verified-contact concept**. | `onboarding_gate.py::_contact`; `post_issuance.py::set_onboarding_contact` |
| F-12 | Email **is** configured in this environment (`EMAIL_PROVIDER=ses` with SES SMTP credentials present in `.env`). `email_utils.send_email` is best-effort and swallows failures. SMS/WhatsApp are **simulated** (logged) everywhere. *(Correction to earlier session notes: "email not configured" was an untested assumption; I never exercised a real send. Deliverability/SES sandbox status is **unverified**.)* | `.env` (presence only), `services/tenant-service/email_utils.py`, `post_issuance.py::remind_installment` |

### 2.2 Staff authentication (what the portal must not be confused with)

| # | Finding | Evidence |
|---|---|---|
| F-20 | Staff log in with `POST /auth/token` (email + password). The JWT is HS256, signed with `JWT_SECRET_KEY`, **24 h** expiry (`JWT_EXPIRE_MINUTES`, default 1440), claims `sub, email, tenant_id, role_id`. **No `iss`, `aud` or type claim.** | `tenant-service/routers/auth.py` |
| F-21 | The **same secret** is read by `tenant-service`, `api-gateway` (`dependencies.py`) and other services. The code default is the placeholder `"change-me-in-production"`; `.env` here sets a real 64-char value. | `auth.py`, `api-gateway/dependencies.py`, `.env` (presence/length only) |
| F-22 | Staff login has **no lockout and no rate limiting**: `User.failed_login_count` exists but is never incremented; no throttling library or middleware exists anywhere in `services/` or `shared/`. | `auth.py::login_for_access_token`; search for `slowapi|rate.limit|throttl` |
| F-23 | The staff frontend keeps the JWT in **`localStorage`** (`jwt_token`) and sets it as an axios default header; satellite apps (Underwriting Workbench, Automation Chat, Request Management, Customer Service) share a **single sign-on cookie** (`insurance_sso`, optionally on a shared parent domain). | `frontend/app/ClientLayout.tsx`, `frontend/lib/satellite/middleware.ts` |
| F-24 | Staff login error text is generic ("Incorrect email or password") — good; the portal must keep this property. | `auth.py` |

### 2.3 The gateway and the unauthenticated-route exposure (critical)

| # | Finding | Evidence |
|---|---|---|
| F-30 | The API gateway proxies path prefixes to `tenant-service` **without checking the token itself**: `/tenants/{id}/policies{path}`, `/customers`, `/cases`, `/artifacts`, `/families`, `/organizations`, etc. Whether a call is authenticated depends entirely on the route inside `tenant-service`. | `services/api-gateway/main.py` (the `@app.api_route` block) |
| F-31 | **Authentication coverage of `tenant-service` routers** (count of routes vs. references to an auth dependency): `post_issuance.py` 34 routes / **0**; `pre_issuance.py` 19 / **0**; `branches.py`, `roles.py`, `tenants.py`, `tokens.py`, `demo.py`, `llm_config.py` all **0**; `renewals.py` 14 / 3 and `reinstatement.py` 14 / 2 (only the decision/sweep endpoints are guarded); `policies.py` 10 / 5. Everything in the premium ledger, **payment collection**, endorsements, free-look cancellation, document download and onboarding is therefore callable by **anyone who can reach the gateway or `tenant-service` and knows a policy UUID**. | per-router grep (see Appendix A) |
| F-32 | `tenant-service` is **published on host port 8011**, and its CORS is `allow_origin_regex=https?://.*`; the **gateway CORS is the same with `allow_credentials=True`**. | `docker-compose.yml`, `tenant-service/main.py`, `api-gateway/main.py` |
| F-33 | `POST /premiums/{id}/collect` accepts a **client-supplied `realize` flag** (it exists to simulate gateway failures) and `manual` + `reference`. It must never be reachable from a customer browser. | `post_issuance.py::CollectBody` |
| F-34 | `policies.py` already has a scoping dependency `_policy_in_scope` — but it scopes **staff logins issued to acquisition sources** (agents/brokers), not customers. | `policies.py::_policy_in_scope`, `routers/auth.py::source_scope` |

### 2.4 Patterns already in the repo that this design deliberately reuses

| Pattern | Where | Reuse |
|---|---|---|
| **Own schema + restricted DB roles + checksummed SQL migrations + advisory lock + no cross-schema FKs** | `services/customer-service` (`provision.py`, `migrate.py`, `migrations/*.sql`), `services/request-management-service` | Copy the *pattern* for `customer_portal` |
| **Outbox → Kafka, consumer dedupe, idempotency keys, error envelope `{error:{code,message}}`** | `request-management-service` (README "Architecture") | Same shape in the portal |
| **HMAC-SHA256 service-to-service signatures** (timestamp ± 300 s, method, path+query, body hash; caller header; one key per integration; endpoints "not reachable through the API gateway") | `shared/security/service_auth.py`, `tenant-service/routers/request_management_internal.py` | The portal ↔ tenant-service channel (§7.1) |
| **Public token pages for customers who have no login** | `routers/e_application.py`, `routers/medical_exam.py` (`/public/...`, hashed single-use expiring token); frontend `app/e-application/[token]`, `app/medical-exam/[token]` | Keep as-is; the portal *links* to them, never duplicates them |
| **Satellite Next.js apps sharing code by bind-mount** (`customer-service-app`, `underwriting-app`: mount `frontend/components`, `frontend/lib`, `frontend/app/services`, `globals.css`; same Tailwind theme) | `docker-compose.yml`, `customer-service-app/Dockerfile`, `tailwind.config.ts` | Same mechanism, **minus** staff shell/SSO/api client |
| **Locale in a cookie, `I18nProvider`, `t()`/`tx()`** with an English-as-key page-text dictionary loaded server-side only for Urdu | `frontend/lib/i18n/*` | Re-use the provider; own customer message bundles |
| **Kafka topics** incl. `insurance.policy.lifecycle.v1` carrying `policy_id, policy_number, customer_id, from/to status, actor, detail` for every committed `PolicyEvent` | `shared/events/kafka_events.py`, `routers/policies.py::_publish_policy_event` | Notification + cache-invalidation feed |

### 2.5 Naming collision (resolved in this blueprint)

`services/customer-service` + `customer-service-app` **already exist**. They are the **staff customer-support ticket desk** (agents/brokers/claims staff raise and work tickets; README: "*No customer self-service login … yet*"). `tenant-service` additionally owns the `customers` table and `/customers` routes. A new service called "customer-service" or "customer-management" would be ambiguous in conversation, in `docker-compose.yml`, in the gateway and in the database. **This blueprint therefore names the new pieces `customer-portal-service` / `customer-portal-app` / schema `customer_portal`.** (Decision **D-01**, §16.)

### 2.6 Other facts that constrain the design

* **Segments are derived, not stored.** An *individual* policy is one with `master_policy_id IS NULL AND family_policy_id IS NULL` (the policy list returns `segment = individual | family | organization`). A customer belongs to a family group via `Customer.family_group_id` and to an organization via `Customer.organization_id` (never both). `Customer.cnic` is unique **per tenant** only.
* **Policy statuses** now include the final states `Matured`, `Surrendered`, `Expired` (Stage B step 9), plus `Cancelled` (also used when a paid death claim ends a policy — recognisable by the `PolicyTerminatedByClaim` audit event).
* **Stage B endpoints all write `PolicyEvent` rows carrying a case number** (`renewal_no`, `case_no`, `claim_no`, `exit_no`) and publish them to Kafka — this is the audit trail and the notification source.
* **Payments are mocked** (`services/payment_gateway.py`): `initiate_payment`, `confirm_payment(realize=…)`, `refund_payment`; JazzCash / Easypaisa / Card / BankTransfer references. Outside demo mode a payment is meant to settle only against the reference issued at initiation (`require_payer_reference`).
* **Documents** are PDFs written under `POLICY_DOC_MEDIA_ROOT` (`/app/media/policy_documents/<policy_id>/…`) and customer-uploaded evidence goes through `routers/artifacts._upload_to_s3` (S3 or `/app/shared/storage` fallback).
* **Ports in use** (from `docker-compose.yml`): 3000 frontend, 3001 memgraph lab, 3002/3003 marketing, 3004 automation-chat, 3005/3006 underwriting-app, 3008 customer-service-app, 4991 docs, 8010 gateway, 8011 tenant, 8012 risk, 8013 decision, 8014 OCR, 8015 summarizer, 8016 chat-agent, 8017 request-management, 8018 customer-service, 8090 kafka-ui, 9092/9094 kafka. `request-management-app` is not in this compose file. **Proposed new ports: 3009 (app), 8019 host → 8009 container (service)** — to be re-checked at implementation.
* **PostgreSQL runs on the host**, not in compose; every service gets `host.docker.internal`. Role-provisioning secrets for the existing isolated services (`CS_DB_*`, `REQUEST_MGMT_*`, `REQUEST_MGMT_SERVICE_KEY`) are **unset** in this `.env`, so those services' provisioning will not run here until set — expect to set up `CP_*` secrets explicitly.
* **PDF generation** uses ReportLab with the default Latin fonts; Urdu glyph support in generated letters is **unverified** and probably missing (risk R-11).
* **`customer-portal` is not mentioned anywhere else in the repo** apart from `portal_service.py` and the `PORTAL_BASE_URL` constant.

### 2.7 Defects discovered while reading (fix or accept explicitly)

| ID | Defect | Impact on the portal | Where addressed |
|---|---|---|---|
| X-01 | 53+ unauthenticated routes incl. payment collection (F-31) | Cross-customer access, fraud | B-01 |
| X-02 | Policyholder-ID generator (F-10) | Username collisions across tenants; race inside a tenant | B-04, §6.4 |
| X-03 | `onboarding/reset` unguarded (F-09) | Could delete a live portal account | §6.7 |
| X-04 | No login throttling/lockout (F-22) | Credential stuffing | §5.5 |
| X-05 | `invite_token` etc. dead fields (F-07) | Misleading — someone may assume a flow exists | §6.3 |
| X-06 | Gateway CORS permissive + credentials (F-32) | CSRF/credentialed cross-origin if portal were behind it | §4.1 (not behind it) |
| X-07 | Staff JWT in `localStorage` (F-23) | XSS-stealable | Portal uses `httpOnly` cookies instead |
| X-08 | Customer hard-delete route exists (`DELETE /customers/{id}`) | Orphaned portal account | §6.8 |

---

## 3. Requirements traceability

| # | Mandatory requirement | How the design satisfies it | Section |
|---|---|---|---|
| 1 | Own DB schema, APIs, auth, authorization, customer account management | `customer-portal-service` with schema `customer_portal`, owner/app DB roles, its own `/v1` API, its own JWT issuer, account lifecycle | §4, §5, §8, §9 |
| 2 | Preserve post-issuance credential workflow; log in with generated credentials; change temp password on first login | Ops UI/endpoint contract unchanged; `portal_service.py` becomes a client of the new service; existing hashes are imported; first login yields a **scope-limited `pwd_change` token** that can do nothing but change the password | §6, §5.3 |
| 3 | One account, multiple individual policies; no new account / credential reset per policy | Unique `(tenant_id, customer_id)`; provisioning is idempotent and **never** resets an existing account unless an ops user explicitly asks (reason + audit); policy list resolved live | §6.5 |
| 4 | Reuse policies, claims, premiums, renewals, reinstatement, endorsements, maturity — no duplicated logic | Narrow signed internal adapter router in `tenant-service` that **delegates in-process** to the existing functions and returns customer-safe views; the portal service contains no premium/claim/benefit maths | §7 |
| 5 | Enterprise UI practices: sidebar, topbar, blue/slate, reusable cards/forms/notifications, responsive, English/Urdu | `customer-portal-app` re-uses the Tailwind theme, `globals.css`, `NotificationContext`, panel primitives and the `I18nProvider`; builds a **customer** shell (not the staff `Sidebar`/`TopBar`) | §10 |
| 6 | Complete individual lifecycle incl. normal, exception, failure, authorization, fraud, recovery | Lifecycle map (§11), risk-classed actions (§12), ≈250-row matrix (§13) | §11–13 |
| 7 | Preserve all existing staff, agent, underwriting, family, corporate functionality | Additive only: new service, new internal router, new events; ops endpoints keep their contracts; legacy table untouched until the last migration phase; feature flag with rollback | §6.6, §14 |
| 8 | Strict customer/staff separation; no cross-customer or cross-tenant access | Distinct secrets/issuer/audience/cookies/tables; tenant and customer **never taken from the request**; every internal call re-checks ownership; plus prerequisite B-01 | §5.6, §5.7, §12 |

---

## 4. Target architecture

### 4.1 System context

```
                    PUBLIC INTERNET                               PRIVATE NETWORK (insurance-net)
 ┌──────────────┐   HTTPS    ┌──────────────────────┐  internal  ┌─────────────────────────┐
 │ Customer     │──────────▶ │  customer-portal-app │ ─────────▶ │  customer-portal-service │
 │ browser      │ ◀──cookies │  (Next.js :3009)      │  Bearer    │  (FastAPI :8009)        │
 │ (en / ur)    │  httpOnly  │  UI + BFF route       │            │  schema: customer_portal│
 └──────────────┘            │  handlers             │            └───────┬───────┬─────────┘
                             └──────────────────────┘                    │       │
                                                       HMAC-signed       │       │ outbox / consumer
                  NO route from the staff gateway ──✗                    ▼       ▼
                                                       ┌─────────────────────┐  ┌─────────┐
 ┌───────────────┐   staff JWT   ┌──────────────┐      │  tenant-service      │  │  Kafka  │
 │ Staff users   │ ────────────▶ │  api-gateway │ ───▶ │  (policies, claims,  │◀▶│ policy  │
 │ (agents, UW…) │               │  :8010       │      │  premiums, renewals… │  │lifecycle│
 └───────────────┘               └──────────────┘      │  + NEW internal      │  └─────────┘
                                                       │  /internal/customer- │
                                                       │  portal/*  router)   │
                                                       └─────────────────────┘
                                                              PostgreSQL (host)
                                                  public.*  (tenant-service)   customer_portal.* (portal)
```

**Trust zones**

| Zone | Contents | Trust |
|---|---|---|
| Z0 Internet | customer browsers | Untrusted |
| Z1 Edge | `customer-portal-app` (BFF) | Semi-trusted: holds the session cookie, never business rules |
| Z2 Portal core | `customer-portal-service`, schema `customer_portal` | Trusted for identity; **not** trusted for insurance data (it caches nothing authoritative) |
| Z3 Domain core | `tenant-service` incl. the new internal router | Trusted; the **only** writer of policy/claim/premium data |
| Z4 Staff | gateway, staff apps | Separate identity system; customers have no path into it |

**Why the customer path does not use the existing API gateway.** The gateway (a) CORS-allows any origin with credentials, (b) forwards `Authorization` blindly, (c) fronts routes that are unauthenticated today, and (d) is the staff trust boundary. Putting customer traffic through it would couple two identity systems and inherit all four problems. A mobile client later can be served by a *portal-owned* edge with its own CORS policy (§14.8).

### 4.2 Component responsibilities

| Component | Responsible for | Explicitly **not** responsible for |
|---|---|---|
| `customer-portal-app` | Pages, forms, i18n/RTL, BFF auth endpoints (login/refresh/logout), CSRF, mapping cookie ⇄ bearer, response streaming of documents | Calling `tenant-service` or the gateway; any business rule; storing tokens in JS-readable storage |
| `customer-portal-service` | Accounts, credentials, password policy, sessions/refresh rotation, lockout/throttling, OTP/step-up, contact verification, notification inbox + preferences, payment sessions & reconciliation, customer-facing service-request records, customer-safe orchestration, portal audit, outbox | Premium maths, benefit calculation, eligibility, claim/renewal/reinstatement/exit rules, policy documents generation, commission, underwriting |
| `tenant-service` (+ new `customer_portal_internal.py`) | All insurance logic and data; ownership enforcement for portal calls; customer-safe response shaping; mapping a portal action onto the existing domain function | Storing customer passwords/hashes (after migration); deciding portal sessions |
| Kafka | Fan-out of lifecycle events to the portal; portal events back to `tenant-service` | — |

### 4.3 Service boundaries and data ownership

| Data | System of record | Portal's relationship |
|---|---|---|
| Customers, CNIC, DOB, contact, policies, riders, nominees, premium ledger, receipts, claims, renewals, reinstatement, exits, documents (PDF/evidence) | `tenant-service` (`public` schema) | **Read via signed internal API; never stored**, except short-TTL read-through cache and opaque IDs |
| Customer **login identity**: username, credential hash, state, lockout, sessions, devices, MFA/OTP state, verified contacts | `customer-portal-service` (`customer_portal`) | Owns |
| Notification inbox / preferences / read state | `customer-portal-service` | Owns (content derived from events) |
| Payment sessions (intent, gateway ref, status, retries) | `customer-portal-service` | Owns the *session*; the **posted receipt** is owned by `tenant-service` |
| Customer-facing service-request record + status mirror | `customer-portal-service` | Owns the *record of the customer's intent*; the **domain object** (claim, case, endorsement) is owned by `tenant-service` |
| Portal audit trail | `customer-portal-service` (append-only) | Owns; significant actions are **also** written as `PolicyEvent`s in `tenant-service` with actor `customer:<account_id>` so staff see them in the existing timelines |
| Staff users, roles | `tenant-service` | The portal has **no** access and no copy |

**Rules of the boundary:** no cross-schema SQL, no foreign keys across schemas, no shared tables, no shared ORM models (the portal does **not** import `shared/models/core.py`), IDs only.

### 4.4 Two directions of internal calls (two keys)

| Direction | Mechanism | Key | Caller header | Purpose |
|---|---|---|---|---|
| portal-service → tenant-service | HMAC (`shared/security/service_auth.py`) on `/internal/customer-portal/v1/*` | `CP_TO_TENANT_KEY` | `customer-portal` | Read customer-safe views; execute allow-listed customer commands |
| tenant-service → portal-service | HMAC on `/internal/v1/*` | `TENANT_TO_CP_KEY` | `tenant-service` | Provision / reset / suspend accounts; import legacy accounts; read account summary for the onboarding checklist |

Both directions: replay window 300 s (existing), `X-Idempotency-Key` on every state-changing call, and **neither internal router is routed by the gateway** (same property `request_management_internal.py` already documents). The existing `sign()` signs with a caller string but `verify()` does not check it — the router must check `CALLER_HEADER` itself (as the Request Management router does).

### 4.5 Failure-domain view

| If this is down… | Customer impact | Staff impact | Degradation rule |
|---|---|---|---|
| `customer-portal-app` | Portal unavailable | None | — |
| `customer-portal-service` | No login/sessions | **Ops provisioning of new credentials fails with a clear 502** (not silent) | Ops can still do everything except issue/reset portal credentials |
| `tenant-service` | Logged-in customers can still sign in and see cached **non-financial** shell + banner; any data/transaction call returns `503 DOMAIN_UNAVAILABLE` | Staff platform down anyway | **Never** show stale money values as current: cached policy lists are labelled "as of hh:mm" and financial actions are disabled |
| Kafka | Notifications delayed; caches refresh on TTL | None | Outbox retries; inbox is also refreshable by polling the domain |
| Payment gateway | Payment disabled with message; retry later | None | Intent stays `PENDING`/`EXPIRED`, never double-posts |
| Email/SMS provider | OTP/notifications delayed | None | OTP resend with backoff; in-app inbox unaffected |

---

## 5. Identity, authentication and authorization

### 5.1 Principals

| Principal | Authenticates with | Token audience | Can reach |
|---|---|---|---|
| **Customer account** | username + password (+ OTP for step-up) at the portal | `customer-portal` | Portal public API (`/v1`) |
| Staff user | email + password at `tenant-service` | none (legacy) | Staff API |
| Portal service | HMAC key `CP_TO_TENANT_KEY` | n/a | `/internal/customer-portal/v1/*` |
| Tenant service | HMAC key `TENANT_TO_CP_KEY` | n/a | portal `/internal/v1/*` |

There is **no impersonation ("view as customer") capability** in Stage 1. Support staff see what the customer sees through the existing staff screens; they never obtain a customer token. (Decision **D-09**.)

### 5.2 Account model and segment extensibility

One portal account represents **one customer record** (`tenant_id`, `customer_id`):

```
Account (login identity)
  └─ Subject link  ── customer_id ──▶ tenant-service customer
        └─ Workspaces (computed at login, never stored as authority)
              Individual  ← policies where segment = individual      ← THIS STAGE
              Family      ← policies in the customer's family group   ← later stage
              Corporate   ← employee certificate / corporate admin    ← later stage
```

* A single login can eventually expose several **workspaces**; Stage 1 implements *Individual* only and returns the others as `available:false`. This answers "login according to their type" without a second account system: the **type is a property of the policies/relationship, discovered live**, not of the credential.
* `accounts.account_kind` (`CUSTOMER` now; `FAMILY_MEMBER`, `CORPORATE_ADMIN`, `CORPORATE_EMPLOYEE` reserved) and `account_subject_links` (§8) are the only schema accommodations; no Family/Corporate logic is built now.
* Customer who is also a family-group member or an employee: `Customer.family_group_id` / `organization_id` is visible to the adapter; Stage 1 simply **filters the policy list to `segment = individual`** and shows an informational "You also have family/corporate cover — coming soon" card when other segments exist.

### 5.3 Login and first-login password change

```
POST /v1/auth/login {tenant_code, username, password}
   │
   ├─ tenant resolved by tenant_code (active tenant only); generic failure otherwise
   ├─ throttle checks (per account, per IP, per tenant) ── blocked → 429 generic
   ├─ account lookup (tenant_id, lower(username)); constant-time verify even if absent
   ├─ state checks (§5.4) ── Suspended/Closed/Locked → generic 401 + security event
   ├─ credential expiry check (temporary password older than CP_TEMP_PASSWORD_DAYS)
   │        → 401 code CREDENTIAL_EXPIRED  ("ask your insurer to issue new credentials")
   ├─ success:
   │     must_change_password = true  → issue a **pwd_change-scoped** access token (5 min), no refresh token
   │     else                         → issue full access (15 min) + refresh (rotating)
   └─ record login (ip, user-agent hash, device id) + security event; counters reset
```

**The first-login contract** (requirement 2):

1. The customer enters the **username** (policyholder ID, e.g. `PH-2026-000123`) and the **temporary password** shown to ops (existing format: 10 alphanumerics).
2. The service responds `{"state":"PASSWORD_CHANGE_REQUIRED"}` with a token whose `scp` claim is `["pwd_change"]` — accepted by **one** endpoint, `POST /v1/auth/password/first-change`; every other endpoint returns `403 PASSWORD_CHANGE_REQUIRED`.
3. The customer supplies `current_password` (the temporary one) and `new_password` (+ confirmation in the UI). On success the old temporary credential is destroyed, `must_change_password=false`, `activated_at` is set, all prior sessions are revoked, and a **full** session starts.
4. The first successful change emits `customer-portal.account.activated.v1` → `tenant-service` records the onboarding **acknowledgment** with method `Portal` (the existing field accepts it) and a `PortalActivated` `PolicyEvent` on **every in-force individual policy of that customer**.
5. After that the **same** credentials work for every policy the customer has now or later (§6.5).

### 5.4 Account state machine

```
                issue (ops "Provision portal access")
   (none) ─────────────────────────────────────────▶ PROVISIONED ──temp password expires──▶ CREDENTIAL_EXPIRED
                                                        │                                         │
                                       first login + password change                      ops re-issues (reason)
                                                        ▼                                         │
                                                      ACTIVE ◀────────────────────────────────────┘
                             too many failures ↕ auto-expires      staff fraud hold ↕ staff releases
                                                    LOCKED                   SUSPENDED
                                                        │
                       customer closed / retention elapsed ▼
                                                      CLOSED   (terminal; login impossible; audit kept)
```

| State | Can log in | Entered by | Left by |
|---|---|---|---|
| `PROVISIONED` | Yes, **only** to change the password | Provision / ops reset | First change, or expiry |
| `CREDENTIAL_EXPIRED` | No | Temp password past validity | Ops re-issue (explicit, audited) |
| `ACTIVE` | Yes | First password change | Lock, suspend, close |
| `LOCKED` | No | Automatic after repeated failures (§5.5) | Timer, successful self-service reset, ops unlock |
| `SUSPENDED` | No | **Staff only** (fraud / compliance hold) with reason | Staff release |
| `CLOSED` | No | Account closure / customer erasure workflow | — |

### 5.5 Throttling and lockout (the platform has none today — F-22)

| Control | Rule (configurable, defaults proposed) |
|---|---|
| Per-account failures | 5 failures / 15 min → `LOCKED` for 15 min, doubling on repeat (cap 24 h); resets on success |
| Per-IP | 20 login attempts / 10 min → 429 |
| Per-tenant | circuit breaker on abnormal login-failure ratio → raise alert, require CAPTCHA hook |
| Password-reset requests | 3 / hour / account, 10 / hour / IP; always `202` with identical body & timing |
| OTP send | 5 / hour / account, 60 s resend cooldown; 5 verify attempts per challenge, then challenge is dead |
| Responses | **Identical** for "unknown user", "wrong password", "locked", "suspended": `401 INVALID_CREDENTIALS` (lock state is revealed only to someone who has just proven the password, as a countdown) |
| Timing | Always run a bcrypt verify against a dummy hash when the user is unknown |
| Storage | Counters in PostgreSQL (`login_attempts`), not process memory (multi-replica safe); optional Redis later |

### 5.6 Customer vs staff token separation (checklist)

| Aspect | Staff | Customer portal |
|---|---|---|
| Issuer service | `tenant-service` | `customer-portal-service` |
| Signing secret | `JWT_SECRET_KEY` (shared across staff services) | **`CP_JWT_SECRET`** — different value, ≥ 32 bytes, rotatable with `kid`; never given to any other service |
| `iss` / `aud` / `typ` | none | `insurance-ai/customer-portal` / `customer-portal` / `at+jwt` |
| Claims | `sub`=user id, `tenant_id`, `role_id` | `sub`=account id, `tid`, `cid`, `sid` (session), `scp`, `jti`, `kid` |
| Lifetime | 24 h | access **15 min** + rotating refresh (idle 30 min, absolute 12 h) |
| Storage | `localStorage` + SSO cookie | **`httpOnly; Secure; SameSite=Lax`** cookies, host-only (`__Host-` prefix in production), **different names** (`cp_at`, `cp_rt`, `cp_csrf`) and **no `SSO_COOKIE_DOMAIN`** |
| User table | `public.users` | `customer_portal.accounts` |
| Verification code | `routers/auth.py::decode_access_token` | `app/security/tokens.py` (new) — requires `aud`, `typ`, `kid`, session liveness |
| Cross-acceptance | a customer token fails staff verification (different secret/no `role_id`); a staff token fails portal verification (wrong secret/aud) — **both directions tested** (SEP-xx) | |
| Roles | Roles table | **None** — authorization is ownership + risk class (§5.7); no customer can hold a staff role |

### 5.7 Authorization model (ownership first)

Every protected call passes four gates, in order:

1. **Session gate** — valid, unexpired, unrevoked session; scope check (`pwd_change` vs full); account state `ACTIVE`.
2. **Tenant & subject binding** — `tid` and `cid` come **only** from the token; any `tenant_id` / `customer_id` in a path, query or body from the client is **rejected** (the public API does not even have such parameters).
3. **Ownership gate** — for any `policy_id` / `claim_id` / `case_id`, the portal resolves ownership by asking the internal router `GET …/customers/{cid}/policies/{id}` (or the case's parent policy). **Unowned or other-tenant objects return `404 NOT_FOUND`** (never 403 — no existence oracle). The internal router **re-checks** ownership independently (defence in depth): its path carries `tenant_id` + `customer_id` and the policy must belong to that customer and be `individual`.
4. **Risk gate** — the action's class (§12.3) decides whether a recent step-up, a cooling-off period or staff verification is required.

Object identifiers exposed to the browser are the real UUIDs (no value in obfuscation without gate 3), but **claims, case and document keys are always addressed through their owning policy** (`/v1/policies/{id}/…`) so an ID alone never grants anything.

### 5.8 Password and credential policy

| Rule | Value |
|---|---|
| Minimum length | 10; maximum 128; all printable Unicode accepted |
| Complexity | No composition rules; instead reject: top-breached/common list (bundled), the username, the customer's CNIC/DOB/phone/name fragments, sequences/repeats |
| History | Cannot reuse the last 5 |
| Hashing | **bcrypt** (compatible with every hash `passlib` already produced, so migrated temp passwords verify); transparent **re-hash to argon2id** on next login once adopted (`needs_update`) |
| Temporary password | Existing 10-char generator is **kept for ops compatibility** (customers receive it from ops/SMS); valid `CP_TEMP_PASSWORD_DAYS` (default **7**, matching `PORTAL_INVITE_VALID_DAYS`), single use in effect (login only yields `pwd_change` scope) |
| Change | Requires current password; revokes all other sessions; notifies by email/SMS |
| Reset | (a) ops re-issue via existing endpoint (with reason) or (b) self-service with OTP to a **verified** channel (§5.9). Both set `must_change_password=true` |

### 5.9 Contact verification and step-up (OTP)

* `contact_points` (§8): `EMAIL` / `PHONE`, `verified_at`, `source` (`TENANT_IMPORT` unverified | `PORTAL_VERIFIED`). Contacts imported from `Customer.details` are **unverified**; the customer verifies them in the portal (OTP) — until then self-service reset and step-up are **unavailable** and the UI explains why.
* **Step-up** = a fresh OTP, bound to the session and to an **action class**, valid 10 minutes, single action-class. Matrix in §12.3.
* Channels: email via the existing SES path (**available**); SMS through an adapter interface with a **simulated driver in dev** (blocker **B-02** for production).

---

## 6. Credential migration and the post-issuance integration

### 6.1 Current → target

| | Today | Target |
|---|---|---|
| Who mints the temp password | `tenant-service/portal_service.py` | **`customer-portal-service`** (credential authority) |
| Where the hash lives | `public.customer_portal_accounts.password_hash` | `customer_portal.accounts.password_hash` only |
| What ops see | username + one-time temp password + placeholder URL in the onboarding UI | **Identical** (same JSON: `username, temp_password, portal_url, invite_expires_at, reset`) — the real portal URL is now filled in |
| Status / must_reset / last_login read by the onboarding checklist | local row | read from portal-service (`GET /internal/v1/accounts/by-customer/{id}`), cached 30 s; local row kept as a **non-secret mirror** |
| Customer login | does not exist | `customer-portal-app` |

The router/DB shape for ops does not change — this is the seam the original author left (F-02).

### 6.2 Target provisioning flow (ops action unchanged)

```
Ops UI  POST /tenants/{t}/policies/{p}/onboarding/portal            (unchanged route + auth model)
   │
   ▼ tenant-service.provision_portal()
   1. load policy → customer; assert policy in force (existing _assert_onboardable)
   2. assert contact present (email or phone) — NEW soft rule, warning only in Stage 1
   3. call portal-service  PUT /internal/v1/accounts            (HMAC, X-Idempotency-Key)
         body {tenant_id, customer_id, username_hint (policyholder_id|email|fallback),
               policy_id, requested_by, mode: "ensure" | "reset", reason?}
   │
   ▼ portal-service
        ensure + account exists  →  200 {created:false, reset:false, username, status}   ← NO credential change
        ensure + no account      →  create PROVISIONED, mint temp pw, return it ONCE
        reset  (explicit)        →  new temp pw, state PROVISIONED, sessions revoked,
                                    requires reason + audit + notification to the customer
   │
   ▼ tenant-service
   4. write/refresh local mirror row (username, status, must_reset) — hash NOT stored
   5. PolicyEvent PortalProvisioned | PortalCredentialsReset (reason)
   6. return the SAME payload ops get today (temp_password only when one was minted)
```

* **Second policy for the same customer** → `mode:"ensure"` returns the existing account untouched; the UI shows *"Portal access already active — no credentials issued"* (and hides the temp-password panel). The "Reset password" button stays but now needs a **reason** and a confirm dialog, and is audited.
* **Failure semantics:** if portal-service is unreachable, `provision_portal` returns **`502 PORTAL_UNAVAILABLE`** and commits nothing; ops retry. The temp password is only ever returned after the portal-service commit, so ops never hand out credentials that don't work.
* **Idempotency:** `X-Idempotency-Key = sha256(tenant_id, customer_id, mode, ops_request_id)`; a retried HTTP request returns the *same* response **including** the same one-time password only within 60 s (held encrypted in the idempotency row, then purged) — otherwise `409 ALREADY_ISSUED` (ops must use *reset* deliberately).

### 6.3 Dead fields and the invite link

`invite_token`/`invite_expires_at` were designed for a "set your password" link (F-07) but nothing uses them. Decision **D-03**: keep the **temporary-password + forced change** model the requirement asks for; **drop** `invite_token`; map `invite_expires_at` → `credential_expires_at`. An *activation link* (single-use, hashed token) can be added later as a **second** delivery option without changing the account model.

### 6.4 Username and tenant uniqueness (B-04)

* Login identifier = `username` as issued (policyholder ID or email fallback), **unique per tenant** `UNIQUE (tenant_id, lower(username))`. The customer enters a **tenant code** (hidden when the portal is reached on a tenant-branded host) so two insurers can both have `PH-2026-000001`.
* **Required fix in `tenant-service` (prerequisite P-04):** replace `count+1` in `_next_policyholder_id` with a per-tenant, per-year **allocator** (a row-locked counter table or PostgreSQL sequence per tenant) and add `UNIQUE (tenant_id, policyholder_id)`. Existing duplicates (if any) must be found first — a pre-migration report (§6.6, step M0) lists them.
* The portal never lets a customer *choose* or change the username in Stage 1.

### 6.5 One account, many policies

| Event | Behaviour |
|---|---|
| New policy issued for an existing customer | Nothing happens to credentials. The policy appears in the portal list on next load (or immediately via the lifecycle event). Onboarding step "portal" is already satisfied. |
| Customer has 3 policies; ops resets once | One reset affects the **one** account — all three policies share it. The reset UI states this. |
| Policy closes/matures/surrenders | Account stays `ACTIVE`; history stays visible; a banner explains the policy is closed. |
| Customer's **last** policy closes | Account stays; after `CP_DORMANT_MONTHS` (default 24) with no login → `DORMANT` flag (login still works); closure is a deliberate workflow (§6.8). |
| Customer record is merged/duplicated in `tenant-service` (two `customer_id`s for one person) | Out of scope — two accounts; flagged as a data-quality item. |

### 6.6 Migration plan for existing accounts (phased, reversible)

| Phase | What happens | Reversible? | Exit check |
|---|---|---|---|
| **M0 – Prepare** (no behaviour change) | Provision schema + roles; deploy portal-service dark. Run a **read-only report** in `tenant-service`: duplicate `(tenant_id, username)` in `customer_portal_accounts`; duplicate `(tenant_id, policyholder_id)` in `customers`; accounts whose customer has **no** individual policy; accounts with `status` ≠ Pending/Active/Suspended; expired `invite_expires_at`. Fix findings. | n/a | Report clean or each item dispositioned |
| **M1 – Import** | `tenant-service` pushes rows to `POST /internal/v1/accounts/import` in batches (idempotent on `(tenant_id, customer_id)`): copies `username`, **`password_hash` (bcrypt as-is)**, `must_reset→must_change_password`, `status` (`Pending→PROVISIONED`, `Active→ACTIVE`, `Suspended→SUSPENDED`), `last_login_at`, `created_at`, `credential_expires_at ← invite_expires_at`, `legacy_account_id`. Portal-service verifies each hash is a valid bcrypt string and never logs it. Legacy table is **untouched**. | Yes — delete imported rows | Row counts + checksum of `(customer_id, username, status)` match |
| **M2 – Dual-write** (`PORTAL_PROVISIONING_MODE=dual`) | `provision_portal` writes to **both**: portal-service first, legacy mirror second. Reads for onboarding still use the legacy row. Login is enabled for a pilot tenant/customers only. | Yes — flip flag to `legacy` | Pilot customers log in, change password, ops provision/reset works end to end |
| **M3 – Portal authoritative** (`mode=portal`) | `provision_portal` talks to portal-service only; the onboarding checklist reads portal-service (cached) ; the legacy row becomes a **non-secret mirror** (`password_hash` set to a fixed sentinel `!migrated`, `invite_token` NULL). The unguarded `onboarding/reset` is disabled (§6.7). | Partly — hashes now only in portal; rollback = re-export hashes back (supported by a signed export endpoint kept for one release) | One full release cycle without incident; reconciliation job shows zero drift |
| **M4 – Cleanup** (separate release) | Drop `customer_portal_accounts.password_hash` & `invite_token` columns (Alembic-style migration in `migrate.py`), remove dead code. | No | Sign-off |

**Compatibility guarantees during M1–M3:** a temporary password issued before the migration still works (same bcrypt hash, same expiry); an ops "reset" before and after the migration produces the same ops-visible payload; nobody is logged out of staff systems; staff tokens are unaffected.

**Reconciliation job** (daily from M2): compare `(customer_id, username, status, must_reset)` between legacy mirror and portal-service; alert on drift; auto-heal the mirror from the portal (never the other way).

### 6.7 Guarding the dev reset utility

`POST …/onboarding/reset` (F-09) must be wrapped: allowed only when `env_mode.is_demo()` **and** no portal account has ever logged in (`last_login_at IS NULL`); otherwise `409`. In `mode=portal` it calls the portal-service `DELETE /internal/v1/accounts/{id}` guarded by the same rule. (Prerequisite P-07.)

### 6.8 Customer lifecycle edge cases

| Case | Rule |
|---|---|
| Customer hard-deleted in `tenant-service` (X-08) | `tenant-service` emits `customer.deleted`; portal marks the account `CLOSED`, revokes sessions, keeps audit. The delete route should be blocked while the customer has policies (separate fix). |
| CNIC/contact corrected via Request Management | Event `customer.profile.changed` → portal refreshes contact points; **changed phone/email becomes unverified** and triggers the high-risk "recent contact change" window (§12.4). |
| Customer asks for closure | Staff-initiated workflow in a later stage; Stage 1 provides "Request account closure" as a support request only. |
| Duplicate usernames discovered after go-live | Login would be ambiguous only if tenant code is omitted; with `(tenant, username)` uniqueness it cannot be ambiguous within a tenant. |

---

## 7. Integration with existing services (no duplicated business logic)

### 7.1 The one place the portal touches the domain: a narrow internal adapter router

**Decision (D-04):** add `services/tenant-service/routers/customer_portal_internal.py`, prefix `/internal/customer-portal/v1`, modelled on `request_management_internal.py`.

```
/internal/customer-portal/v1/tenants/{tenant_id}/customers/{customer_id}/…
```

| Property | Rule |
|---|---|
| Authentication | `signed_by_customer_portal` dependency: HMAC with `CP_TO_TENANT_KEY`, `X-Service-Caller: customer-portal` **checked explicitly**; body/query covered by the signature |
| Reachability | Not routed by the gateway; the network policy allows only `customer-portal-service` |
| Ownership | A shared helper `owned_individual_policy(tenant_id, customer_id, policy_id)` loads the policy and 404s unless `policy.tenant_id == tenant_id AND policy.customer_id == customer_id AND master_policy_id IS NULL AND family_policy_id IS NULL`. **Every** adapter calls it first; objects below a policy (claim, case, schedule, receipt, document) are resolved **through** the policy and must have `policy_id` equal to it |
| Delegation | Adapters call the **existing functions in-process** (the same technique the Stage B routers already use between themselves, e.g. `renewals.py` → `post_issuance.collect_installment`). No SQL or rules are re-implemented in the adapter or in the portal service |
| Projection | Each adapter returns a **customer view** built by a pure function in `services/customer_portal_views.py` using an **allow-list** of fields; staff-only fields can only appear if someone adds them to the list. Golden-file tests fail if a new field leaks (§13.19) |
| Actor | Functions that record an `actor` get `customer:<account_id>`; this shows up in `PolicyEvent` timelines staff already use |
| Idempotency | State-changing adapters require `X-Idempotency-Key`; replays return the first result |
| Correlation | `X-Correlation-Id` propagated end to end and written to events |

**Never exposed through the adapter** (staff-only, enforced by the allow-lists *and* by simply not having an adapter): commission and earnings; fraud/duplicate scores; investigation findings, internal notes, assessment internals; underwriting rationale and risk scores; staff names/ids; demo-bypass flags; case numbers; branch/agent assignment; `realize`/`manual`/`waive`/`remind` controls; every decision, authorise, disburse, reconcile, close, restore, override and waive action.

### 7.2 Capability → reuse map

`Mode`: **D** = direct command (customer acts, domain applies), **R** = request (customer asks, staff approve through the existing staff screens), **V** = view only, **S** = staff-only (never offered). Risk classes are defined in §12.3.

| # | Customer capability | Existing owner (route → function) | Mode | Risk | Adapter behaviour / restriction |
|---|---|---|---|---|---|
| C-01 | List my individual policies | `GET /tenants/{t}/policies?customer_id=` → `policies.list_policies` | V | R0 | Filter `segment=individual`; project to product, number, status, sum assured, term, dates, premium amount + mode, next due |
| C-02 | Policy detail (cover, riders, nominees, versions) | `GET …/policies/{id}`, `…/endorsements` (overview) | V | R0 | Hide case numbers, branch, agent, loadings detail beyond "extra premium"; nominees show name, relationship, share |
| C-03 | Activity timeline | `GET …/policies/{id}/events` | V | R0 | **Allow-list of event types** with customer wording (issued, payment received, endorsed, claim stage, …); suppress internal ones (reminders sent, commission, lapse-warning letter issued by staff, etc.) |
| C-04 | Premium ledger & next due | `GET …/premiums` → `billing_gate.compute_billing` | V | R0 | Show instalments, status, payable (incl. late surcharge), grace window; **hide** `dashboard`, `commission_*`, reminder counters |
| C-05 | Pay a premium | `POST …/premiums/{sid}/collect` → `post_issuance.collect_installment` | D | R2 | **Only** after a portal payment session is gateway-confirmed (§7.4). Adapter `POST …/premiums/{sid}/payments` re-reads the payable amount, requires `amount == payable` and a gateway reference, calls the existing collect path, and is **idempotent on the reference**. The `realize`/`manual` flags are **not accepted** from the portal |
| C-06 | Receipts | `GET …/premiums/receipts` (+ `/{id}/download`) | V | R0 | Hide commission columns |
| C-07 | Autopay on/off | `POST …/premiums/autopay` | D | **R3** | Step-up; confirmation email/SMS; staff signal event |
| C-08 | Free-look cancellation | `GET/POST …/free-look[/cancel]` → `cancel_within_free_look` | D | **R3** | Step-up; refund goes **only to the original payer instrument** (never a new bank detail); event to staff |
| C-09 | Welcome kit / policy documents | `…/onboarding/welcome-kit/download`, `pre_issuance.download_document` | V | R1 | Streamed through portal-service after ownership check |
| C-10 | Renewal view (next due, premium, type, notice, status tracker) | `renewals._overview` | V | R0 | Customer wording for stage labels; hide risk internals and loading rationale |
| C-11 | Pay a renewal premium | `renewals.collect_renewal_premium` → `collect_installment` | D | R2 | Same payment-session path as C-05; if no case is open and the renewal window is open, the adapter opens the cycle with the system actor (D-07) |
| C-12 | Accept renewed terms (contract renewal) | `renewals.capture_acceptance` | D | **R3** | Step-up; `method="Portal"`; shows the exact terms/premium accepted; staff-underwriter decisions remain staff-only |
| C-13 | Reinstatement: request, declaration, evidence, accept revised terms, pay arrears, withdraw | `reinstatement.open_reinstatement`, `submit_declaration`, `receive_evidence`, `respond_to_terms`, `collect_reinstatement_payment`, `withdraw_reinstatement` | D | R2 (declaration/terms **R3**) | Channel `Portal`; declaration is an **e-signature** (step-up + typed name + timestamp + IP); **decision / restore / assessment internals are S** |
| C-14 | Update contact (email/phone) | `endorsements.endorse_contact` | D | **R3** | Step-up on both old and new channel; new contact unverified until OTP; 72 h "recent change" window (§12.4) |
| C-15 | Update address | `endorsements.endorse_address` | D/R | R3 | Direct for individual with step-up (D-08); document upload optional |
| C-16 | Change nominees | `endorsements.endorse_nominees` | **R** | **R3** | Customer submits a request with the new roster; staff verify identity/relationships and apply with the existing screen (shares must total 100 %) |
| C-17 | Change sum assured / add or remove rider | `endorsements.endorse_sum_assured`, `endorse_riders`, `endorsement_quote` | **R** | **R3** | Customer sees the **quote preview** (existing re-quote); the change itself needs underwriting/ops approval |
| C-18 | Endorsement letters | `…/endorsements/{id}/document/download` | V | R1 | |
| C-19 | Claim intimation | `claim_workflow.register_claim` → **extracted** `intimate_claim()` (P-08) | D | R2 | Channel `Portal`; system actor; duplicate/fraud handling stays in the existing flow; customer is shown a reference + checklist, never scores |
| C-20 | Claim documents | `claim_workflow.receive_document` | D | R2 | Same upload pipeline; AV scan (§12.6); manager-only waive/return are **S** |
| C-21 | Claim status, checklist, SLA, outcome letter | `claim_workflow._workspace` | V | R0 | Hide investigation, flags, assessment internals; show outcome, amount, reason (as in the letter) |
| C-22 | Claim payout details | `claim_workflow.verify_payees` (staff) | **R** | **R3** | Customer **submits** bank details (stored as pending on the claim); **staff verify** (CNIC, IBAN, account title). New details are subject to the cooling-off rule (§12.4) |
| C-23 | Maturity / expiry information | `policy_exit._overview` | V | R0 | Indicative values labelled "indicative — final figure after verification" |
| C-24 | Request surrender | `policy_exit.open_exit(exit_type=Surrender)` | **R**→D | **R3** | Customer opens the request with reason; **staff** run eligibility, documents, calculation |
| C-25 | Exit consent (declarations) | `policy_exit.record_consent` | D | **R3** | E-consent with step-up, `method="Portal"` |
| C-26 | Accept / decline settlement figure | `policy_exit.accept_settlement` | D | **R3** | Shows the statement (PDF) first; figure expiry enforced by the domain |
| C-27 | Exit payee details | `policy_exit.verify_payee` (staff) | **R** | **R3** | As C-22: customer submits, staff verify; payee must be the policyholder |
| C-28 | Withdraw an exit before payment | `policy_exit.cancel_exit` | D | R2 | Only before disbursement (domain rule) |
| C-29 | Exit confirmation letters | `policy_exit.download_letter`, `claim_workflow.download_claim_letter` | V | R1 | |
| C-30 | Notifications & preferences | portal-owned | D | R1 | §7.6 |
| C-31 | Contact support | existing `customer-service` ticket desk is **staff-only today** | — | — | Stage 1: static contact card + "request a call back" stored in portal; ticket integration is a later decision (D-11) |

**Staff-only (S), for completeness:** underwriting and claim decisions; claim assessment/investigation; settlement calculate/authorise/disburse/reconcile/close; reinstatement decision/restore; renewal risk decision; document waive/return; commission; waive/remind/collect-with-flags; sweeps; loans recording.

### 7.3 Where existing code needs a small, behaviour-preserving extraction

These are **refactors to expose existing logic to a second caller**, not new rules. Each is covered by the existing e2e scripts before/after.

| ID | Change | Why | Risk |
|---|---|---|---|
| P-08 | Extract `intimate_claim(session, tenant, policy, body, actor)` from `claim_workflow.register_claim`; make `open_claim`'s `current_user` an optional `Actor` (the model columns `assigned_adjuster_id` and `ClaimStatusHistory.actor_id` are nullable) | The portal has no `User` | Low |
| P-09 | Extract the non-guarded bodies of `receive_document` (claim/exit/reinstatement evidence) so the portal can call them with an actor string | Same | Low |
| P-10 | `post_issuance.collect_installment` — add an internal helper `post_realized_payment(session, policy, schedule, reference, method, amount)` used by the portal adapter that **refuses `realize=False`/manual** and verifies `amount == payable`; the public route keeps its current behaviour | The browser must never control `realize` | Medium (payment path — needs the existing premium e2e re-run) |
| P-11 | `policy_exit.open_exit` and `renewals.open_renewal`/`reinstatement.open_reinstatement` accept an actor string independent of `require_roles` (they already take `user` for `_actor(user)` only) | Portal-initiated cases | Low |
| P-12 | Customer-safe view module `services/customer_portal_views.py` + allow-list tests | Projection | Low (new file) |

### 7.4 Payment sessions (portal-owned) — the only money flow the customer starts

The portal **never** sends an amount from the browser. It asks the domain what is payable *now*.

```
Customer clicks "Pay PKR 49,254"
   │  POST /v1/payments {policy_id, schedule_id, purpose, method, return_url}  (Idempotency-Key)
   ▼ portal-service
   1. ownership + risk gate (R2)               2. ask domain: GET …/premiums/{sid}/payable  → amount, due, surcharge, valid_until
   3. create payment_intent  CREATED  (amount = domain amount, expires 30 min)
   4. gateway.initiate(amount, ref)  → INITIATED  → return {intent_id, redirect_url|payment_form}
   ▼ customer pays at gateway ───────────────────────────────────────────────────────────────┐
   ▼ gateway webhook / return  POST /v1/webhooks/payments/{gateway}  (signature verified)    │
   5. verify with gateway (server-to-server status call, not the redirect params)             │
   6. SUCCEEDED → POSTING → call domain adapter POST …/premiums/{sid}/payments {reference, amount}
        domain: re-validates amount == payable → existing collect path → receipt                │
   7. POSTED (store receipt_no) → notify customer ◀──────────────────────────────────────────┘
```

| State | Meaning | Allowed next |
|---|---|---|
| `CREATED` | Intent made, nothing sent | `INITIATED`, `EXPIRED`, `CANCELLED` |
| `INITIATED` | Sent to gateway | `PENDING`, `SUCCEEDED`, `FAILED`, `EXPIRED` |
| `PENDING` | Gateway says processing (async rails like Raast) | `SUCCEEDED`, `FAILED`, `EXPIRED` |
| `SUCCEEDED` | Gateway confirms funds | `POSTING` |
| `POSTING` | Calling the domain | `POSTED`, `POST_FAILED` |
| `POSTED` | Receipt issued | terminal |
| `POST_FAILED` | Money taken, domain refused (amount changed, policy lapsed meanwhile, schedule already paid) | auto-retry → `POSTED`, or `REFUND_REQUIRED` |
| `REFUND_REQUIRED` | Cannot apply; refund owed | `REFUNDED` (staff/finance action), alert |
| `FAILED` / `EXPIRED` / `CANCELLED` | No money moved | terminal |

**Guarantees:** exactly-once posting per `(gateway, reference)` (unique constraint + domain idempotency on `payment_reference`); duplicate webhooks are no-ops; a customer double-click returns the **same** intent via the idempotency key; amount is always domain-derived; a payment that succeeds *after* the quote expired is posted if the instalment is still payable at the **same** amount, else goes to `POST_FAILED → REFUND_REQUIRED` (never silently over/under-posts); a nightly **reconciliation job** lists intents in `SUCCEEDED/POSTING/POST_FAILED` older than 15 minutes and every gateway success without a receipt.

**Today's gateway is a mock** (B-03). The mock driver in the portal behaves like a real one (redirect page, delayed confirm, configurable failure/timeout) so every state above can be exercised before a real PSP exists; the **adapter contract does not change** when the driver does.

### 7.5 Documents

* PDFs live on `tenant-service` disk / S3 and are served by **unauthenticated** routes today (F-31). The portal fetches them server-to-server and **streams** them to the customer after the ownership check; the browser never sees an internal URL.
* The portal exposes **opaque, short-lived document handles** (`/v1/documents/{handle}`, 10-minute signed handle bound to the account) so a leaked URL expires and is useless to another account.
* Uploads (claim/reinstatement/exit evidence): type allow-list (pdf, png, jpg, jpeg, tiff — same as today), size ≤ 15 MB, magic-byte check, **malware scan** hook (blocker B-09), stored via the existing artifact pipeline through the adapter; `Artifact.uploaded_by` is null and a `customer:<id>` marker is stored in metadata.
* Document downloads are written to `document_access_log` (who/when/what) for fraud review.

### 7.6 Events and notifications

**Inbound** — consume `insurance.policy.lifecycle.v1` (already published for every `PolicyEvent` Stage B writes). Map to customer notifications and cache invalidation:

| Domain event (`event_type`) | Customer notification | Cache effect |
|---|---|---|
| `PolicyIssued` / `PaymentConfirmed` | "Your policy is active" + welcome kit | refresh list |
| `PremiumCollected` | "Payment received — receipt …" | refresh ledger |
| `PolicyEnteredGrace`, `PolicyLapsed` | "Premium overdue — pay by …" / "Your policy has lapsed — you can request reinstatement" | refresh |
| `RenewalOpened`, `RenewalNoticeIssued` | "Premium due on …" | refresh renewal |
| `PolicyRenewed`, `PremiumRenewalCompleted`, `RenewalConfirmationIssued` | "Renewal confirmed" | refresh |
| `ReinstatementRequested`/`ReinstatementDecision`/`PolicyReinstated` | stage-by-stage updates (customer wording; **no** rationale beyond what the decision letter says) | refresh |
| `PolicyEndorsed` | "Your policy was updated" | refresh |
| `ClaimRegistered`, `ClaimDocumentsComplete`, `ClaimDecision`, `ClaimSettled`, `ClaimClosed` | claim stage + what is needed from the customer | refresh |
| `ExitOpened`, `SurrenderRequested`, `ExitSettlementCalculated`, `ExitPaymentMade`, `PolicyMatured/Surrendered/Expired` | maturity/surrender progress, "figure ready — please review", "paid" | refresh |
| `PortalProvisioned`, `PortalCredentialsReset` | (account state only — **no notification of the password itself**) | — |

**Outbound** — outbox → `insurance.customer-portal.events.v1`: `account.provisioned`, `account.activated`, `account.password_changed`, `account.locked`, `account.suspended`, `contact.changed`, `service_request.submitted`, `payment.posted`, `payment.refund_required`, `step_up.failed_threshold`. `tenant-service` consumes `account.activated` (onboarding acknowledgment) and `contact.changed` (updates `Customer.details`, **only** via the Request-Management-style signed route, never directly).

Delivery channels: in-app inbox (always), email (SES path exists), SMS/WhatsApp (adapter; simulated driver until B-02 resolves). Preferences cannot disable *security* and *legal* notices (password changed, contact changed, claim decision, surrender, lapse).

### 7.7 Prerequisites and additive changes required in existing code

| ID | Change | Needed for | Size | Gate |
|---|---|---|---|---|
| **P-01** | **Authenticate the unauthenticated tenant-service routers** (`post_issuance`, `pre_issuance`, remaining unguarded routes in `renewals`, `reinstatement`, `branches`, `roles`, `tenants`, `demo`, `tokens`, `llm_config`, …): router-level dependency "valid **staff** JWT **or** signed internal call", with an inventory of non-browser callers first (chat-agent, request-management, scripts) **(unverified)** | Requirement 8 (B-01) | L | **Go-live blocker** |
| P-02 | Remove `tenant-service` from host port publishing in non-dev compose profiles; network policy | defence in depth | S | Go-live |
| P-03 | New `routers/customer_portal_internal.py` + `services/customer_portal_views.py` (§7.1) | all portal features | L | Stage 1+ |
| P-04 | Policyholder-ID allocator + `UNIQUE(tenant_id, policyholder_id)` | B-04 | M | Stage 1 |
| P-05 | `portal_service.py` → client of portal-service; `provision_portal` modes `ensure/reset`; reason required for reset; UI copy for "already active" | §6 | M | Stage 1 |
| P-06 | `onboarding_gate` reads portal account summary (cached) | §6.1 | S | Stage 1 |
| P-07 | Guard `onboarding/reset` | §6.7 | S | Stage 1 |
| P-08…P-12 | Extractions/helpers (§7.3) | claims, payments, cases | M | Stage 2–5 |
| P-13 | Kafka consumer in tenant-service for `account.activated` / `contact.changed` | onboarding ack, contact sync | S | Stage 1 |
| P-14 | `shared/security/service_auth.py`: add a `require_caller` helper that verifies the caller header (today each router does it by hand) | consistency | S | Stage 1 |
| P-15 | Block `DELETE /customers/{id}` while the customer has policies; emit `customer.deleted` | §6.8 | S | Stage 1 |
| P-16 | Extend `PolicyEvent` detail on customer-initiated actions with `portal_account_id`, `ip_hash`, `session_id`, `step_up:true/false` | fraud review | S | Stage 2+ |

---

## 8. Database design

### 8.1 Isolation

* PostgreSQL **schema `customer_portal`** in the same database as today (the host Postgres), exactly like `customer_service` and `request_management`. Moving to its own database later is a URL change (no code mentions the database name).
* Roles: **`customer_portal_owner`** (owns the schema, runs migrations, used only by the migrate/provision job) and **`customer_portal_app`** (what the service connects as): `SELECT/INSERT/UPDATE` on mutable tables, `SELECT/INSERT` only on append-only tables (`security_events`, `audit_events`, `payment_events`, `service_request_events`, `document_access_log`), **no DDL, no access to `public`**, no `DELETE` anywhere except purge jobs run as a separate `customer_portal_purge` role.
* **No foreign keys to or from other schemas; no ORM models imported from `shared/models/core.py`.** `tenant_id`, `customer_id`, `policy_id`, `claim_id` are opaque UUIDs.
* Migrations: numbered `migrations/0001_*.sql` with checksums in `customer_portal.schema_migrations`, advisory lock, "applied migration modified → stop" — the pattern of `services/customer-service/migrate.py`. Provisioning job `customer-portal-provision` (one-shot, like `customer-service-provision`). Production: run migrations as a deploy step, `CP_RUN_MIGRATIONS=false` on app instances.
* Row-level security (RLS) on every tenant-scoped table with `tenant_id = current_setting('cp.tenant_id')::uuid` set per request as defence in depth (policies created in `0002_rls.sql`).

### 8.2 Tables

**`accounts`** — one per `(tenant_id, customer_id)`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | |
| `customer_id` | uuid NOT NULL | `UNIQUE (tenant_id, customer_id)` |
| `username` | text NOT NULL | `UNIQUE (tenant_id, lower(username))` |
| `account_kind` | text | `CUSTOMER` (reserved: `FAMILY_MEMBER`, `CORPORATE_ADMIN`, `CORPORATE_EMPLOYEE`) |
| `state` | text | `PROVISIONED / ACTIVE / LOCKED / SUSPENDED / CREDENTIAL_EXPIRED / CLOSED` |
| `password_hash` | text | bcrypt (argon2id after first rehash) |
| `must_change_password` | bool | |
| `credential_issued_at`, `credential_expires_at` | timestamptz | temp-password validity |
| `password_changed_at`, `activated_at`, `last_login_at` | timestamptz | |
| `failed_count`, `locked_until` | int, timestamptz | |
| `language` | text | `en`/`ur` |
| `suspended_reason`, `suspended_by`, `suspended_at` | | staff action |
| `legacy_account_id` | uuid null | link to `public.customer_portal_accounts.id` (opaque) |
| `version`, `created_at`, `updated_at` | | optimistic locking |

**`credential_history`** — `(account_id, password_hash, created_at)`, last 5 enforced.

**`sessions`** — `id, account_id, tenant_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, ip_hash, user_agent_hash, device_id, revoked_at, revoke_reason, scope ('full'|'pwd_change')`.

**`refresh_tokens`** — `id, session_id, token_hash (sha256), parent_id, issued_at, used_at, replaced_by, expires_at`; presenting a token with `used_at` set → **revoke the whole session family** (`reuse_detected` security event).

**`login_attempts`** — `id, tenant_id, username_hash, ip, account_id null, outcome (SUCCESS/BAD_PASSWORD/UNKNOWN/LOCKED/SUSPENDED/EXPIRED), at` — indexed for the windows in §5.5; pruned after 90 days.

**`otp_challenges`** — `id, account_id, purpose (RESET/STEP_UP/CONTACT_VERIFY), action_class, session_id null, channel, destination_masked, code_hash, attempts, max_attempts, created_at, expires_at, consumed_at`.

**`step_up_grants`** — `session_id, action_class, granted_at, expires_at` (≤ 10 min).

**`contact_points`** — `id, account_id, kind (EMAIL/PHONE), value_enc, value_hash, verified_at null, source (TENANT_IMPORT/PORTAL_VERIFIED), changed_at, previous_value_hash` — values encrypted at rest; `changed_at` drives the recent-change window.

**`security_events`** *(append-only)* — `id, tenant_id, account_id null, kind, severity, ip_hash, session_id, detail jsonb, at` (login success/fail, lock, unlock, password change, reset requested/used, step-up success/fail, contact change, session revoked, token reuse, suspicious velocity).

**`audit_events`** *(append-only)* — business-level portal actions: `account_id, policy_id null, action, request_id, correlation_id, outcome, detail jsonb, at`.

**`notifications`** — `id, tenant_id, account_id, kind, severity, title_key, body_key, params jsonb, policy_id null, link, source_event_id null (dedupe), created_at, read_at, expires_at`; `UNIQUE(account_id, source_event_id)`.
**`notification_preferences`** — `account_id, channel, kind_group, enabled` (security/legal groups locked on).

**`payment_intents`** — `id, tenant_id, account_id, policy_id, schedule_id null, purpose (PREMIUM/RENEWAL/REINSTATEMENT), amount numeric(14,2), currency 'PKR', gateway, gateway_reference, status, idempotency_key, expires_at, posted_receipt_no null, refund_reference null, failure_code null, created_at, updated_at`; `UNIQUE (gateway, gateway_reference)`, `UNIQUE (account_id, idempotency_key)`.
**`payment_events`** *(append-only)* — status transitions with raw gateway payload hash.

**`service_requests`** — `id, tenant_id, account_id, policy_id null, kind (NOMINEE_CHANGE/ADDRESS_CHANGE/CONTACT_CHANGE/SUM_ASSURED_CHANGE/RIDER_CHANGE/SURRENDER/CLAIM_PAYEE/CALLBACK/…), status (SUBMITTED/IN_REVIEW/NEEDS_INFO/APPROVED/REJECTED/COMPLETED/WITHDRAWN), payload jsonb, domain_ref_kind, domain_ref_id null (e.g. exit case, claim), submitted_at, decided_at, outcome_note (customer-safe), version`.
**`service_request_events`** *(append-only)*.

**`document_access_log`** *(append-only)* — `account_id, policy_id, document_kind, document_ref_hash, at, ip_hash`.

**`idempotency_keys`** — `(account_id|service, key) PK, request_hash, response_status, response_body_enc, created_at, expires_at`.

**`outbox_events`**, **`consumed_events`** — transactional outbox to Kafka and consumer dedupe (identical to Request Management's design).

**`tenant_cache`** — `tenant_id PK, code UNIQUE, name, is_active, display jsonb (logo, colours, support contacts), domains text[], refreshed_at` — a **cache** populated from the domain (internal `GET /tenants/by-code/{code}`), TTL 5 min; **not** an authority.

### 8.3 Retention and privacy

| Data | Retention |
|---|---|
| `login_attempts` | 90 days |
| `security_events`, `audit_events`, `payment_events`, `document_access_log` | 7 years (insurance record-keeping; **confirm with compliance**) |
| `sessions`, `refresh_tokens`, `otp_challenges`, `step_up_grants` | purge 30 days after expiry/revocation |
| `notifications` | 18 months |
| `idempotency_keys` | 48 h |
| Closed accounts | credentials destroyed on closure; audit retained |

PII in logs is forbidden: log `account_id`, `tenant_id`, `request_id`; never CNIC, phone, email, tokens, OTPs, IBANs. CNIC is displayed masked (`35202-*******-1`) everywhere in the portal.

---

## 9. API specification

### 9.1 Conventions

* Base: `customer-portal-service` `/v1` (internal network); browser reaches it **only through the BFF** `customer-portal-app` at `/api/portal/*`, which adds the bearer from the `httpOnly` cookie.
* JSON; errors use the platform envelope from Request Management: `{"error":{"code":"…","message":"…","details":{…}}}` with **stable machine codes** (the UI translates by code → English/Urdu; the `message` is a developer string).
* `Idempotency-Key` required on `POST /v1/payments`, `POST …/claims`, `POST …/exit/surrender-request`, `PUT …/autopay`, `POST …/servicing/requests`, `POST /v1/auth/step-up/*`.
* `X-Correlation-Id` accepted/generated and echoed. `Accept-Language: en|ur` selects server-generated customer text (notification titles, letters).
* Pagination `?page&page_size` (max 100). Optimistic concurrency via `version` where a resource is editable.
* Rate-limit headers `RateLimit-Limit/Remaining/Reset` on throttled routes.

### 9.2 Public API (customer-facing)

`Auth` column: **P** public · **S** session (full scope) · **PW** pwd_change scope only · **SU** requires fresh step-up (action class in parentheses).

#### Authentication and account

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /v1/auth/login` | P | `{tenant_code, username, password}` → tokens or `PASSWORD_CHANGE_REQUIRED` |
| `POST /v1/auth/password/first-change` | PW | Forced change of the temporary password |
| `POST /v1/auth/refresh` | refresh cookie | Rotate refresh token, new access token |
| `POST /v1/auth/logout` · `POST /v1/auth/logout-all` | S | End this / all sessions |
| `POST /v1/auth/password/forgot` | P | Always `202`; sends OTP/link only if a **verified** channel exists |
| `POST /v1/auth/password/reset` | P (OTP) | `{challenge_id, code, new_password}` |
| `POST /v1/auth/step-up/challenge` · `…/verify` | S | `{action_class}` → OTP; verify grants a 10-min grant |
| `GET /v1/me` | S | Account, masked customer summary, workspaces, flags (`must_change_password`, `contact_verified`, `language`, `unread`) |
| `PATCH /v1/me/preferences` | S | Language, notification preferences |
| `POST /v1/me/password` | S | Change password (current + new) |
| `GET /v1/me/sessions` · `DELETE /v1/me/sessions/{id}` | S | List / revoke devices |
| `GET /v1/me/security-events` | S | Last 50 security events (customer wording) |
| `POST /v1/me/contact/verify/start` · `…/confirm` | S | Verify email/phone by OTP |
| `PUT /v1/me/contact` | S + SU(contact) | Change contact (via domain adapter; new value unverified) |

#### Overview and policies

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v1/home` | S | Aggregate: policies needing action, next payments, open requests/claims, unread notifications |
| `GET /v1/policies` | S | Individual policies of this customer |
| `GET /v1/policies/{id}` | S | Detail (cover, riders, nominees, dates, premium, versions) |
| `GET /v1/policies/{id}/timeline` | S | Customer-wording activity |
| `GET /v1/policies/{id}/documents` | S | Available documents (handles) |
| `GET /v1/documents/{handle}` | S | Stream a document (handle expires in 10 min) |

#### Premiums, payments, renewals

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v1/policies/{id}/premiums` | S | Ledger, next due, grace info |
| `GET /v1/policies/{id}/premiums/receipts` · `GET /v1/receipts/{handle}` | S | Receipts |
| `POST /v1/payments` | S | Create payment session (`{policy_id, schedule_id, purpose, method, return_url}`) — amount is server-derived |
| `GET /v1/payments/{id}` · `POST /v1/payments/{id}/cancel` | S | Status / abandon |
| `POST /v1/webhooks/payments/{gateway}` | signature | Gateway callback (not customer-called) |
| `PUT /v1/policies/{id}/autopay` | S + SU(payment_setup) | Enable/disable |
| `GET /v1/policies/{id}/renewal` | S | Next due, type, notice, tracker |
| `POST /v1/policies/{id}/renewal/acceptance` | S + SU(terms) | Accept renewed terms (contract renewal) |

#### Reinstatement, servicing, free-look

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v1/policies/{id}/reinstatement` | S | Eligibility, arrears, case tracker |
| `POST /v1/policies/{id}/reinstatement` | S | Request reinstatement |
| `POST /v1/policies/{id}/reinstatement/{case}/declaration` | S + SU(declaration) | E-signed health declaration |
| `POST /v1/policies/{id}/reinstatement/{case}/documents/{key}` | S | Upload evidence |
| `POST /v1/policies/{id}/reinstatement/{case}/terms-response` | S + SU(terms) | Accept/reject revised terms |
| `POST /v1/policies/{id}/reinstatement/{case}/withdraw` | S | Withdraw |
| `GET /v1/policies/{id}/servicing` | S | Current nominees/contact/address, open requests, re-quote ability |
| `POST /v1/policies/{id}/servicing/requests` | S + SU(profile_change) | `{kind, payload}` → service request |
| `GET /v1/policies/{id}/servicing/quote` | S | Re-quote preview (no side effects) |
| `GET /v1/requests` · `GET /v1/requests/{id}` · `POST /v1/requests/{id}/withdraw` | S | My service requests |
| `GET /v1/policies/{id}/free-look` · `POST …/free-look/cancel` | S (+SU(cancellation)) | Free-look status / cancel with refund |

#### Claims

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v1/policies/{id}/claims/options` | S | Which claim types this policy can make a claim for (benefit menu) |
| `POST /v1/policies/{id}/claims` | S | Intimation (event, covered person, amount, description) |
| `GET /v1/claims` · `GET /v1/claims/{id}` | S | My claims / detail (customer view) |
| `POST /v1/claims/{id}/documents/{key}` | S | Upload a checklist document |
| `GET /v1/claims/{id}/checklist` · `GET /v1/claims/{id}/letter` | S | Checklist PDF / outcome letter |
| `PUT /v1/claims/{id}/payee` | S + SU(payout_details) | Submit payout bank details (staff verify) |

#### Maturity and exit

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v1/policies/{id}/exit` | S | Maturity date, indicative values, current exit case |
| `POST /v1/policies/{id}/exit/surrender-request` | S + SU(surrender) | `{reason}` → opens a surrender case |
| `POST /v1/exits/{id}/documents/{key}` | S | Upload form/CNIC/policy copy |
| `POST /v1/exits/{id}/consent` | S + SU(surrender) | Declarations |
| `GET /v1/exits/{id}/statement` | S | Settlement statement (PDF) |
| `POST /v1/exits/{id}/settlement/acceptance` | S + SU(surrender) | Accept / decline the figure |
| `PUT /v1/exits/{id}/payee` | S + SU(payout_details) | Submit bank details (staff verify) |
| `POST /v1/exits/{id}/withdraw` · `GET /v1/exits/{id}/letter` | S | Withdraw before payment / closure letter |

#### Notifications and help

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v1/notifications` · `POST /v1/notifications/{id}/read` · `POST /v1/notifications/read-all` | S | Inbox |
| `GET /v1/help` | S | Insurer contact card, FAQs, claim helpline |
| `POST /v1/help/callback` | S | Request a call back (stored; staff work it) |

#### Operational

`GET /v1/healthz` (liveness) · `GET /v1/readyz` (DB, tenant-service reachability, Kafka, gateway-driver) · `GET /v1/version`.

### 9.3 Internal API — `tenant-service` → `customer-portal-service` (`/internal/v1`, HMAC `TENANT_TO_CP_KEY`)

| Method + path | Purpose |
|---|---|
| `PUT /internal/v1/accounts` | Ensure/reset an account (`mode: ensure|reset`) — returns the one-time temp password when minted (§6.2) |
| `POST /internal/v1/accounts/import` | Batch import of legacy accounts (§6.6 M1), idempotent |
| `GET /internal/v1/accounts/by-customer/{customer_id}?tenant_id=` | Summary for the onboarding checklist (`state, username, must_change_password, last_login_at`) — **no hash** |
| `POST /internal/v1/accounts/{id}/suspend` · `…/release` | Staff fraud hold (with reason) |
| `DELETE /internal/v1/accounts/{id}` | Guarded dev reset only (§6.7) |
| `POST /internal/v1/customers/{customer_id}/events` | `customer.deleted`, `customer.profile.changed` (or via Kafka) |
| `GET /internal/v1/accounts/export` | Signed one-release rollback export of hashes (§6.6 M3) |

### 9.4 Internal API — `customer-portal-service` → `tenant-service` (`/internal/customer-portal/v1/tenants/{t}/customers/{c}/…`, HMAC `CP_TO_TENANT_KEY`)

Mirrors §7.2 one-to-one. Representative set:

| Method + path | Maps to |
|---|---|
| `GET …/policies` · `GET …/policies/{p}` | C-01, C-02 |
| `GET …/policies/{p}/timeline` · `…/documents` · `…/documents/{h}` | C-03, C-09 |
| `GET …/policies/{p}/premiums` · `…/premiums/{s}/payable` · `POST …/premiums/{s}/payments` | C-04, C-05, C-06 |
| `PUT …/policies/{p}/autopay` · `POST …/policies/{p}/free-look/cancel` | C-07, C-08 |
| `GET …/policies/{p}/renewal` · `POST …/renewal/acceptance` · `POST …/renewal/payments` | C-10–C-12 |
| `GET/POST …/policies/{p}/reinstatement…` | C-13 |
| `GET …/policies/{p}/servicing` · `POST …/servicing/contact` · `…/address` · `GET …/servicing/quote` · `POST …/servicing/requests` | C-14–C-17 |
| `GET …/policies/{p}/claims/options` · `POST …/claims` · `GET …/claims/{c}` · `POST …/claims/{c}/documents/{k}` · `PUT …/claims/{c}/payee` | C-19–C-22 |
| `GET …/policies/{p}/exit` · `POST …/exit/surrender-request` · `…/exit/{e}/consent` · `…/settlement/acceptance` · `PUT …/exit/{e}/payee` · `POST …/exit/{e}/withdraw` | C-23–C-29 |
| `GET /internal/customer-portal/v1/tenants/by-code/{code}` | tenant resolution |

All return **customer views** only; all take `X-Idempotency-Key` when state-changing; all start with `owned_individual_policy(...)`.

### 9.5 Starter error-code catalogue

`INVALID_CREDENTIALS` · `PASSWORD_CHANGE_REQUIRED` · `CREDENTIAL_EXPIRED` · `TOO_MANY_ATTEMPTS` · `SESSION_EXPIRED` · `STEP_UP_REQUIRED` · `STEP_UP_FAILED` · `CONTACT_NOT_VERIFIED` · `WEAK_PASSWORD` · `PASSWORD_REUSED` · `NOT_FOUND` · `ACTION_NOT_AVAILABLE` (domain refused; `details.reason_code`) · `AMOUNT_CHANGED` · `PAYMENT_DECLINED` · `PAYMENT_PENDING` · `PAYMENT_EXPIRED` · `DUPLICATE_REQUEST` · `COOLING_OFF_ACTIVE` · `REVIEW_REQUIRED` · `DOMAIN_UNAVAILABLE` · `VALIDATION_FAILED` · `FILE_REJECTED` · `RATE_LIMITED`.

---

## 10. Frontend — `customer-portal-app`

### 10.1 Shape

* Separate Next.js 14 (App Router) + Tailwind app, container port **3009**, its own `package.json`, build and image. It is **not** a route group inside `frontend/` and does not share the staff `ClientLayout`.
* **BFF**: route handlers under `app/api/portal/*` forward to `customer-portal-service` and attach the access token from an `httpOnly; Secure; SameSite=Lax` cookie (`cp_at`, path `/`) and the refresh token from `cp_rt` (path `/api/portal/auth`). The browser JavaScript never sees a token. No `localStorage` for credentials.
* `middleware.ts` redirects unauthenticated users to `/login`, users with `must_change_password` to `/first-login`, and sets the CSP and security headers (§12.8).
* Server components fetch through the same BFF client (cookie forwarded), so first paint is real data; client components use SWR-style revalidation and listen to the notification stream (SSE, with polling fallback).

### 10.2 Reuse versus forbidden

| Reuse (copy or shared package) | Forbidden in the portal |
|---|---|
| Tailwind config, design tokens, spacing and colour scale from `frontend/globals.css` (visual consistency with the enterprise UI) | `components/Sidebar`, `TopBar`, `ClientLayout`, `NotificationContext` (staff semantics, staff roles) |
| Presentational components that take **props only**: cards, status pills, stepper, tables, dialogs, form fields, document viewer, empty states | `lib/api.ts` (staff token from `localStorage`, gateway base URL) |
| The i18n engine pattern (`I18nProvider`, `tx`) and the **same key naming style** | `lib/satellite/*` and the `insurance_sso` cookie (staff SSO — must never authenticate a customer) |
| Stepper / workflow rendering approach from the Stage B panels (`RenewalsPanel`, `ReinstatementPanel`, `ClaimsPanel`, `ExitPanel`) | Any staff-only action button (decide, authorise, disburse, waive, remind, realize) |

Shared presentational pieces are extracted once into a small workspace package **`packages/ui-core`** (types + dumb components) consumed by both apps **only after Stage 1 proves the need**; until then Stage 1 copies the few it needs, to keep staff behaviour untouched (Requirement 7).

### 10.3 Languages (English / Urdu)

* Own message bundles `messages/en.json` and `messages/ur.json`; cookie **`cp_locale`** (not `insurance_locale`, so the two apps do not couple); also stored on the account (`accounts.language`) and applied on next login on another device.
* RTL: `<html dir="rtl" lang="ur">`, logical CSS properties (`ms-*`, `ps-*`, `text-start`), mirrored icons only where directional. Numbers, PKR amounts and dates formatted with `Intl` using `ur-PK`/`en-PK`; **policy numbers, CNIC, IBAN and reference numbers always render LTR** (`<bdi dir="ltr">`).
* Server errors are translated **by code** (§9.5); the backend never ships the sentence the UI displays. Notification text is rendered from `title_key + params` in the viewer's current language, so switching language re-translates history.
* Fonts: Noto Nastaliq Urdu for headings, Noto Naskh Arabic for body (self-hosted; no third-party request). PDFs generated by the domain are English today; Urdu glyph support in PDFs is **unverified** (R-11) — the portal labels them "English document".
* Release gate: a script fails the build if a key exists in `en.json` without a `ur.json` counterpart.

### 10.4 Screen inventory (Individual workspace — Stage 1 → 5)

| # | Route | Screen | Primary content | Stage |
|---|---|---|---|---|
| S-01 | `/login` | Sign in | Tenant/company (from host or field), username, password, language toggle, "Forgot password", help | 1 |
| S-02 | `/first-login` | Set your password | Policy explained, password rules meter, confirm; success → home | 1 |
| S-03 | `/forgot` · `/reset` | Reset password | Neutral confirmation; OTP entry; new password | 1 |
| S-04 | `/` | Home | "Needs your attention" cards (payment due, document requested, figure to review), policy tiles, next payment, active requests/claims, announcements | 1 (read-only) |
| S-05 | `/policies` | My policies | Cards: product, number, status pill, sum assured, next due, quick actions | 1 |
| S-06 | `/policies/[id]` | Policy overview | Header, key facts, cover & riders, nominees, premium, status, timeline tab, documents tab | 1 |
| S-07 | `/policies/[id]/premiums` | Premiums | Instalment ledger, due/grace/overdue chips, receipts, **Pay now**, autopay | 2 |
| S-08 | `/pay/[intent]` · `/pay/return` | Payment | Summary, method, hand-off to gateway, result (success/pending/failed), receipt | 2 |
| S-09 | `/policies/[id]/renewal` | Renewal | Next due, renewal type, notice, tracker, accept terms (contract renewal), pay | 2 |
| S-10 | `/policies/[id]/reinstatement` | Reinstatement | Eligibility, arrears breakdown, declaration (e-sign), evidence upload, revised terms, payment, outcome | 3 |
| S-11 | `/policies/[id]/manage` | Manage policy | Contact, address, nominees, sum assured/riders (re-quote), requests list | 3 |
| S-12 | `/policies/[id]/free-look` | Free-look | Window countdown, cancel with refund summary | 3 |
| S-13 | `/claims` · `/claims/new` · `/claims/[id]` | Claims | Benefit picker, intimation wizard, checklist & uploads, status tracker, outcome, payout details | 4 |
| S-14 | `/policies/[id]/maturity` | Maturity & exit | Indicative values, surrender request wizard (reason → documents → consent → figure → payee), tracker, letters | 5 |
| S-15 | `/requests` | My requests | Every service request/claim/exit/reinstatement across policies with status | 3 |
| S-16 | `/notifications` | Inbox | Filter by policy/type, mark read, deep links | 2 |
| S-17 | `/account` | Account & security | Profile (read-only core fields), contact (verify/change), password, devices, security activity, language, notification preferences | 1 (password/devices) → 3 |
| S-18 | `/help` | Help | Contact card, claim helpline, FAQs, call-back request | 1 |
| S-19 | `/session-expired`, `/locked`, `/maintenance`, `/403-not-yours` (renders as 404) | State pages | Friendly error handling | 1 |

### 10.5 UX rules

* **Plain language, one next step**: every policy shows a single prominent next action derived from state (pay now / sign declaration / review figure / nothing).
* **Wizards** for claims, reinstatement, surrender: save progress server-side (draft), resumable, step counter, leave-and-return safe. Money, bank details and signatures always have a final review screen.
* **Disabled actions explain why** using the domain's `reason_code` (e.g. "Reinstatement is possible within 24 months of the lapse date").
* **Destructive/irreversible actions** (free-look cancel, surrender, accept settlement) use a typed-name or checkbox confirmation plus step-up; the confirmation page restates consequences.
* **Responsive-first** (most customers are on phones): single column ≤ 640 px, tap targets ≥ 44 px, bottom action bar, file uploads via camera.
* **Accessibility** WCAG 2.1 AA: visible focus, labels, `aria-live` for async status, colour is never the only signal, tested with a screen reader on login, payment and claim wizard, keyboard-only pass on every form, respects `prefers-reduced-motion`.
* **Resilience**: optimistic UI is *not* used for money or legal acts; every submit is idempotent and shows a pending state; offline/slow network shows retry, never a false success.
* **Privacy**: policy numbers fully shown, CNIC/phone/email/IBAN masked by default with "reveal" requiring recent authentication (15 min).

---

## 11. Full lifecycle coverage (what a customer can do, per phase)

For each phase: **customer can**, **customer cannot**, **exceptions the design handles**.

| Phase | Customer can | Customer cannot | Exceptions & failure handling |
|---|---|---|---|
| **0 Account** | Receive credentials, first login, change password, reset, manage devices, verify contact | See other customers' data; reuse temp password; skip the forced change | Expired invite → CREDENTIAL_EXPIRED + staff reissue; lockout; wrong tenant; typo username; customer without email/phone; duplicate customers |
| **1 Policy view** | See all individual policies, details, nominees, riders, documents, timeline | See staff data, premium loadings internals, other families' policies | Policy in non-visible status (Quoted/Pending) hidden or "in progress"; policy transferred; archived |
| **2 Free-look** | See window, cancel and get refund to original payer | Cancel after the window; redirect refund to a new account | Window boundary at midnight tenant TZ; refund pending; already cancelled (idempotent) |
| **3 Premium & payments** | Pay current/overdue instalments, see receipts, autopay | Pay arbitrary amount; pay a future instalment out of order (domain decides); mark paid | Gateway down/timeout; declined; async pending; double-click; webhook before return; amount changed; paid by staff meanwhile; partial; late surcharge change at midnight; refund required |
| **4 Renewal** | See next due, pay, accept renewed terms, track the renewal | Choose a decision outcome; waive surcharges | Acceptance deadline; terms differ from notice; renewal case opened by sweep concurrently; accepted twice |
| **5 Reinstatement** | Request, declare health (e-sign), upload evidence, accept revised terms, pay arrears, withdraw | Decide, restore, alter arrears | Window expired (24 m); open claim/surrender blocks; evidence deadline; terms expire; payment succeeds but policy changed; withdraw after payment |
| **6 Servicing** | Update contact/address; request nominee/sum-assured/rider changes; see quote | Self-approve risk-changing endorsements | Nominee shares ≠ 100; minor nominee; duplicate request; staff concurrently edits; request on a lapsed policy; customer changes contact then attempts fraud (cooling-off) |
| **7 Claims** | Intimate, upload, track, submit payout details, read the outcome letter | See investigation, scores; edit after submission except via "provide more info" | Death claim by nominee (not the policyholder) — see S-claim; late intimation; duplicate claim; claim on lapsed policy (domain rule); document rejected/re-request; payee mismatch |
| **8 Maturity/exit** | See maturity info; request surrender; consent; accept/decline figure; submit payout details; withdraw before payment | Receive money to someone else; accept after expiry of figure | Figure expired; policy has loan; assignment; payment returned; maturity but customer unreachable (unclaimed, handled by staff) |
| **9 Closure** | Download letters; keep read-only access to closed policies for a retention period | Reactivate | Account remains while any policy exists or for N months after the last one closes; then CLOSED |

**Death-claim access (design note, decision D-12).** A deceased policyholder cannot log in; the claimant is a **nominee or legal heir**. Stage 1–5 keeps claim intimation for *non-death* events (the policyholder claiming) in the portal. Death claims by nominees continue through the branch/agent/helpline path (Stage B already supports this); a **claimant-without-account** flow (guest intimation with CNIC + policy number + OTP to the nominee's recorded phone) is a later optional phase because it widens the attack surface and needs a legal review.

---

## 12. Security, authorization and fraud controls

### 12.1 STRIDE-lite per trust boundary

| Threat | Where | Control |
|---|---|---|
| **S**poofing a customer | login, refresh, reset | bcrypt/argon2; throttling (§5.5); OTP on verified channels only; refresh rotation + reuse detection; device/IP anomaly step-up |
| Spoofing a staff user | portal → tenant-service | HMAC with caller check; separate keys per direction; ±300 s + nonce cache (replay) |
| **T**ampering (client-supplied money/IDs) | pay, claim, exit | Amount never from the client; object IDs are checked against the owned policy; `realize`/`manual`/`waive` unavailable |
| **R**epudiation | e-sign, accept terms | Append-only `audit_events` + `PolicyEvent` with account, session, IP hash, step-up flag, text version shown (hash of the declaration wording) |
| **I**nformation disclosure | IDOR, errors, logs, caches | 4-gate authorization (§5.7), 404 not 403, allow-list projection, PII masking, no PII in logs, `Cache-Control: no-store` on authenticated JSON/PDF |
| **D**enial of service | login, OTP, pay | Per-IP + per-account + per-tenant limits, OTP cost caps, request size limits, upload limits, circuit breakers to the domain |
| **E**levation | customer→staff, tenant→tenant | Distinct secret/iss/aud/typ; the staff verifier rejects `aud=customer-portal`; the portal verifier rejects staff tokens; tenant ID only from the token, never from a header/query |

### 12.2 Authorization gates (recap, applied on every request)

1. **Token gate** — valid signature, `iss/aud/typ/exp`, `jti` not revoked, session active, `scp` allows the route.
2. **Account gate** — state `ACTIVE` (or `PROVISIONED` for first-change only); not locked/suspended.
3. **Ownership gate** — `(tenant_id, customer_id)` from the token must match the resource chain (policy → customer); individual segment only.
4. **Capability/risk gate** — the policy status permits the action (the domain decides) and the risk class has fresh step-up when required.

Row-level security in `customer_portal` and the `owned_individual_policy` check in the domain are **independent** layers: a bug in one must not expose data.

### 12.3 Risk classes and step-up matrix

| Class | Examples | Requirement |
|---|---|---|
| **R0** | Read lists/details/timeline, notifications | Valid session |
| **R1** | Download documents, reveal masked data | Session + authenticated within 15 min (else password re-entry) |
| **R2** | Pay premium, upload documents, withdraw, file claim intimation | Session + recent auth; velocity limits; payment risk checks |
| **R3** | Change password, contact, address, nominee, payout bank details, autopay, free-look cancel, surrender, accept terms/figure, e-sign declaration | **Fresh step-up OTP (≤ 10 min)** to a *verified, not-recently-changed* channel (else fall back to a second factor: password + knowledge check; if neither is possible → "visit branch / call centre") |
| **R4** | Account closure, bulk export of data | Not offered in the portal (staff only) |

### 12.4 Fraud and abuse controls

| Control | Detail |
|---|---|
| **Cooling-off after sensitive change** | After a contact/phone/email change, new nominee, or new payout bank details, **payouts to the new details and further sensitive changes are held for 72 h** (`COOLING_OFF_ACTIVE`), the customer and the *previous* contact are both notified; staff see the hold on the case |
| **Account-takeover signals** | New device + R3 action, impossible travel, many failed logins then success, reset followed by contact change within minutes → force step-up with a stronger challenge and raise a staff alert; repeated → `SUSPENDED` pending review |
| **Payment velocity** | Per-account and per-card/instrument limits on attempts and failed attempts/hour; mismatch between gateway payer name and policyholder logged (not blocking) |
| **Claims & exit** | Customer cannot influence duplicate/fraud scoring; new-policy claims (inside the contestability period) and recently changed nominee/payee are flagged **for staff** through existing claim flags (read-only to customer) |
| **Enumeration** | Neutral responses and timing equalisation on login / forgot / reset / OTP; tenant code and username never confirmed independently |
| **Brute force** | See §5.5; OTP: 5 attempts per challenge, 3 challenges/hour/account, 10/day |
| **Insider abuse** | Staff "provision/reset" requires a reason, is logged, and the customer is notified of a reset; no staff impersonation (D-09); staff can **suspend** an account but never read a password or hash |
| **Uploads** | Magic-byte validation, size and count caps, filename sanitisation, storage outside web root, virus-scan hook before staff can open (B-09); images stripped of EXIF location |
| **Bots** | CAPTCHA provider hook on login after N failures and on forgot-password (provider choice open) |
| **Data export/scraping** | Paginated, rate-limited, no bulk endpoints; document handles expire |

### 12.5 Sessions and tokens

* Access JWT 15 min (HS256 now; **RS256/ES256 with `kid` rotation** is the recommended upgrade because staff and portal services would then not need to share a secret with `tenant-service`), refresh 30 min idle / 12 h absolute, rotating, hashed at rest.
* Logout revokes the session; password change/reset **revokes all sessions** except the current one (reset: all).
* `SameSite=Lax` cookies + double-submit CSRF token header on all state-changing BFF calls; `Origin` must equal the portal origin.
* Concurrent session cap (e.g. 5), oldest evicted with a notice.

### 12.6 Data protection

* Passwords bcrypt cost ≥ 12 (argon2id on rehash). OTPs and refresh tokens stored as hashes. Contact values encrypted at rest (app-level key from env/KMS).
* TLS everywhere; internal calls signed, and the internal network is not published.
* Logs: structured, correlation id, **no PII**; sensitive fields redacted by a logging filter with unit tests.
* Data subject rights: export and correction requests are handled through the staff channel; the portal exposes only what the customer already sees. **Applicable data-protection requirements (Pakistan PDPA draft, SECP/SBP rules, insurer policy) are unverified** and listed as decision D-13.

### 12.7 CORS and the gateway

The portal does not use the gateway. `customer-portal-app` calls its own origin (BFF); the BFF calls the service on the internal network. The service sets **no CORS headers** (not called by browsers). Separately, the permissive gateway/tenant CORS (B-05) is a staff-side hardening item tracked in P-01/P-02.

### 12.8 Browser hardening

CSP `default-src 'self'`; `frame-ancestors 'none'`; `connect-src 'self' <gateway-origin>`; `form-action 'self' <gateway-origin>`; HSTS; `X-Content-Type-Options`; `Referrer-Policy: same-origin`; Permissions-Policy denying camera except the upload pages; sub-resource integrity for any third-party script (target: none).

---

## 13. Scenario and test matrix

**Layers:** U = unit, I = integration (service + DB), C = contract (portal ↔ tenant-service adapter), E = end-to-end (browser→BFF→service→domain), S = security test, N = non-functional/load, M = manual/UAT.
**Priority:** P0 = release blocker for the stage that introduces it, P1 = required before go-live, P2 = nice to have.

### 13.1 ACT — Account provisioning and first login

| ID | Scenario | Expected result | Layer | Pri |
|---|---|---|---|---|
| ACT-01 | Staff provisions portal for an issued individual policy (first time) | Account `PROVISIONED`; username + temp password returned once; hash stored; legacy row mirrored; onboarding step done | I/E | P0 |
| ACT-02 | Provision again while the account is `PROVISIONED` (not used) | Existing account kept; staff chooses *reset*; new temp password; old one invalid; event logged | I | P0 |
| ACT-03 | Provision for a customer who already has an `ACTIVE` account (second policy) | No new account, no reset; response `already_active`; policy simply appears in portal | I/E | P0 |
| ACT-04 | Staff *reset* an active account | Reason mandatory; sessions revoked; state back to `PROVISIONED`; customer notified on verified channel | I | P0 |
| ACT-05 | First login with correct temp password | Token scope `pwd_change` only; every other route 403 `PASSWORD_CHANGE_REQUIRED` | I/S | P0 |
| ACT-06 | Complete first password change | Account `ACTIVE`; old temp invalid; full-scope tokens issued; all other sessions revoked; `account.activated` event | I/E | P0 |
| ACT-07 | Temp password expired (> validity) | `CREDENTIAL_EXPIRED`; neutral login failure message; staff reissue works | I | P0 |
| ACT-08 | New password equals temp password / username / CNIC / last 5 | Rejected with specific code | U | P0 |
| ACT-09 | Password policy edge: 7/8/128/129 chars, unicode, spaces, common list | Accept/reject per policy | U | P1 |
| ACT-10 | Provision for customer with no email and no phone | Allowed; flagged `contact_unverified`; recovery only via staff; UI warns | I | P1 |
| ACT-11 | Provision for customer whose email is shared with another customer | Allowed (spouses); OTP goes to the shared address; no username disclosure in notice | I | P1 |
| ACT-12 | Username collision (two customers same derived name) in one tenant | Second gets suffix; unique index holds under concurrency | I | P0 |
| ACT-13 | Same username in two tenants | Both allowed; tenant resolution isolates | I/S | P0 |
| ACT-14 | Policyholder-ID generation under 50 concurrent issuances | Unique IDs (P-04) | I | P0 |
| ACT-15 | Staff provisions on a policy that is not yet Active/issued | Refused by domain (`not_issued`) | I | P0 |
| ACT-16 | Welcome email lacks password | Verified by content check | I | P0 |
| ACT-17 | Customer record is later deleted by staff | Blocked while policies exist (P-15) or account closed on event | I | P1 |
| ACT-18 | `onboarding/reset` called against production-like config | 403 unless dev flag + role | S | P0 |
| ACT-19 | Account suspended by staff | Login `ACCOUNT_SUSPENDED` generic; sessions revoked; customer informed via support | I | P1 |
| ACT-20 | Suspended → released | Login works; `must_change_password` honoured | I | P1 |

### 13.2 SES — Authentication, sessions, recovery

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| SES-01 | Correct login | Tokens as cookies via BFF; no token in JS | E/S | P0 |
| SES-02 | Wrong password / unknown user / wrong tenant | Identical response and timing class | S | P0 |
| SES-03 | 5 bad passwords in 15 min | Account `LOCKED` for 15 min (escalating); security event; neutral message | I/S | P0 |
| SES-04 | Correct password while locked | Still refused until expiry; counter rule documented | I | P0 |
| SES-05 | Distributed guessing: one IP, many usernames | IP-level throttle trips | S/N | P0 |
| SES-06 | One username from many IPs | Account-level lock, not IP | S | P0 |
| SES-07 | Access token expiry mid-use | Silent refresh via BFF; request retried once | E | P0 |
| SES-08 | Refresh token reuse (replay) | Whole session family revoked; `reuse_detected` | I/S | P0 |
| SES-09 | Idle 30 min | Session ends; redirect with return URL after login | E | P0 |
| SES-10 | Absolute 12 h | Session ends | I | P1 |
| SES-11 | Logout / logout-all | Tokens invalid immediately (jti/session check) | I | P0 |
| SES-12 | Password changed in another browser | Other sessions revoked | I | P0 |
| SES-13 | Forgot password for verified email | OTP sent; reset works; all sessions revoked; notification sent | I/E | P0 |
| SES-14 | Forgot password for unknown/unverified account | Same `202`; no email; timing equal | S | P0 |
| SES-15 | OTP wrong ×5 | Challenge dead; new challenge limited | I | P0 |
| SES-16 | OTP expired / reused | Rejected | I | P0 |
| SES-17 | Reset flood (20 requests/min) | Rate-limited; no OTP spam | S/N | P0 |
| SES-18 | Staff JWT presented to portal API | 401 (aud/iss mismatch) | S | P0 |
| SES-19 | Portal JWT presented to staff API / gateway | 401 | S | P0 |
| SES-20 | `alg=none`, tampered claims, wrong `kid`, expired `exp`, future `nbf` | All rejected | S | P0 |
| SES-21 | `pwd_change` token used on data routes | 403 | S | P0 |
| SES-22 | CSRF: cross-site POST with cookie | Rejected (token + Origin) | S | P0 |
| SES-23 | Concurrent refresh from two tabs | One wins, other retries safely, no false reuse alarm (grace window 10 s) | I | P1 |
| SES-24 | Clock skew ±2 min between services | Tolerated | I | P1 |
| SES-25 | Login with CAPS/whitespace in username | Normalised | U | P2 |
| SES-26 | Login page language switch persists | `cp_locale`; account language applied after login | E | P1 |

### 13.3 MUL — One account, many policies (Requirement 3)

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| MUL-01 | Customer buys a second individual policy later | Same username/password; new policy visible after issuance; no new credentials issued | E | P0 |
| MUL-02 | Staff presses "Provision" on policy #2 | Returns `already_active`; no reset | I | P0 |
| MUL-03 | Three policies, one lapsed, one matured | Each shows its own status and actions | E | P0 |
| MUL-04 | Policies in two different products | Product-specific labels and rules per policy | E | P1 |
| MUL-05 | Customer has individual + family policy | Individual workspace shows only individual; family appears as a "coming soon / separate workspace" entry (not exposed in Stage 1) | E | P0 |
| MUL-06 | Pay two different policies in parallel tabs | Independent intents; no cross-contamination | E | P1 |
| MUL-07 | Policy transferred/reassigned to another customer | Disappears for old account; appears for new; audit | I | P1 |
| MUL-08 | 50 policies for one customer | Pagination and performance targets | N | P2 |
| MUL-09 | Account exists, customer has 0 active policies (all closed) | Read-only history; no actions | E | P1 |
| MUL-10 | Notification for policy #2 does not leak policy #1 | Scoped | I | P0 |

### 13.4 POL — Policy views and data

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| POL-01 | List returns only this customer's individual policies | Verified with seed of other customers/tenants | C/S | P0 |
| POL-02 | Detail of own policy | Allow-listed fields only (golden file) | C | P0 |
| POL-03 | Detail of another customer's policy ID | 404 identical to nonexistent | S | P0 |
| POL-04 | Policy of another tenant with same UUID guess | 404 | S | P0 |
| POL-05 | Family-segment policy ID requested through individual route | 404 | S | P0 |
| POL-06 | Corporate certificate ID | 404 | S | P0 |
| POL-07 | New staff-only field added to domain response | Does not appear (allow-list) | C | P0 |
| POL-08 | Timeline hides internal event types | Verified list | C | P0 |
| POL-09 | Policy in `Quoted`/`Pending` | Hidden or "being processed" per rule | I | P1 |
| POL-10 | Nominees display with percentage; minor nominee shows guardian | Correct | E | P1 |
| POL-11 | Sum assured/premium formatting in PKR, Urdu digits | Correct | E | P1 |
| POL-12 | Domain unavailable | Cached last-good view with "as of" banner; actions disabled | I/E | P0 |
| POL-13 | Documents list contains only documents of this policy | Verified | C/S | P0 |
| POL-14 | Download after handle expiry | 404/410 | S | P0 |
| POL-15 | Download handle used by another account | 404 | S | P0 |

### 13.5 PAY — Premium collection and payment sessions

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| PAY-01 | Pay due instalment, gateway succeeds | Intent → POSTED; receipt; schedule Paid; notification | E | P0 |
| PAY-02 | Browser tampers with amount | Ignored; server amount used | S | P0 |
| PAY-03 | Browser sends `realize=false` / `manual=true` | Not accepted (ignored/422) | S | P0 |
| PAY-04 | Gateway declines | `FAILED`; instalment untouched; retry allowed | I/E | P0 |
| PAY-05 | Gateway timeout then success webhook | `PENDING` → `POSTED` once | I | P0 |
| PAY-06 | Duplicate webhook ×3 | One posting | I | P0 |
| PAY-07 | Webhook arrives before browser returns | Same final state | I | P0 |
| PAY-08 | Webhook with bad signature | Rejected, logged | S | P0 |
| PAY-09 | Webhook replay with different amount | Rejected / flagged | S | P0 |
| PAY-10 | Double-click Pay | Same intent via idempotency key | E | P0 |
| PAY-11 | Two tabs pay same instalment | One intent proceeds, other sees `DUPLICATE_REQUEST` or shares intent | I | P0 |
| PAY-12 | Staff collects the same instalment while customer is at the gateway | Customer payment → `POST_FAILED` → `REFUND_REQUIRED`; alert | I | P0 |
| PAY-13 | Late-surcharge boundary crossed during the session (midnight) | Amount mismatch → customer sees `AMOUNT_CHANGED`, new quote; if paid anyway → refund path | I | P0 |
| PAY-14 | Payment for an instalment that is not the next payable | Domain refuses; clear message | C | P0 |
| PAY-15 | Payment on lapsed policy | Routed to reinstatement, not collect | C | P0 |
| PAY-16 | Payment on matured/surrendered policy | Refused | C | P1 |
| PAY-17 | Intent expires (30 min) then gateway success | If still payable same amount → post; else refund | I | P0 |
| PAY-18 | Domain down at POSTING | `POST_FAILED`; retry job posts when up; exactly once | I/N | P0 |
| PAY-19 | Receipt PDF download | Customer view (no commission) | C | P1 |
| PAY-20 | Autopay enabled with step-up | State saved; staff signal event | I | P1 |
| PAY-21 | Autopay enable without step-up | `STEP_UP_REQUIRED` | S | P0 |
| PAY-22 | Overpayment attempt / partial payment | Not supported in Stage 2: only exact amount | I | P1 |
| PAY-23 | Refund of failed posting | Status → `REFUNDED`; notification | I | P1 |
| PAY-24 | Reconciliation job finds orphan gateway success | Alert + intent created in `POST_FAILED` | I | P0 |
| PAY-25 | Pay while another account's intent id is guessed | 404 | S | P0 |
| PAY-26 | Velocity: 10 failed attempts/hour | Throttle + staff signal | S | P1 |
| PAY-27 | `return_url` open-redirect attempt | Allow-list only | S | P0 |

### 13.6 REN — Renewals

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| REN-01 | Renewal window not open | Shows next due only; no pay-renewal action | C | P0 |
| REN-02 | Window open, premium renewal pay | Case opened by system actor if needed; collect; confirmation | E | P0 |
| REN-03 | Contract renewal terms displayed | Shows exact terms & premium; accept requires step-up | E | P0 |
| REN-04 | Accept twice | Idempotent; one acceptance event | I | P0 |
| REN-05 | Terms changed after the customer opened the page | Acceptance rejects stale `terms_version` | I | P0 |
| REN-06 | Acceptance deadline passed | Refused; guidance | C | P1 |
| REN-07 | Non-renewable (e.g. fixed term ended) | Shows maturity path | C | P1 |
| REN-08 | Renewal blocked by claim/reinstatement | Displays reason | C | P1 |
| REN-09 | Sweep and customer open renewal simultaneously | One case (domain uniqueness) | I | P0 |
| REN-10 | Staff decides "Decline renewal" | Customer sees outcome and next steps; cannot pay | C | P1 |
| REN-11 | Renewal notice notification and tracker steps match staff steps | Parity test | E | P1 |
| REN-12 | Renewal premium differs from last year | Shows breakdown (customer-safe) | C | P1 |

### 13.7 RNS — Reinstatement

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| RNS-01 | Lapsed 40 days, eligible | Wizard starts; arrears shown | E | P0 |
| RNS-02 | Grace-period policy | Directed to pay, not reinstate | C | P0 |
| RNS-03 | Lapsed beyond window (24 m) | Blocked with reason | C | P0 |
| RNS-04 | Open claim or surrender | Blocked | C | P0 |
| RNS-05 | Declaration submitted clean (<90 d) | Straight-through route; customer sees "under review" | E | P0 |
| RNS-06 | Adverse answers | "More information needed" with required evidence list | E | P0 |
| RNS-07 | Declaration without step-up | Refused | S | P0 |
| RNS-08 | Evidence upload (valid/invalid type/oversize/infected) | Accept / `FILE_REJECTED` | E/S | P0 |
| RNS-09 | Revised terms offered; accept | Pay arrears becomes available | E | P0 |
| RNS-10 | Revised terms rejected | Case closes; policy remains lapsed | E | P1 |
| RNS-11 | Pay arrears before approval | Not offered | C | P0 |
| RNS-12 | Arrears amount changes (late fee) between view and pay | `AMOUNT_CHANGED` flow | I | P0 |
| RNS-13 | Withdraw before payment | Closed | E | P1 |
| RNS-14 | Withdraw after payment | Refused; staff handle | C | P1 |
| RNS-15 | Staff declines | Customer outcome letter, no scores | E | P1 |
| RNS-16 | Reinstated | Policy Active; next premium visible; notification | E | P0 |
| RNS-17 | Second request while one is open | Resumes existing | C | P0 |
| RNS-18 | Customer attempts to read another policy's case | 404 | S | P0 |
| RNS-19 | Parity: case numbers/steps in portal match staff panel | Verified | E | P1 |

### 13.8 SRV — Policy servicing

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| SRV-01 | Change email: step-up, verify new, apply | Domain updated; cooling-off starts; old+new notified | E | P0 |
| SRV-02 | Change phone | As above | E | P0 |
| SRV-03 | Change address | Applied (D-08) or request; events | E | P1 |
| SRV-04 | Nominee change request (shares total 100) | Request visible to staff; policy unchanged until approved | E | P0 |
| SRV-05 | Nominee shares ≠ 100 | Validation message | U/E | P0 |
| SRV-06 | Nominee is the policyholder / duplicate nominee | Refused | U | P1 |
| SRV-07 | Minor nominee without guardian details | Refused | U | P1 |
| SRV-08 | Sum-assured change quote preview | No side effects; shows premium delta | C | P1 |
| SRV-09 | Sum-assured increase request | Underwriting request created | E | P1 |
| SRV-10 | Rider add/remove request | Request visible; status tracked | E | P1 |
| SRV-11 | Request on lapsed policy | Refused with reason | C | P1 |
| SRV-12 | Staff rejects request | Customer sees safe reason | E | P1 |
| SRV-13 | Staff modifies the policy while a request is pending | Request marked `NEEDS_INFO`/stale on approval | I | P1 |
| SRV-14 | Withdraw request | Closed | E | P1 |
| SRV-15 | Same request submitted twice | Idempotent | I | P0 |
| SRV-16 | Sensitive change during cooling-off | `COOLING_OFF_ACTIVE` | I | P0 |
| SRV-17 | Contact change with stolen session (no OTP access) | Fails at step-up | S | P0 |
| SRV-18 | Endorsement letter download | Own policy only | S | P1 |

### 13.9 FLK — Free-look

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| FLK-01 | Inside window, cancel | Policy cancelled; refund to original payer; letter | E | P0 |
| FLK-02 | Window day-boundary (23:59 / 00:01 tenant TZ) | Domain rule respected | I | P0 |
| FLK-03 | After window | Not offered | C | P0 |
| FLK-04 | Cancel twice | Idempotent | I | P0 |
| FLK-05 | Cancel without step-up | Refused | S | P0 |
| FLK-06 | Free-look on policy with claim | Domain decides | C | P1 |
| FLK-07 | Refund to a different account requested | Impossible via API | S | P0 |

### 13.10 CLM — Claims

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| CLM-01 | Intimate a hospitalisation/accident claim | Claim created, Portal channel, reference + checklist | E | P0 |
| CLM-02 | Benefit not covered by policy | Option not offered; API 422 | C | P0 |
| CLM-03 | Policy lapsed / not in force | Domain verdict shown | C | P0 |
| CLM-04 | Duplicate intimation (same event/date) | Domain flags; customer sees "already registered, ref …" | I | P0 |
| CLM-05 | Idempotent retry of intimation | Single claim | I | P0 |
| CLM-06 | Upload each checklist doc | Status updates; staff sees them | E | P0 |
| CLM-07 | Upload wrong type/oversized/infected | Rejected | S | P0 |
| CLM-08 | Staff returns a document | Customer asked to re-upload | E | P1 |
| CLM-09 | Claim status mirrors staff steps | Parity | E | P1 |
| CLM-10 | Claim outcome letter (approved/rejected/partial) | Customer-safe; no internal notes | C | P0 |
| CLM-11 | Submit payout details | Pending until staff verify; cooling-off if new | E | P0 |
| CLM-12 | IBAN invalid / account-title mismatch | Validation / staff mismatch handling | U/I | P0 |
| CLM-13 | Read another customer's claim | 404 | S | P0 |
| CLM-14 | Claim after policy matured or surrendered | Domain verdict | C | P1 |
| CLM-15 | Claim in contestability period | Processed normally; staff flagged only | I | P1 |
| CLM-16 | Customer tries to see fraud/investigation | Not in API | S | P0 |
| CLM-17 | Claim reopened by staff | Customer notified | E | P2 |
| CLM-18 | Death claim | Not available in portal (D-12); message shows how | M | P1 |
| CLM-19 | System actor used for `open_claim` | Timeline shows "Customer (Portal)" | I | P0 |

### 13.11 EXT — Maturity and exit

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| EXT-01 | Approaching maturity (e.g. 90 days) | Banner, indicative value, what to expect | E | P0 |
| EXT-02 | Matured policy | Maturity case visible; payee submission | E | P0 |
| EXT-03 | Surrender request | Case opened; staff run eligibility | E | P0 |
| EXT-04 | Surrender not allowed (e.g. before minimum term) | Reason shown | C | P0 |
| EXT-05 | Consent with step-up | Recorded `method=Portal` | E | P0 |
| EXT-06 | Settlement figure displayed; accept | Locked in; payee step | E | P0 |
| EXT-07 | Figure expires before acceptance | Re-calculation by staff | I | P1 |
| EXT-08 | Decline figure | Case closed/withdrawn | E | P1 |
| EXT-09 | Policy has loan/assignment | Deduction shown in statement | C | P1 |
| EXT-10 | Payee differs from policyholder | Not allowed | U | P0 |
| EXT-11 | Withdraw before payment / after payment | Allowed / refused | C | P0 |
| EXT-12 | Payment returned by bank | Customer asked for new details | E | P1 |
| EXT-13 | Exit confirmation letter | Own policy | S | P1 |
| EXT-14 | Parallel exit + claim | Domain mutual exclusion shown clearly | C | P1 |
| EXT-15 | Surrender request submitted twice | One case | I | P0 |

### 13.12 DOC — Documents

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| DOC-01 | Welcome kit / policy schedule / receipt / endorsement / letters download | Streamed; access logged | E | P0 |
| DOC-02 | Direct hit on the old unauthenticated document URL by customer | Not reachable from portal; internal network only | S | P0 |
| DOC-03 | Content-Type and `Content-Disposition` correct; `nosniff` | Verified | S | P1 |
| DOC-04 | Large file stream (15 MB) over slow link | No memory blow-up | N | P1 |
| DOC-05 | Missing file on disk | Friendly error, alert | I | P1 |
| DOC-06 | Urdu UI with English PDF | Labelled | M | P1 |
| DOC-07 | Path traversal in handle | Rejected | S | P0 |

### 13.13 NTF — Notifications

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| NTF-01 | Each mapped lifecycle event creates one notification | Dedupe on `source_event_id` | I | P0 |
| NTF-02 | Kafka redelivery | No duplicates | I | P0 |
| NTF-03 | Event for unknown customer/account | Ignored; counted | I | P1 |
| NTF-04 | Preferences cannot turn off security/legal | Enforced | I | P0 |
| NTF-05 | Language of notification follows viewer | Verified | E | P1 |
| NTF-06 | Email send failure | Retry with backoff; inbox still shows | I | P1 |
| NTF-07 | Unread count / mark all read | Correct | E | P2 |
| NTF-08 | Notification deep link to another account's policy | 404 | S | P0 |
| NTF-09 | Password never present in any notification | Scan | S | P0 |

### 13.14 ISO — Isolation, authorization, cross-tenant

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| ISO-01 | Enumerate policy UUIDs of other customers (same tenant) | Always 404 | S | P0 |
| ISO-02 | Same, other tenant | 404 | S | P0 |
| ISO-03 | Change `tenant_id`/`customer_id` in request body/query/header | Ignored | S | P0 |
| ISO-04 | Mass-assignment (extra JSON fields) | Ignored | S | P0 |
| ISO-05 | SQL/NoSQL injection in IDs, search, filenames | Safe | S | P0 |
| ISO-06 | RLS bypass attempt (missing `cp.tenant_id`) | Query returns nothing / errors | I/S | P0 |
| ISO-07 | Portal calls adapter with wrong key / missing caller header / stale timestamp / replay | 401 | S | P0 |
| ISO-08 | Staff user tries `/internal/customer-portal/*` via gateway | Not routed | S | P0 |
| ISO-09 | Customer tries staff routes via portal origin | 404 | S | P0 |
| ISO-10 | Staff app regression suite after changes | Unchanged results | E | P0 |
| ISO-11 | Adapter 404s for objects not belonging to the policy (claim of another policy) | 404 | C | P0 |
| ISO-12 | Timing difference between "not yours" and "not found" | Within noise | S | P1 |
| ISO-13 | Error messages leak stack/SQL | None | S | P0 |
| ISO-14 | Corporate/family customer logs in (future accounts) | Cannot see individual-only data of others | S | P1 |
| ISO-15 | Deleted tenant / deactivated tenant | Login refused; sessions invalid | I | P1 |

### 13.15 SEP — Staff vs customer separation

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| SEP-01 | Customer account and staff user share the same email | Independent credentials; no cross-auth | S | P0 |
| SEP-02 | Staff secret rotated | Portal unaffected | I | P1 |
| SEP-03 | Portal secret rotated | Staff unaffected; customers re-login | I | P1 |
| SEP-04 | Customer cookie sent to staff domain / vice versa | Not accepted | S | P0 |
| SEP-05 | Staff SSO cookie accepted by portal | Never | S | P0 |
| SEP-06 | Impersonation endpoint absent | 404 | S | P0 |
| SEP-07 | Staff can suspend/reset but not read credentials | Verified | I | P0 |
| SEP-08 | Portal action appears on staff timeline as customer actor | Verified | E | P0 |

### 13.16 FRD — Fraud and abuse

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| FRD-01 | Takeover: login from new device → contact change → payout change | Step-up + cooling-off + alerts; payout held | E/S | P0 |
| FRD-02 | Credential stuffing (1000 usernames) | Throttle, alert | N/S | P0 |
| FRD-03 | OTP SMS pumping | Per-account/IP/day caps | S | P0 |
| FRD-04 | Account enumeration via reset/login | Not possible | S | P0 |
| FRD-05 | Card testing through payment sessions | Velocity block | S | P1 |
| FRD-06 | Fake claim documents (malware, polyglot) | Rejected | S | P0 |
| FRD-07 | Repeated claim intimation spam | Rate limit + duplicate handling | S | P1 |
| FRD-08 | Staff provisions/resets without reason | Refused | I | P0 |
| FRD-09 | Sequential-ID guessing on receipts/letters | Opaque handles | S | P0 |
| FRD-10 | Session fixation / cookie theft replay from a different UA/IP profile | Step-up / revoke | S | P1 |
| FRD-11 | Replay of a signed internal request | Rejected (nonce/timestamp) | S | P0 |
| FRD-12 | Open redirect via `return_url`/`next` | Allow-list | S | P0 |
| FRD-13 | XSS via nominee name, address, filenames, claim description | Escaped; CSP blocks | S | P0 |
| FRD-14 | Clickjacking | `frame-ancestors none` | S | P1 |

### 13.17 MIG — Credential migration

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| MIG-01 | Report mode lists accounts by state, duplicates, missing hashes | Counts reconcile to `customer_portal_accounts` | I | P0 |
| MIG-02 | Import legacy account with bcrypt hash | User logs in with the same temp password; forced change | I/E | P0 |
| MIG-03 | Re-run import | Idempotent | I | P0 |
| MIG-04 | Legacy row with `Active` status, `must_reset=false` | Imported ACTIVE only if the hash is a real user-set one; otherwise PROVISIONED (decision documented) | I | P0 |
| MIG-05 | Duplicate usernames within a tenant | Resolved with suffix; mapping report | I | P0 |
| MIG-06 | Legacy invite expired | `CREDENTIAL_EXPIRED` | I | P0 |
| MIG-07 | Dual-write: provision in tenant-service writes both | Equal | I | P0 |
| MIG-08 | Portal down during provisioning | Provision fails loudly (no half state) / queue in dual mode | I | P0 |
| MIG-09 | Flip to `portal` mode | Legacy table frozen; onboarding gate uses portal | I | P0 |
| MIG-10 | Rollback to `legacy` | Hash export restores; no lost password changes (export used) | I | P1 |
| MIG-11 | Reconciliation job | Detects drift between systems | I | P1 |
| MIG-12 | Existing e2e (post-issuance) passes in all three modes | Green | E | P0 |

### 13.18 RES — Resilience and recovery

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| RES-01 | tenant-service down | Portal readable from cache with banner; actions disabled | I/N | P0 |
| RES-02 | Portal DB down | `readyz` fails; 503 envelope; no partial writes | N | P0 |
| RES-03 | Kafka down | Outbox accumulates; drained later | I | P0 |
| RES-04 | Gateway/payment provider down | Pay disabled with message; no intents stuck | I | P0 |
| RES-05 | Restart mid-payment POSTING | Recovered by retry job | I | P0 |
| RES-06 | Poison event on consumer | Dead-letter + continue | I | P1 |
| RES-07 | Backup/restore drill | Sessions invalid, accounts intact | M | P1 |
| RES-08 | Migration applied twice concurrently | Advisory lock | I | P0 |
| RES-09 | Checksummed migration modified | Startup stops | I | P0 |
| RES-10 | Clock jump | Tokens/OTP behave | I | P2 |
| RES-11 | Partial deploy (old BFF, new service) | Compatible (versioned `/v1`) | I | P1 |

### 13.19 UIX — Frontend and accessibility

| ID | Scenario | Expected | Layer | Pri |
|---|---|---|---|---|
| UIX-01 | All screens in English/Urdu; RTL layout | No clipped/mirrored errors | M/E | P0 |
| UIX-02 | Missing Urdu key | Build fails | U | P0 |
| UIX-03 | 360 px phone / tablet / desktop | Usable | E | P0 |
| UIX-04 | Keyboard-only run of login, pay, claim | Completes | M | P1 |
| UIX-05 | Screen reader on forms and status changes | Announces | M | P1 |
| UIX-06 | Slow 3G | Skeletons, retries, no duplicate submits | E | P1 |
| UIX-07 | Browser back after payment/logout | No stale sensitive data | E | P1 |
| UIX-08 | Session expiry mid-wizard | Draft preserved | E | P1 |
| UIX-09 | Golden-file allow-list test per endpoint | Fails on new field | C | P0 |
| UIX-10 | Visual parity with enterprise tokens | Reviewed | M | P2 |

### 13.20 NFR — Non-functional

| ID | Target | Layer | Pri |
|---|---|---|---|
| NFR-01 | p95 login < 800 ms (bcrypt included); p95 read APIs < 400 ms with warm cache | N | P1 |
| NFR-02 | 500 concurrent sessions, 50 req/s mixed, error rate < 0.5% | N | P1 |
| NFR-03 | Payment webhook burst 100/s idempotent | N | P1 |
| NFR-04 | Availability 99.5% in pilot; RPO ≤ 15 min, RTO ≤ 2 h (**targets to be confirmed by the business**) | M | P1 |
| NFR-05 | Dependency scan, SAST, container scan clean of high/critical | S | P1 |
| NFR-06 | Penetration test before go-live (external) | S | P0 (go-live) |
| NFR-07 | Log review: no PII/tokens | S | P0 |
| NFR-08 | Audit completeness: every R2/R3 action has an audit row | I | P0 |

**Count:** 282 scenarios across 20 groups.

### 13.21 Test strategy

* **Unit**: password policy, throttling math, state machine, projections, OTP, idempotency, payment intent transitions (pure logic, same style as `test_reinstatement_engine.py`).
* **Integration**: service + real Postgres (separate schema) with fake domain and fake gateway; migration runner tests.
* **Contract**: a recorded OpenAPI contract for the adapter; portal tests run against a stubbed adapter, tenant-service tests run against recorded portal calls; golden-file projections.
* **E2E**: Playwright against compose, seeded with 2 tenants × 3 customers × mixed policies; scripted flows reuse the existing `scripts/` e2e seeds (post-issuance, renewals, reinstatement, claims, exit).
* **Security**: automated IDOR matrix generated from the route table (every route × every foreign object type); fuzzing on auth; external pentest.
* **Regression guard**: the entire existing staff e2e suite runs on each portal PR (Requirement 7).
* **Exit criteria per stage**: all P0 of the stage green, no open high/critical security finding, staff e2e unchanged.

---

## 14. Deployment and integration strategy

### 14.1 Compose entries (to be added in Stage 1, **not** now)

| Service | Image/context | Ports (container → host) | Depends on | Notes |
|---|---|---|---|---|
| `customer-portal-provision` | `services/customer-portal-service` (`python provision.py`) | — (one-shot) | host Postgres | Creates schema + `customer_portal_owner/app/purge` roles; idempotent; same pattern as `customer-service-provision` |
| `customer-portal-service` | `services/customer-portal-service` | 8009 → **8019** (dev only) | provision (completed), kafka | Runs migrations as owner when `CP_RUN_MIGRATIONS=true`; connects as `customer_portal_app`; `healthz` / `readyz` |
| `customer-portal-app` | `customer-portal-app/` | 3009 → 3009 | customer-portal-service | Next.js standalone; **no** mounts of `frontend/` (unlike the staff satellites) |
| `customer-portal-worker` *(Stage 2)* | same image as service, `python worker.py` | — | kafka, DB | Kafka consumer (lifecycle events), outbox relay, payment reconciliation, retention purge |

Verified free ports at time of writing: **3009**, **8019** (§2). In non-dev profiles the service has **no host port**; only the app is exposed (through the TLS terminator).

### 14.2 Environment variables (catalogue)

| Variable | Used by | Purpose |
|---|---|---|
| `CP_DATABASE_URL` | service/worker | `postgresql+asyncpg://customer_portal_app:…@host/…` |
| `CP_DB_OWNER_PASSWORD`, `CP_DB_APP_PASSWORD`, `CP_DB_PURGE_PASSWORD` | provision, service | Role secrets |
| `CP_RUN_MIGRATIONS` | service | `true` in dev, `false` on app instances in prod |
| `CP_JWT_SECRET` / `CP_JWT_PRIVATE_KEY`+`CP_JWT_PUBLIC_KEYS` | service | **Must differ** from `JWT_SECRET_KEY`; asymmetric preferred (§12.5) |
| `CP_ACCESS_TTL_MIN`, `CP_REFRESH_IDLE_MIN`, `CP_REFRESH_ABS_HOURS` | service | 15 / 30 / 12 |
| `CP_CREDENTIAL_VALID_DAYS` | service | Temp-password validity (default = legacy 7) |
| `CP_TO_TENANT_KEY`, `TENANT_TO_CP_KEY` | service / tenant-service | HMAC keys, one per direction |
| `CP_TENANT_SERVICE_URL` | service | `http://tenant-service:8000` (internal) |
| `CP_KAFKA_BOOTSTRAP`, `CP_KAFKA_GROUP` | worker | Consumer + producer |
| `CP_EMAIL_PROVIDER`, `CP_SES_*` | service/worker | Reuse the platform SES settings |
| `CP_SMS_DRIVER` | service | `simulated` / provider name |
| `CP_PAYMENT_DRIVER` | service | `mock` / provider name; `CP_PAYMENT_WEBHOOK_SECRET` |
| `CP_ALLOWED_RETURN_ORIGINS` | service | Payment `return_url` allow-list |
| `CP_FIELD_ENCRYPTION_KEY` | service | Contact-value encryption |
| `CP_ENV`, `CP_LOG_LEVEL` | all | |
| `PORTAL_PROVISIONING_MODE` | tenant-service | `legacy` / `dual` / `portal` (§6.6) |
| `PORTAL_API_BASE`, `NEXT_PUBLIC_*` (none secret) | app | BFF → service URL |
| `CP_ALLOWED_HOSTS` / tenant domain map | app/service | Host → tenant code resolution |

Secrets live in the secret manager / compose secrets in non-dev; `.env` is dev-only. **No secret is ever echoed by the blueprint** (the dev `.env` was only checked for presence).

### 14.3 Tenant resolution

Order: (1) custom domain/subdomain mapped in `tenant_cache.domains` (e.g. `adamjee.portal.example`), (2) explicit `tenant_code` field on the login form for the shared host, (3) never from a header the browser can set. Username is unique **per tenant**, so a username alone is never enough. Unknown tenant returns the same neutral login failure.

### 14.4 Network and exposure

```
Internet ──TLS──▶ customer-portal-app (3009)  ──internal──▶ customer-portal-service (8009)
                                                               │  ├──HMAC──▶ tenant-service (/internal/customer-portal/v1)
                                                               │  ├──Kafka──▶ insurance.customer-portal.events.v1
                                                               │  └──SQL───▶ Postgres schema customer_portal
Staff browser ─▶ frontend/api-gateway/tenant-service   (unchanged; no customer routes added)
```

* The service is reachable only from the app container, `tenant-service` (for the internal provisioning calls) and the worker.
* `tenant-service` accepts `/internal/customer-portal/*` only with a valid portal-signed request and a network policy allowing `customer-portal-service`; the gateway has no route for it.

### 14.5 Kafka

* New topic `insurance.customer-portal.events.v1` (registered in `shared/events/kafka_events.py` as an additive constant).
* Consumer group `customer-portal-worker` on `insurance.policy.lifecycle.v1`; at-least-once with `consumed_events` dedupe; DLQ topic `…dlq.v1`.
* Producer via transactional outbox (identical to Request Management).

### 14.6 Rollout and rollback

| Step | Action | Rollback |
|---|---|---|
| 1 | Merge docs + P-14/P-04 groundwork (no behaviour change) | revert |
| 2 | Deploy `customer-portal-*` **dark** (no links, no traffic); run migrations; `readyz` green | stop containers; drop schema is safe (no other consumer) |
| 3 | M0 report; M1 import (legacy mode still authoritative) | truncate imported rows (idempotent re-import) |
| 4 | Pilot tenant, internal staff accounts as customers (E2E smoke) | disable flag |
| 5 | `PORTAL_PROVISIONING_MODE=dual` | back to `legacy` |
| 6 | Enable P-01 hardening on staging, run the full staff e2e | per-router flag `AUTH_ENFORCE_<router>` |
| 7 | `portal` mode; invite pilot customers in batches | revert to `dual`; M3 export available |
| 8 | General availability after pen-test and NFR sign-off | feature-flag by tenant |

Feature flags are per tenant (`tenant_cache.display.flags`): `portal_enabled`, `payments_enabled`, `claims_enabled`, `exit_enabled`, `reinstatement_enabled`, so each Stage can ship dark and be turned on tenant by tenant.

### 14.7 Observability

* Structured JSON logs with `request_id`, `correlation_id`, `account_id`, `tenant_id`; PII filter.
* Metrics: login success/failure by reason, lock rate, refresh reuse, OTP sent/verified, payment intent state counts and age of non-terminal intents, adapter latency/error by route, outbox lag, consumer lag, notification delivery failures.
* Alerts: `REFUND_REQUIRED` > 0, intents stuck > 15 min, reuse-detected spike, login failure spike, adapter 5xx, outbox lag > 5 min, reconciliation drift.
* Audit queries for compliance: "everything this customer did", "everything done on this policy via portal".
* Staff view: a read-only **Portal activity** tab on the staff policy page (Stage 2+) reading `PolicyEvent`s and the account state summary; no credential data.

### 14.8 Local development

* `docker compose up customer-portal-provision customer-portal-service customer-portal-app` (+ tenant-service, kafka).
* Seed script creates two tenants and several customers with every policy state; `CP_PAYMENT_DRIVER=mock` supports force-success/fail/delay buttons; `CP_SMS_DRIVER=simulated` prints OTPs to the service log **in dev only**.
* The frontend dev server runs **inside Docker**, never from the host (existing project rule; `.next` is root-owned).

---

## 15. Implementation roadmap (each stage ships dark, behind flags)

| Stage | Scope | Key deliverables | Exit criteria |
|---|---|---|---|
| **0 (this)** | Architecture and blueprint | This document | Reviewed; decisions D-01…D-13 answered; **no code** |
| **1 Foundation + credentials + read-only** | Service skeleton, schema, auth (login, first-change, refresh, logout, forgot/reset), throttling, security events, account state machine; `PUT /internal/v1/accounts`; M0–M2 (report, import, dual-write); adapter v1 (policies, detail, timeline, documents); app shell, i18n, login/first-login/home/policies/policy detail/account/help; P-04, P-05, P-06, P-07, P-12, P-14, P-15 | A real customer logs in with the provisioned credentials, changes the password, sees all their individual policies in en/ur | ACT, SES, MUL, POL, ISO, SEP, MIG (P0) green; staff e2e unchanged |
| **1b Hardening** | **P-01 router authentication**, P-02, B-05 CORS; inventory of non-browser callers | Staff routes require staff JWT or signed internal call | Full staff e2e green with enforcement; pen-test of internal surface |
| **2 Money + notifications** | Payment sessions, webhook, reconciliation worker, receipts; renewals (view/pay/accept); notifications inbox/email; P-10 | Pay a premium and a renewal from the portal | PAY, REN, NTF (P0) green; payment provider chosen (D-10) |
| **3 Servicing + reinstatement + free-look** | Contact/address/nominee/sum-assured/rider requests; Request-Management extension (D-08); reinstatement wizard; free-look; cooling-off | Full policy servicing | SRV, RNS, FLK, FRD (P0) green |
| **4 Claims** | Intimation (P-08/P-09), documents, tracker, payout details | Non-death claims end to end | CLM green; AV scanning live (B-09) |
| **5 Maturity & exit** | Maturity info, surrender request, consent, figure acceptance, payee | Exit end to end | EXT green |
| **6 Go-live** | Pen-test, NFR, UAT, runbooks, data-protection sign-off, support training, pilot → GA | Production | NFR-04…07, all P0/P1 |

**Family and Corporate later (design notes, nothing built):** the account model already has `account_kind` and the workspace concept; Family adds `account_subject_links` (head/spouse → family policy; nominee view-only), Corporate adds `CORPORATE_ADMIN` and `CORPORATE_EMPLOYEE` kinds with a different ownership gate (`master_policy_id`, certificate list, HR roles). Each is a new **workspace module + a new adapter namespace** (`/internal/customer-portal/v1/.../family`, `.../corporate`) and a new app section; the auth, session, notification, payment and audit foundations are reused. The existing Family nominee model (only head + optional spouse insured; others nominees) and Group Life state decide those workspaces; they are **not** pre-built now.

---

## 16. Risks, blockers and open decisions

### 16.1 Blockers (must be resolved before real customers use the portal)

| ID | Blocker | Impact | Resolution | Owner (suggested) |
|---|---|---|---|---|
| **B-01** | ~53+ tenant-service routes (`post_issuance`, `pre_issuance`, parts of `renewals`/`reinstatement`/`branches`/`roles`/`tenants`/`demo`/`tokens`/`llm_config`) have **no auth**, are proxied by the gateway and published on host 8011; includes payment collection and document download | Anyone on the network can act on any customer; defeats Requirement 8 | P-01 + P-02 (Stage 1b) | Platform/security |
| **B-02** | No verified phone/SMS provider for OTP; email via SES is configured but deliverability, sender domain and SPF/DKIM are unverified | R3 step-up and password recovery cannot be production-grade | Choose SMS/WhatsApp provider; verify SES domain; D-14 | Business + infra |
| **B-03** | Payment gateway is a mock; `realize` flag is client-controlled on the staff route | Fake payments possible if exposed | P-10 server-side posting only; real PSP integration (D-10) | Business + payments |
| **B-04** | `PH-{year}-{count+1}` per-tenant counter, racy and not unique | Usernames/identifiers collide | P-04 allocator + unique index | Backend |
| **B-05** | Gateway and tenant-service CORS `allow_origin_regex=https?://.*` with credentials | Cross-site abuse of staff API | Tighten to explicit origins (Stage 1b) | Platform |
| **B-06** | No login throttling anywhere (`failed_login_count` unused) | Credential stuffing | Portal implements §5.5 itself; staff login fix recommended separately | Backend |
| **B-07** | Non-browser callers of unauthenticated tenant-service routes are **not inventoried** (chat-agent, scripts, request-management, satellites) **(unverified)** | Enabling P-01 could break them | Inventory before enforcement | Backend |
| **B-08** | Staff endorsements apply **immediately**; there is no approval workflow for customer-initiated changes | Unsafe to expose nominee/sum-assured changes as direct commands | D-08: use Request Management or portal `service_requests` + staff apply | Product |
| **B-09** | No malware scanning on uploads | Infected files reaching staff | AV hook (ClamAV or managed) before Stage 3/4 | Infra |

### 16.2 Risks

| ID | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R-01 | Two sources of truth for credentials during migration | M / H | Phases M0–M4, reconciliation job, single flag, hash export for rollback |
| R-02 | Customer-view projection drifts (new domain field leaks) | M / H | Allow-lists + golden-file contract tests |
| R-03 | In-process delegation couples portal adapter to domain internals | M / M | Adapter module is the only coupling; extraction items P-08…P-11 are small and covered by existing e2e |
| R-04 | Payment edge cases (refund, async rails) underestimated | H / H | Intent state machine, reconciliation, mock driver with failure injection, provider chosen early |
| R-05 | Shared secret HS256 spreads to many services | M / M | Asymmetric keys + `kid`; portal keys separate from staff |
| R-06 | Staff process change (no password re-reveal) confuses ops | M / L | UI copy, reset flow, training |
| R-07 | Urdu translation quality/consistency | M / M | Glossary, review by native speaker, build gate for missing keys |
| R-08 | Performance of live policy lookups per request | M / M | Cache with short TTL, aggregate `home` endpoint, indexes |
| R-09 | Existing demo/test scripts rely on unauthenticated routes | H / M | Scripts use a service credential once P-01 lands |
| R-10 | Scope creep into Family/Corporate | M / M | Account model is ready; workspaces are separate stages |
| R-11 | PDF generator may not render Urdu | M / L | Documents labelled English; font work optional |
| R-12 | Customer harm from social engineering via staff reset | L / H | Reason required, customer notified, reset invalidates sessions, audit |
| R-13 | Regulatory uncertainty (data protection, e-signature validity of declarations) | M / H | D-13 legal review before Stage 3 e-sign |
| R-14 | Policyholder expectations on SLA and availability | M / M | Pilot targets in NFR-04 to be confirmed |

### 16.3 Decision register

| ID | Decision | Status | Recommendation |
|---|---|---|---|
| D-01 | Service/app naming (`customer-portal-*`, schema `customer_portal`) | Proposed | Accept — avoids collision with staff `customer-service` |
| D-02 | BFF with httpOnly cookies, no browser tokens | Proposed | Accept |
| D-03 | Temp password + forced change; drop `invite_token` | Proposed | Accept (matches requirement); activation link later |
| D-04 | New HMAC internal adapter router in tenant-service; no gateway route | Proposed | Accept |
| D-05 | Token signing: HS256 now, asymmetric with `kid` before go-live | Proposed | Accept |
| D-06 | Account keyed `(tenant_id, customer_id)`; workspaces concept for Family/Corporate | Proposed | Accept |
| D-07 | System actor identity for portal-initiated cases (`customer:<account_id>`) | Proposed | Accept; requires P-08/P-11 |
| D-08 | Customer-initiated changes: direct (contact, address) vs request (nominee, sum assured, riders, payee, surrender) — implemented via Request Management extension or portal `service_requests` | **Open** | Prefer extending Request Management (already has outbox, SLA, events); needs confirmation |
| D-09 | No staff impersonation | Proposed | Accept |
| D-10 | Payment provider/rails (card, Raast, wallets, bank transfer) | **Open** | Business to choose; mock until then |
| D-11 | Support channel integration with `customer-service` ticket desk | Open | Later; Stage 1 = contact card + callback |
| D-12 | Death claims by nominees (guest/claimant access) | Open | Out of scope until legal review |
| D-13 | Data-protection and e-signature requirements | **Open** | Compliance input before Stage 3 |
| D-14 | OTP channel(s) and provider; fallback when no verified channel | **Open** | Email now; SMS provider required for go-live |
| D-15 | Login identifier: username + tenant code vs CNIC/policy-number-based | Open | Keep generated username + tenant (matches existing credentials); add "login with policyholder ID" later if wanted |
| D-16 | Where online surrender/claim initiation is allowed at all (policy/product-level switches) | Open | Product flags per tenant (§14.6); default off |
| D-17 | Credential delivery: staff-shown one-time password vs automatic email/SMS of password | Open | Keep staff-shown; add a secure delivery (SMS to verified phone) once B-02 resolved; never email the password plain-text in new flows |

### 16.4 What this stage did **not** verify

* Anything outside what was read (listed in Appendix A); in particular the runtime behaviour of the chat agent's tenant-service calls, the production hosting model, SES deliverability, and legal/regulatory requirements.
* No code was run, no DB was queried, no service started during Stage 0 (read-only exploration).

---

## 17. Appendices

### A. Evidence index (files read in Stage 0)

| Area | Files |
|---|---|
| Provisioning & credentials | `services/tenant-service/services/portal_service.py`; `shared/models/core.py` (`CustomerPortalAccount`, `Customer`, `PolicyEvent`); `routers/post_issuance.py` (`provision_portal`, `send_welcome`, `reset_onboarding`, `_next_policyholder_id`, `CollectBody`); `services/onboarding_gate.py` |
| Staff auth | `routers/auth.py`; `shared/security/service_auth.py`; `routers/request_management_internal.py` |
| Gateway/edge | `services/api-gateway/main.py`; `docker-compose.yml` |
| Isolation pattern | `services/customer-service/{provision.py,migrate.py,main.py,README.md}`; `services/request-management-service/README.md` |
| Policies & domain | `routers/policies.py`, `routers/pre_issuance.py`, `routers/renewals.py`, `routers/reinstatement.py`, `services/payment_gateway.py`, `shared/events/kafka_events.py`, engines and tests of Stage B modules |
| Frontend | `frontend/app/layout.tsx`, `ClientLayout.tsx`, `lib/i18n/*`, `lib/satellite/middleware.ts`, `components/{Sidebar,TopBar,NotificationContext}.tsx`, `components/policy/*Panel.tsx` |
| Config presence | `.env` (variable presence only; no values recorded) |

### B. Proposed repository layout (Stage 1)

```
services/customer-portal-service/
  main.py                 # FastAPI app, lifespan, health
  config.py  deps.py  errors.py  logging.py
  provision.py            # roles + schema (one-shot)
  migrate.py  migrations/0001_*.sql …
  models/                 # SQLModel tables (schema customer_portal only)
  routers/
    auth.py  me.py  home.py  policies.py  payments.py  renewal.py
    reinstatement.py  servicing.py  claims.py  exit.py  notifications.py  help.py
    internal_accounts.py  webhooks.py
  services/
    tokens.py  passwords.py  throttle.py  otp.py  step_up.py  sessions.py
    domain_client.py      # signed calls to tenant-service adapter
    payments/ (driver_mock.py, driver_<psp>.py, intents.py, reconcile.py)
    notifications/ (email.py, sms.py, templates/)
    outbox.py  idempotency.py  audit.py
  worker.py               # Kafka consumers, outbox relay, jobs
  tests/
customer-portal-app/
  app/ (routes per §10.4)  app/api/portal/*  middleware.ts
  components/  lib/(bff.ts, i18n)  messages/{en,ur}.json
services/tenant-service/routers/customer_portal_internal.py   # adapter (P-03)
services/tenant-service/services/customer_portal_views.py     # projections (P-12)
```

### C. Customer-facing wording rules

Plain English/Urdu, no internal jargon (`PolicyEvent`, "UW", "loading"), amounts always PKR with explicit "due by", every error says what to do next. Security notices never include credentials. Legal texts (declarations, consent, settlement acceptance) are versioned; the version hash is stored with the acceptance.

### D. Glossary

| Term | Meaning |
|---|---|
| Account | Portal login identity for one customer in one tenant |
| Workspace | Group of capabilities by customer type (Individual now; Family, Corporate later) |
| Adapter | Internal tenant-service router returning customer-safe views and applying customer actions through existing domain functions |
| BFF | Backend-for-frontend: the Next.js server routes that hold tokens in cookies |
| Step-up | Fresh OTP confirmation for a sensitive action |
| Cooling-off | 72 h hold on payouts/sensitive changes after contact or payee change |
| Intent | Portal-side record of one payment attempt |
| Stage B | The earlier post-issuance journey (free-look → exit) already merged |

### E. Decision log

See §16.3. Decisions are recorded here when answered; **nothing in this document has been implemented**.

---

*End of Stage 0 blueprint. Awaiting the next implementation instruction.*
