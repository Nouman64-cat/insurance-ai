# Customer Portal (individual policyholders)

Next.js 14 (App Router) + TypeScript + Tailwind. English / Urdu (RTL). Port **3009**: http://localhost:3009

Self-contained: it imports nothing from the staff app (`frontend/`), shares no cookies with it and never uses the staff login.
It copies the staff app's *look* (Inter, blue/slate palette, collapsible sidebar, top bar, KPI cards, rounded cards).

## How a request flows

```
browser ──(httpOnly cookies cp_at / cp_rt / cp_scope)──▶ this app's /api/portal/*   (the BFF)
                                                          │ server-to-server, Bearer token from the cookie
                                                          ▼
                                   api-gateway  /customer-management/v1/*  ─▶  customer-management  ─▶  tenant-service adapter
```

* No token is ever readable by page JavaScript or stored in localStorage.
* `app/api/portal/auth/*` handle sign-in / first password change / refresh / logout and own the cookies.
* `app/api/portal/v1/[...path]` relays only the customer data routes (allow-list) and adds CSRF checks (custom header + Origin) on top of `SameSite=Lax`.
* A 401 makes the browser renew the session **once** (shared promise, tolerant of two tabs) and repeat the call; if renewal fails it goes to `/login`.
* `middleware.ts` only routes (login ↔ first-login ↔ app); the real authorisation is Customer Management verifying the token on every call.

## Screens

`/login` · `/first-login` · `/dashboard` · `/policies` · `/policies/[id]` · `/payments` · `/claims` · `/claims/new` · `/claims/[id]` · `/documents` · `/profile` · `/notifications` · `/support`

Family (only shown to customers who belong to a family with issued policies): `/family` · `/family/[id]` (Policies · Members · Beneficiaries · My requests). The policies, payments, claims and documents pages gain an Individual / Family switch (`?segment=family`).

## Run / check (always inside Docker — never run `next dev`/`build` from the host)

```bash
docker compose up -d --build customer-portal                     # dev server with hot reload
docker compose exec customer-portal npm run typecheck
docker compose exec customer-portal npm test                      # translation consistency (EN/UR keys + placeholders)
docker compose build --build-arg ... --target runner customer-portal   # production build is part of the image's `builder` stage
```

## Languages

`lib/i18n/en.ts` defines every key; `lib/i18n/ur.ts` must translate all of them (the compiler and `tests/i18n.test.mjs` enforce it).
Locale is stored in the `cp_locale` cookie (the staff app's cookie is deliberately not shared). Server error codes are translated by code.
Numbers, policy numbers and references always render left-to-right (`.ltr-num`).

## Environment

| Variable | Default | |
|---|---|---|
| `CM_API_URL` | `http://api-gateway:8000/customer-management` | where the BFF calls Customer Management |
| `COOKIE_SECURE` | `false` | set `PORTAL_COOKIE_SECURE=true` when served over HTTPS |
