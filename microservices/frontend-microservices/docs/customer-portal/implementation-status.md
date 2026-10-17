# Individual Customer Portal — implementation status

Companion to `individual-portal-blueprint.md` (Stage 0). Stages 1–9 of the accelerated MVP are built; this file records where
the build **deliberately differs** from the blueprint and what is still open.

## Differences from the blueprint

| Blueprint | Built | Why |
|---|---|---|
| `customer-portal-service` / schema `customer_portal` / `CP_*` | `services/customer-management` / schema `customer_management` / `CM_*` | names fixed by the sprint brief |
| Customer traffic never through the staff gateway | The portal's BFF calls Customer Management **through the gateway's versioned route** `/customer-management/v1/*` (only `v1/` is proxied; `/internal/*` never) | brief: "connect it to the existing API Gateway using versioned routes". Customer tokens are only ever valid for this service. |
| `customer-portal-app` | `customer-portal/` | brief |
| OTP step-up, SMS, password reset by OTP | Not built. Recovery = ops re-issue through the existing "Reset password" step; contact changes need the current password | no verified SMS/email OTP channel yet (blocker B-02) |
| Payment sessions + webhooks + reconciliation | Single synchronous **simulated** payment through the existing mock gateway, idempotent, amount re-checked | the gateway is a mock (B-03); no new PSP |
| Kafka consumer / outbox / notification store | Notifications derived from live data; only read marks stored | brief: reliable API-backed list first |
| Service requests (nominee, sum-assured, payee…), reinstatement, renewal, surrender | Out of scope for the MVP (shown as "contact your insurer") | needs the approval path decision D-08 |
| P-01 authentication of the unauthenticated tenant-service routes | **Not done** — see below | separate hardening change touching every staff caller |

## Still open before production

1. **B-01** — ~53 tenant-service routes (post-issuance, pre-issuance …) have no authentication and are reachable through the gateway and on host port 8011. The portal cannot guarantee isolation against anyone who can reach those routes directly. Authenticate them (staff JWT or signed internal call) after inventorying non-browser callers.
2. Real payment provider; OTP/SMS provider; malware scanning of uploads; external penetration test; data-protection review.
3. Death claims by nominees (claimant verification) — deliberately not in the portal.
4. Operational: secrets in a secret manager, TLS (`PORTAL_COOKIE_SECURE=true`), per-tenant domain/tenant resolution, backups, alerting.


---

# Family insurance extension

Extends the SAME service and app (no new service, no second set of credentials). A family head signs in with the credentials
already issued by post-issuance and sees their individual policies exactly as before, plus a **My Family** section.

## Access model (tenant-service decides; the browser's family/member ids are only requests)

| Level | Who | Can |
|---|---|---|
| `owner` | policyholder of the policy; the head of a Family Floater | everything on it: premiums, claims, documents, beneficiaries, servicing requests |
| `guardian` | the family head, for a certificate whose insured life is a **minor** | the same, on the child's behalf |
| `summary` | the head looking at another **adult's** life-bundle certificate; an insured spouse looking at the floater | status, cover, premium position, dates — **no** claims, documents, beneficiaries, receipts, payments or actions |
| none | anyone else (other family, other tenant, a member's sibling certificate) | plain 404 |

* Claims are confidential to the life they concern: on a family policy the caller sees a claim only if they filed it in the portal, it is about them, or it is about a minor they look after. A spouse's claim registered by the insurer's staff is **not** visible to the head.
* A claim can only be made for a person who is **actually insured** (from the policy's cases / certificate holder, never from the family roster); another adult must have consented. Death claims stay out of the portal (claimant verification).
* Insured people ≠ nominees ≠ policyholder: nominees are `Beneficiary` rows with no cover; a spouse can be both and counts once.
* Coverage totals: a floater's shared pool counts **once**; a life bundle sums each certificate's own cover; only policies in force count.
* Servicing (add/remove/correct member, change cover, change nominees, contact, cancel, reinstate) is **requests**: validated against ownership and the policy's state (the portal shows only actions the backend allows), recorded on the policy's audit trail (`CustomerServiceRequested`) and in the customer's "My requests". Nothing on an issued contract changes by itself.

## New / extended API (Customer Management `/v1`, all via the existing session)

`GET /family` · `/family/{id}` · `/family/{id}/policies` · `/family/{id}/members[/{key}]` · `/family/{id}/beneficiaries?policy_id=` ·
`POST /family/{id}/requests` · `GET /family/requests` · `POST /family/requests/{id}/withdraw` · `GET /policies/{id}/renewal` · `POST /policies/{id}/renewal/acceptance`.
Extended (default behaviour unchanged): `GET /policies|claims|documents|payments?segment=individual|family|all`, `GET /policies/{id}` and the premium / pay / claim endpoints now accept family policies the caller may act on, claims take `covered_person_id` + `consent_confirmed`, the dashboard gains a `family` section.

## Still unsupported for family

* **Staff-side queue for customer requests:** requests land on the policy's audit trail and in the customer's list; there is no staff approval screen for them yet, and the customer's status stays "With the insurer" (no automatic outcome sync).
* Nominee / member / cover changes are never applied by the portal (the existing endorsement endpoint applies immediately and has no approval step).
* Death claims by nominees (secure claimant process); online cancellation / reinstatement are requests only.
* Renewal **payment** uses the normal premium payment; renewed-terms acceptance is offered only when the renewal engine is waiting for it.
* A dependant with no account of their own sees nothing; there is no member invitation flow (each adult needs their own provisioning).
* Existing platform issue found while testing: `Case.caseNumber` is globally unique but claim numbers restart per tenant, so two tenants registering their first claim in the same year collide on the case number.
