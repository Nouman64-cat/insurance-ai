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
