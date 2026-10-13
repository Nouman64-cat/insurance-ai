# Request Management app

Next.js frontend for [Request Management](../services/request-management-service/README.md), on port **3007**. It
has no login of its own: it signs in from the portal's session, like the Underwriting Workbench.

| Page | Who | What |
|---|---|---|
| `/requests` | everyone | My requests: drafts, open requests, outcomes |
| `/requests/new` | roles that may submit | New request. Prefills from links: `?type=customer_profile_correction&customer_id=…`, `?type=commission_dispute&earning_id=…` |
| `/requests/{id}` | requester, reviewers, administrators | Details: proposal and reviewed revision (before/after for corrections), review outcome, execution outcome, comments, attachments, timeline, and the actions the server allows you |
| `/requests/{id}/edit` | requester | Edit a draft, or the proposal of a request returned for more information (a new revision) |
| `/requests/review` | reviewers | Requests assigned to you and unclaimed requests in your team's queue |
| `/requests/admin` | tenant administrators | Every submitted request in the tenant, with overdue and failed-execution counts |
| `/requests/routing` | tenant administrators | Routing rules: who reviews each request type, per branch, and the time to decide |

Lists are filtered, searched and paged on the server (status, type, priority, assignee, branch, dates, overdue);
the search box is debounced. Every screen has loading, empty, error and "not allowed" states. English and Urdu
(right-to-left) follow the language chosen in the portal.

## Sign-in

- **Route check:** `middleware.ts` sends a visitor without the portal's `insurance_sso` cookie to the portal login,
  and the login returns them to the exact URL (deep links work).
- **Verification:** `/api/sso/session` checks the token with the gateway's `/auth/me` before anything renders.
- **Expiry and sign-out:** an expired or revoked session goes back to the portal login. Signing out here signs the
  portal out too (`/login?signout=1`).
- **Shared implementation:** these pieces are shared with the Underwriting Workbench, in `frontend/lib/satellite/`
  and `frontend/components/satellite/`.

The portal, the Underwriting Workbench and this app link to each other through `frontend/lib/appLinks.ts`, which
treats `/requests…` as this app's. Its origin (`NEXT_PUBLIC_REQUESTS_URL`) is one of the allowed sign-in return
origins.

## Shared code

Like the workbench, this app compiles the portal code it uses from `../frontend`: `tsconfig.json` maps `@/x` to `./x`
first and `../frontend/x` second. That covers the API client, i18n, the language switch, notifications, `appLinks`
and the shared sign-in pieces. `lib/sso.ts` here re-exports the shared portal-sign-in version, so the portal's API
client sends expired sessions to the portal login.

## Running

```bash
cp .env.example .env.local     # native development values
npm install
npm run dev                    # http://localhost:3007
npm run typecheck
npm run build                  # production build (type-checks too)
```

It needs the API gateway, tenant-service and request-management-service running, and the portal for sign-in. A
tenant administrator configures at least one routing rule (Routing page) before requests of that type can be
submitted.
