---
id: client-apps
title: Client Apps
sidebar_position: 12
---

# Client Apps

Both clients talk only to the API Gateway (`:8010`) — except the web portal's OCR and summarizer screens, which call those services directly via `NEXT_PUBLIC_OCR_URL` / `NEXT_PUBLIC_SUMMARIZER_URL`.

## Web portal — `frontend/`

Next.js 14.2 (App Router), React 18, TypeScript, Tailwind CSS. Runs on **http://localhost:3000** (`frontend` container, or `npm run dev`). API base: `NEXT_PUBLIC_API_URL` (default `http://localhost:8010`).

| Area | Routes |
|---|---|
| Sign-in & profile | `/login`, `/profile` |
| Leads & customers | `/admin/leads`, `/admin/customers`, `/admin/customers/[id]/plans`, `/admin/families`, `/admin/organizations`, `/admin/policyholders`, `/admin/acquisition-sources` |
| Proposals & quotes | `/proposal`, `/plans`, `/submissions`, `/applications` |
| Cases | `/cases`, `/case/[id]` (case workbench), `/artifacts`, `/case-summarizer` |
| Underwriting | `/pre-underwriting`, `/underwriting`, `/live-evaluation`, `/assessments`, `/score-engine`, `/financial`, `/fraud`, `/post-underwriting` |
| Issuance & servicing | `/policy-issuance`, `/policy-management/post-issuance`, `/post-issuance/[policyId]`, `/renewals` |
| Claims | `/claims`, `/claims/dashboard`, `/claims/register`, `/claims/[id]`, `/reimbursements` |
| Commissions | `/commissions` (+ `bonuses`, `calculator`, `payees`, `rate-card`, `types`), `/commission-ops` (+ `ledger`, `statements`), `/agents` |
| Treasury & risk | `/treasury/{banking,holdbacks,runs,settlement}`, `/risk/{clawbacks,secp,tax}`, `/reports` |
| Administration | `/admin`, `/admin/users`, `/admin/rule-engine` |
| Super Admin | `/super-admin/tenants`, `/super-admin/admins`, `/super-admin/branches`, `/super-admin/llm-config`, `/super-admin/tokens` |
| Customer-facing (no login) | `/e-application/[token]`, `/medical-exam/[token]` |

The [AI copilot](/chat-agent) is available across the portal; the top-bar search uses `GET /tenants/{id}/search`. Commission rates come from the tenant rule engine (rule set `commission.secp_rate_card`).

## Agent mobile app — `agent-app/`

Expo 54 / React Native 0.81 app for field agents (Agent role only).

```bash
cd agent-app
npm install
npm start
```

| Env var | Purpose |
|---|---|
| `EXPO_PUBLIC_API_URL` | API Gateway URL — use a LAN address reachable from the device, not `localhost` |
| `EXPO_PUBLIC_WEB_URL` | Web portal URL, used to build customer E-Application links |

**Screens:** Login, Dashboard, Leads (board, detail, add, category select), Cases (list, add), Proposals (list, add), Underwriting, Agent Confidential Report, Review E-Application, Policy Issuance, Commission, SECP Rate Card, Chat (copilot), Notifications, Settings, Help, About.

**Lead sync:** `sync/LeadSyncProvider.tsx` polls the shared lead state, diffs snapshots, and raises in-app notifications — so a lead created in the portal (or by another agent) appears without a refresh. It backs off after failures.

The copilot on mobile runs with `platform="mobile"`, which blocks some tools that are allowed on web for the same role (see `permission.py`).
