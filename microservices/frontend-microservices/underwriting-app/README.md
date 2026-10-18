# Underwriting Workbench

The underwriting queue and case workspace as their own Next.js app (port **3005**), separate from the portal
(`frontend/`, port 3000) and the Automation Chat (`automation-chat/`, port 3004). It's a front-end split only: it
uses the same API gateway, tenant service, risk engine and database as the portal.

| Route | What it is |
|---|---|
| `/underwriting` | Underwriting hub: the pre-underwriting queue (`?tab=pre-underwriting`, six clearance gates) and the risk-engine folders (`?tab=risk-engine`). Gate focus mode: `?case=<id>&gate=eapp&returnTo=/case/<id>` |
| `/pre-underwriting` | Redirects to `/underwriting?tab=pre-underwriting`, as before |
| `/case/<id>` | Case workspace: documents, e-application, ACR, IPP, compliance (PEP and sanctions), insurance history, medical exam, AI risk evaluation, reinsurance, decision. Family members open as tabs of the same workspace |
| `/post-underwriting` | Post-underwriting verification: counter-offers, facultative referrals, free-look |
| `/live-evaluation` | Live risk evaluation stream |
| `/assessments` | Assessment history |

Policy issuance, post-issuance servicing, claims, commissions, administration and the dashboards stay in the portal.
Links between the apps go to the right one automatically (see `frontend/lib/appLinks.ts`).

## Sign-in (single sign-on)

The workbench has no login and no user store of its own. It uses the portal's session, through the same
`insurance_sso` cookie the Automation Chat uses:

