# Claims Manager portal

The claims manager's own app (port **3011**), separate from the main portal (`frontend/`, 3000). It is a front-end split
only: same API gateway, tenant service and database. It signs in through the portal's single sign-on cookie, exactly like
the Underwriting Workbench (`underwriting-app/`), so it has no login or user store of its own.

Claims differ from underwriting: underwriting works a case that arrives from an earlier pipeline, while a claim is where a
process begins. So the claims manager runs the whole claims workspace here, including registering new claims.

| Route | What it is |
|---|---|
| `/claims/dashboard` (`/` and `/dashboard` redirect here) | The Dashboard: claims analytics (volumes, outflow and loss trends, status mix, risk) |
| `/claims` (also `/claims/register`) | The Claims Register, with **File New Claim** |
| `/claims/<id>` | One claim's workspace: lifecycle, documents and verification, eligibility, investigation, assessment, decision, settlement, payouts, closure |

These pages are copies of the main portal's claims pages (`frontend/app/claims/`), which stay for Admin and the claims
adjusters. The pages use the portal's shared API clients and components.

## Roles

Claims managers have their own accounts. A `ClaimsManager` is sent here after signing in to the portal
(`frontend/app/login/page.tsx`). Only that role gets in (`components/RoleGate.tsx`): any other role (Admin included) is
told this portal is not for them and sent back to the main portal, where Admin and the claims adjusters work with
claims (`frontend/app/claims`). What each role may do is still decided by the server (`routers/claims.py`,
`routers/claim_workflow.py`), not by this app.

## Running it

```
docker compose up -d --build claims-manager-app      # http://localhost:3011
```

Sign in on the portal first (the portal's `/claims` links redirect here) (http://localhost:3000). Shared code (API clients, UI kit, i18n) comes from `../frontend`, as
in the workbench (see `tsconfig.json` and `next.config.mjs`). Settings: `NEXT_PUBLIC_CLAIMS_URL` (this app's address,
default `http://localhost:3011`) in the root `.env`.