1. Signing in on the portal stores the token and sets the httpOnly `insurance_sso` cookie (the portal's
   `app/api/sso/session`, after checking the token with the gateway's `/auth/me`).
2. `middleware.ts` runs before any workbench page. With no cookie, the browser goes to the portal's
   `/login?next=<the exact workbench URL>`, so a case opened in a new tab comes back to that case. The portal only
   follows `next` to the configured app origins (`NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_UNDERWRITING_URL`,
   `NEXT_PUBLIC_AUTOMATION_URL`). Anything else is ignored.
3. With a cookie, `components/workbench/SsoGate.tsx` asks `/api/sso/session`, which checks the token with the
   gateway's `/auth/me` on every call. Nothing renders until that succeeds. The user, tenant, role and branch shown and
   used come from that answer, and fill the same localStorage keys and `Authorization` / `X-Tenant-Id` headers the
   portal's login sets, so the shared API clients behave as they do in the portal. The backend still authorizes every
   request. The role only decides what the UI offers.
4. **Expired or revoked token:** `/api/sso/session` answers 401 and clears the cookie, or any API call answers 401.
   The workbench forgets its session and goes to the portal login, returning afterwards. The portal doesn't bounce an
   expired token straight back (`app/ClientLayout.tsx`), and both apps stop after a few rounds if the cookie never
   arrives (`/sso-problem` explains why).
5. **Signing out** in the workbench clears the cookie and opens the portal's `/login?signout=1`, which clears the
   portal's stored session too. Signing out in the portal clears the cookie, and the workbench notices the next time
   its tab is shown. A different user signing in on the portal reloads the workbench as them.
6. Accounts without a tenant (SuperAdmin) get an explanation instead of the queue, as the portal hides Underwriting for
   them.

Localhost needs no cookie domain: cookies are shared across ports. For HTTPS deployments on subdomains
(`portal.example.com`, `underwriting.example.com`), set `SSO_COOKIE_DOMAIN=.example.com` on all three apps and serve
them over HTTPS (the portal marks the cookie `Secure` behind an HTTPS proxy, or with `SSO_COOKIE_SECURE=true`).

## Shared code

Code that both apps use stays in one place, the portal, and is compiled into the workbench from there: no copies. The
workbench's `tsconfig.json` maps `@/x` to `./x` first and `../frontend/x` second:

- **Workbench-only code lives here:** the six route pages, the gate dialogs (`components/entities/ACRModal`,
  `IPPModal`, `CustomizeEAppModal`, `VerifyEAppModal`), `components/case/CaseDocumentList`, `ModalPortal`,
  `lib/case-report.ts`, `lib/pdf-export.ts`, and the services only these pages call (`artifacts`, `eApplication`,
  `initialPremiumPayment`, `insuranceHistory`, `medicalExam`).
- **Shared code comes from `frontend/`:** `app/services` (API clients, `api.ts`), `components` (metric cards,
  filters, pagination, notifications, language switch…), `lib` (i18n and translations, `appLinks`, live events, record
  highlighting, CNIC utilities) and `app/globals.css`. These are the only portal folders the Docker image receives
  (`Dockerfile.dockerignore`), so importing anything else from the portal fails the build.
- **Overridden for the workbench:** `lib/sso.ts`. Shared portal code that imports `@/lib/sso` (the API client's 401
  handling) gets this app's version, which signs in through the portal. The type-check enforces that it keeps the
  exports shared code uses.
- `next.config.mjs` resolves every package from this app's `node_modules`, also for the portal files, so there is
  one copy of React and of the Next.js router.

When you change a shared portal file, check both apps (`npm run typecheck` here and in `frontend/`).

## Configuration

Copy `.env.example` to `.env.local` for a local `npm run dev`. Docker Compose sets these itself.

| Variable | Default | Used for |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8010` | API gateway, from the browser |
| `NEXT_PUBLIC_OCR_URL` | `http://localhost:8014` | OCR, from the browser |
| `API_GATEWAY_INTERNAL_URL` | `http://api-gateway:8000` | Gateway, from this app's server (session check, live-event stream). `http://localhost:8010` outside Docker |
| `NEXT_PUBLIC_PORTAL_URL` | `http://localhost:3000` | Sign-in, "Back to the portal", links to portal pages, customer e-application and medical-exam links |
| `NEXT_PUBLIC_UNDERWRITING_URL` | `http://localhost:3005` | This app's public URL. **Also set it on the portal and the Automation Chat**: their underwriting links and the portal's old-URL redirects use it |
| `NEXT_PUBLIC_AUTOMATION_URL` | `http://localhost:3004` | The chat that embeds case views (messages to it are only sent to this origin) |
| `SSO_COOKIE_NAME` | `insurance_sso` | Must match the portal's |
| `SSO_COOKIE_DOMAIN` | *(empty)* | Empty on localhost. The shared parent domain (`.example.com`) across subdomains |
| `ENV_VAR` | *(empty)* | Demo/prod mode, as in the portal |

`NEXT_PUBLIC_*` values are compiled into the browser bundle. For a production image they are build arguments (see
`docker-compose.yml`, `underwriting-app-prod`).

## Running

### Docker (recommended)

```bash
# The workbench and the backend it needs (api-gateway, tenant-service and their dependencies):
docker compose up -d --build underwriting-app
# Sign-in happens on the portal: start it too if it isn't running.
docker compose up -d frontend

open http://localhost:3005          # or open Underwriting from the portal's sidebar
docker compose logs -f underwriting-app
docker compose stop underwriting-app
```

The dev service hot-reloads this folder and the shared portal folders (mounted read-only).

### Production build (Docker)

```bash
docker compose --profile prod up -d --build underwriting-app-prod     # http://localhost:3006
```

It runs beside the dev service. Portal links and redirects still point at `:3005`: open `:3006` directly after signing
in on the portal. For a real deployment build it with `NEXT_PUBLIC_UNDERWRITING_URL` set to its public URL.

### Without Docker

```bash
cd underwriting-app
npm install
cp .env.example .env.local                 # API_GATEWAY_INTERNAL_URL=http://localhost:8010 outside Docker
npm run dev                                # http://localhost:3005 (stop the Docker service first: same port)
npm run build && npm run start             # production build on :3005
```

The backend must be running (`docker compose up -d api-gateway tenant-service`), and the portal too, for sign-in.

### Checks

```bash
npm run typecheck     # this app, including the portal code it compiles
npm test              # route ownership, sign-in return validation, live-event scoping (node --test)
npm run build         # production build (type-checks too)
```

## Performance

Moving the pages into their own app doesn't make them faster by itself: they still load the same data from the
same API. What changed:

- **Lazy loading.** The four gate dialogs load when first opened, and the AI-summary markdown renderer loads when a
  summary is shown. The Urdu page-text dictionary (~110 KB compressed) is no longer in the client bundle: the root
  layout sends it only when the language is Urdu (`frontend/lib/i18n/pageText.ts`; the portal does the same).
- **Live updates.** The gateway's event stream carries every write in the tenant. The queue now ignores writes that
  can't affect underwriting (claims, commissions, rules, users…) instead of re-reading the whole queue for each one.
  Bursts of events, tab focus and visibility changes, a reconnect, and the chat's per-message refresh request are
  coalesced, so one re-read runs and never two at once (`lib/liveRefresh.ts`). Case-specific events (e-application
  submitted, ACR filed, medical completed…) still refresh immediately.
- **Lighter layout.** The workbench frame is a small header: no sidebar, tour, quote/document pollers or
  ACR-request bell, and one live-event connection per page.

### Benchmarking

Development and production differ a lot (the dev server compiles each page on first visit and serves unminified
React, about 9 MB of JavaScript per page instead of 0.2–0.3 MB). Measure each layer separately:

1. **Development compilation:** `docker compose logs underwriting-app | grep Compiled` shows the first-visit compile
   per route. It only matters to developers.
2. **API latency:** time the gateway directly. It's the same whichever app calls it:
   `curl -o /dev/null -s -w '%{time_total}\n' -H "Authorization: Bearer $TOKEN" http://localhost:8010/tenants/$TENANT/cases`
3. **Browser rendering:** use the production build (`underwriting-app-prod`) with a cold cache: Chrome DevTools →
   Network "Disable cache" + Performance, or Lighthouse. Compare time to first byte, DOMContentLoaded, and the time
   until the queue or case data is on screen. Run several times and take the median.
4. **Bundle size:** `npm run build` prints each route's first-load JavaScript.

## Notes and limitations

- Old portal URLs (`/underwriting…`, `/case/<id>…`, `/post-underwriting`, `/live-evaluation`, `/assessments`,
  `/pre-underwriting`) redirect here with the same path and query (`frontend/next.config.mjs`, temporary redirects).
- The admin onboarding tour runs in the portal. Its underwriting step now points at the sidebar link instead of
  following the user into the workbench.
- The portal's ACR-request bell and toasts (for agents) stay in the portal. Underwriting screens show ACR status per
  case.

Summarization uses `NEXT_PUBLIC_API_URL` with the SSO JWT bearer token. The gateway verifies underwriting permissions and proxies to `TEXT_SUMMARIZER_URL` (default `http://text-summarizer:8005`). The summarizer has no published host port or public domain.
