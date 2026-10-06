# Group Life / Group Family Takaful — Implementation Plan

Tracking doc for adding Adamjee-style Group Life and Group Family Takaful automation **without disturbing the individual flow**.

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done

| Phase | Title | Status |
|---|---|---|
| 0 | Safety net | Done (E2E journey test deferred) |
| 1 | Data foundation | Done |
| 2 | Quote → issuance backend | Done |
| 3 | Agent automation (group journey) | Not started |
| 4 | Endorsements | Not started |
| 5 | Claims & renewal | Not started |
| 6 | Takaful & extra products | Not started |

---

## Domain recap

- One **Master Policy** is issued to the employer (the policyholder). Employees are **insured members**, each with a certificate. Cover usually renews every year.
- **DEPENDENT ≠ BENEFICIARY ≠ INSURED MEMBER.** One person can hold several roles, but the records stay separate. A dependent is covered only if listed on the policy schedule, never because they were named as a nominee.
- Cover formula per benefit class: flat amount, grade/designation, length of service, or salary multiple (e.g. 36 × monthly salary).
- Business type: **Conventional Group Life** vs **Group Family Takaful** (contributions → Participants' Takaful Fund, Tabarru, Retakaful). Takaful is a distinct type, not a boolean.
- Lifecycle: Corporate customer → Scheme → Benefit structure → Census → Group underwriting + pricing → Corporate quote → Acceptance → Master policy → Member enrollment → Endorsements → Claims → Annual renewal.

## Current state (as of 2026-10-06)

| Exists | Gap |
|---|---|
| `Organization`, `MasterPolicy`, `Customer.organization_id`, `Policy.master_policy_id` | `MasterPolicy` supports only one flat salary multiple. No benefit classes, no grade/fixed cover, no link to `InsurancePlan` (noted in `services/tenant-service/group_underwriting.py:18`). |
| Census validate/confirm, FCL, per-member risk scoring (`services/tenant-service/routers/organizations.py:485-768`) | Census confirm always inserts a new `Customer`. If the employee is already an individual customer, the insert fails on `uq_customer_cnic_per_tenant`. |
| Per-member `calculate_premium` | No scheme-level quote, no employer acceptance step, no issuance endpoint. `MasterPolicy` stops at "Proposed". |
| `Beneficiary` table on each `Policy` | No dependents modeled. |
| `ProductCategoryEnum.TAKAFUL` on plans | No Group Takaful plan, no contribution/PTF concepts. |
| Agent can `add_organization` | The agent has no tools for scheme, census, quote, issuance, endorsements or renewal. |
| ⚠️ `services/tenant-service/routers/renewal_scheduler.py:86` runs `select(Policy)` unfiltered | Once group certificates go Active, the **individual** renewal scheduler would renew them one by one. |

## Isolation rules

1. **Database changes are additive only.** New tables, plus new nullable columns appended to `migrate.py`. No existing column or enum value changes meaning.
2. **New modules, not edits.** `group_journey.py`, `routers/group_schemes.py`, `group_pricing.py`, `services/group_endorsement_engine.py`, `services/group_renewal.py`. `journey.py`, the risk-engine's individual rules and `quote_worker.py` are not modified.
3. **Separate agent state.** All group state lives under `group_*` keys in `ChatState`, the same way `claim_*` keys are kept apart from `journey_*`.
4. **Shared code changes are guards only.** Wherever shared code meets a group record, the only change is `if policy.master_policy_id: skip/branch`. Group tables reference `customers`/`policies` with `ON DELETE CASCADE`, so existing delete paths (customer, policy, family member) need no edits.
5. **Regression tests come first** (Phase 0), so any change to individual behavior shows up as a failing test.

## Target data model

```
Organization (existing)
 └── MasterPolicy ............ EXISTING (the scheme + contract) + plan_id, policy_number, expiry_date   [Phase 1 ✓]
      ├── GroupBenefitClass .. NEW  (name, basis: Flat | SalaryMultiple | ServiceBanded, grades[],     [Phase 1 ✓]
      │    │                         min/max cover, is_default)
      │    └── GroupClassCoverage NEW (Life | AccidentalDeath | Disability | PayContinuation |         [Phase 1 ✓]
      │                              FeeContinuation, % of base SA) — Life 100% auto-created
      ├── GroupMember ........ NEW  (customer_id, certificate policy_id, benefit_class_id, employee_id,  [Phase 1 ✓]
      │    │                         grade, designation, basic_monthly_salary, joining_date,
      │    │                         coverage_amount, cover_start/end, status)
      │    ├── GroupMemberDependent NEW (name, CNIC, relationship, DOB, covered_amount: only if on the schedule) [Phase 1 ✓ table]
      │    └── Beneficiary ... EXISTING (on the certificate Policy)
      ├── GroupQuote ......... NEW  (version, total SA, total premium/contribution, per-class breakdown, valid_until, status) [Phase 2 ✓]
      ├── GroupEndorsement ... NEW  (ADD | DELETE | CHANGE, member lines, pro-rata premium delta, effective date) [Phase 4]
      └── GroupRenewal ....... NEW  (year N→N+1, refreshed census, experience-rated premium, status)         [Phase 5]
```

Design decisions:
- **No separate `GroupScheme` table.** `MasterPolicy` already carries the scheme lifecycle (Pending → Proposed → Active); a second entity would mean two status pipelines for one deal.
- **`GroupMember` is a separate table instead of relying on `Customer.organization_id`.** The census looks up an existing `Customer` by CNIC and reuses it, which fixes the CNIC collision. One person can then be an individual policyholder and a group member at the same time. `organization_id` is still set for customers the census creates, and never set on a reused customer.
- **Removing an employee never deletes someone else's data.** Their group certificates and memberships go; the `Customer` is deleted only if the census created it and nothing else of theirs remains (otherwise it's just detached).
- **Benefit classes freeze once members exist.** Changing a class after enrolment changes members' cover, so it becomes an endorsement (Phase 4).
- **Business type comes from the linked plan:** `MasterPolicy.plan_id → InsurancePlan.product_category` (CONVENTIONAL or TAKAFUL). Takaful records get their own fields (Wakala fee %, PTF allocation).
- **Payout splits stay configurable:** the `Beneficiary.share_pct` split is applied to group claims, with a rule hook so policy wording or local law can override it.

## Agent journey (`services/chat-agent/group_journey.py`)

This mirrors `claims_journey.py`: `g_*` nodes registered with `register_group_journey(builder)`, started with `start_group_journey` and resumed with `continue_group_journey`.

| Stage | Node | What it does | Stops for a human when |
|---|---|---|---|
| 1 | `g_scheme` | Create or attach the Organization, create the MasterPolicy (plan, Conventional/Takaful) | — |
| 2 | `g_benefits` | Define benefit classes and coverages (from chat or a demo template) | — |
| 3 | `g_census` | CSV/XLSX upload through the client-executed tool, then validate | Rows fail validation |
| 4 | `g_underwrite` | Group size vs plan minimum, FCL, above-FCL members to the risk-engine, age/industry checks | Above-FCL members need an underwriter decision |
| 5 | `g_quote` | Scheme-level pricing → `GroupQuote` + PDF | — |
| 6 | `g_acceptance` | Wait for the employer | **Always.** Accept / Revise / Decline |
| 7 | `g_issue` | Activate master policy, assign policy number, issue certificates, set org to POLICYHOLDER, generate documents | First premium/contribution unpaid (`billing_gate`) |
| 8 | `g_enroll` | Activate members, record beneficiaries and dependents | Missing nominations (listed for follow-up, doesn't block) |

These run against an Active scheme as separate tools: endorsements (`add_group_members`, `remove_group_members`, `change_group_member`) and renewal (`start_group_renewal`). Claims reuse the existing claims journey, with a group-specific document list.

---

## Phase 0 — Safety net

Run the regression suite before and after every phase:

```bash
docker compose exec tenant-service python test_group_isolation.py
docker compose exec tenant-service python test_group_benefits.py
docker compose exec tenant-service python test_group_census.py
docker compose exec tenant-service python test_group_pricing.py
docker compose exec tenant-service python test_group_issuance.py
docker compose exec tenant-service python test_underwriting_gate.py
docker compose exec chat-agent python test_journey_isolation.py
```

- [x] Guard `renewal_scheduler.py`: new `renewal_candidates_query()` excludes `master_policy_id IS NOT NULL` (the scheduler is currently disabled in `main.py`; the guard is in place for when it's re-enabled)
- [x] Guard `policies.py` `GET /policies/renewals/upcoming`: excludes group certificates
- [x] `services/tenant-service/test_group_isolation.py` (live DB, self-cleaning): renewal candidates and upcoming renewals keep individual + family policies and exclude group certificates; policy-list segments unchanged; per-tenant CNIC uniqueness still enforced. Verified it fails without the guards.
- [x] `services/chat-agent/test_journey_isolation.py`: pins underwriting + claims journey nodes/transitions, launch tools, UI stage ids, state namespaces, and resume/suspension routing
- [x] Audit of `select(Policy)` queries:
  - `renewal_scheduler.py`, `policies.py` upcoming renewals → guarded (above)
  - `policies.py` stats + list → OK (list already tags `segment`; counting certificates is correct)
  - `services/insurance_history.py` → **keep including group cover**: an applicant's group cover is real in-force exposure for individual underwriting
  - per-customer queries in `customers.py`, `families.py`, `organizations.py`, `cases.py` → OK
- [ ] Not covered (needs full stack + JWT; deferred): end-to-end run of `journey.py` intake→closure, individual quote via `api-gateway/quote_worker.py`, full `routers/families.py` flows. The isolation tests cover the shared touch points these depend on.
- [ ] `test_registries.py` can't run yet: pytest isn't installed in the chat-agent container or locally

## Phase 1 — Data foundation

- [x] Models in `shared/models/core.py`: `GroupBenefitClass`, `GroupClassCoverage`, `GroupMember`, `GroupMemberDependent` (+ enums `GroupBenefitBasis`, `GroupCoverageType`, `GroupMemberStatus`; stored as plain strings, no new PG enum types)
- [x] `MasterPolicy` new nullable columns: `plan_id`, `policy_number`, `expiry_date`
- [x] `migrate.py` v50a–v50k: columns, `plan_id` backfill to tenant's GROUP_LIFE, `group_members` backfill from existing certificates (dev DB: 45 members, 3/3 master policies linked), FKs re-declared with ON DELETE CASCADE
- [x] Seed plan `GROUP_FAMILY_TAKAFUL` (product_category = Takaful). Existing tenants: `docker compose exec tenant-service python seeds/insurance_plans_seed.py --all` (idempotent, adds missing codes only; **not yet run on dev**)
- [x] `MasterPolicyCreate.plan_code` (default GROUP_LIFE; must be a Group plan); `MasterPolicyRead` adds `plan_code`, `plan_label`, `business_type`, `policy_number`, `expiry_date`
- [x] Benefit class endpoints (moved from Phase 2): `POST/GET /master-policies/{id}/benefit-classes`, `DELETE …/{class_id}`; 409 once members exist
- [x] `group_benefits.py`: class resolution (explicit name → grade → default), Flat / SalaryMultiple / ServiceBanded cover with min/max caps; legacy flat multiple when no classes
- [x] Census validate/confirm: plan `min_group_size` on the first census only; date/number format checks; benefit-class checks; duplicates checked against this master policy's members
- [x] Census confirm reuses an existing `Customer` by CNIC (profile untouched) and writes a `GroupMember` per row; outcome adds `group_member_id`, `benefit_class`, `reused_existing_customer`
- [x] Roster, employee counts and org case list include reused members (but not their individual cases); employee removal and org deletion keep reused customers and their individual policies
- [x] `test_group_benefits.py` (9 unit tests) and `test_group_census.py` (6 integration tests)
- [ ] Frontend census form still sends only the original 6 columns — new columns + plan picker land with the Phase 3 UI tabs

### Census template

| Column | Required | Notes |
|---|---|---|
| `cnic` | ✓ | 13 digits or `XXXXX-XXXXXXX-X` |
| `name` | ✓ | |
| `dob` | ✓ | `YYYY-MM-DD` |
| `gender` | ✓ | |
| `occupation` | ✓ | |
| `declared_income` | ✓ | **Annual**; risk engine input |
| `employee_id` | | Employer's staff number |
| `designation` | | |
| `grade` | | Auto-assigns the class whose `grades` lists it |
| `joining_date` | | `YYYY-MM-DD`; required for ServiceBanded classes |
| `benefit_class` | | Class name; overrides grade matching |
| `basic_monthly_salary` | | Base for salary multiples; defaults to `declared_income / 12` |
| `is_smoker`, `height_cm`, `weight_kg` | | Used only for above-FCL risk scoring and pricing |

## Phase 2 — Quote → issuance backend

Master policy lifecycle: `Pending → Proposed (census) → Quoted → Accepted → PendingPayment (issued) → Active (paid)`; `Declined` when the employer turns a quote down (re-quoting is still allowed). All endpoints live in `routers/group_policies.py` under `/tenants/{t}/organizations/{o}/master-policies/{mp}/…`.

- [x] `group_pricing.py`: one rate for the pool = plan base rate × SA-weighted age factor × size discount × occupational hazard factor (reuses `calculator.py` age bands/fees and `occupation_hazard.py`); per-life loadings; one policy fee + stamp duty per scheme
- [x] Above-FCL outcomes (`group_underwriting.member_underwriting_outcome`): Approved → full cover, AcceptedWithLoadings → full cover + loading, Declined → **restricted to FCL**, undecided → quote blocked (409 lists the members)
- [x] `GroupQuote` (versioned, 30-day validity via `GROUP_QUOTE_VALIDITY_DAYS`, full breakdown snapshot) + quote PDF — `POST/GET …/quotes`, `GET …/quotes/{id}/document`
- [x] Revise (new quote supersedes the open one) / `…/accept` / `…/decline`; accept and issue refuse if the roster or cover changed since quoting; expired quotes can't be accepted
- [x] `POST …/issue`: master policy number `GL-YYYY-NNNN` (`GT-` for Takaful), certificates `GL-YYYY-NNNN/0001…` walked to PendingPayment through the state machine, member premium allocation + cover notes, schedule PDF (`GET …/schedule/document`)
- [x] `POST …/payments`: full premium binds the scheme — master policy, certificates, members, dependants → Active; organization → POLICYHOLDER
- [x] Dependants: `POST/GET/DELETE …/members/{id}/dependents` (Spouse/Child/Parent, cover ≤ member's, editable until a quote is accepted; priced and listed on the schedule)
- [x] Nominations: `PUT/GET …/members/{id}/beneficiaries` — same `Beneficiary`/`BeneficiaryVersion` rows as individual, allowed while cover is in force (the individual endpoint is Stage-A-only, which excluded every group certificate)
- [x] `GET …/members`: roster with class, certificate number/status, underwriting basis, premium share, dependants
- [x] `test_group_pricing.py` (7 unit) and `test_group_issuance.py` (5 integration, incl. a full HTTP run through FastAPI)
- [ ] Takaful Wakala fee / PTF split → Phase 6 (Takaful quotes already say "contribution" and number `GT-`)
- [ ] Group transitions record `PolicyEvent`s but aren't published to Kafka (individual issuance does via `_publish_policy_event`)
- [ ] Legacy dev master policies already marked `Active` (seed data) have no policy number / quote — left as is

## Phase 3 — Agent automation

- [ ] `state.py`: `group_*` namespace (stage, organization_id, master_policy_id, quote, missing items, outcome, audit, error)
- [ ] `group_journey.py`: nodes `g_scheme` … `g_enroll`, `g_resume`, `g_finish`, routers, `register_group_journey`
- [ ] `tools.py`: `start_group_journey`, `continue_group_journey`, granular scheme/census/quote/issue tools
- [ ] Census upload via `CLIENT_EXECUTED_TOOLS` (CSV/XLSX)
- [ ] `toolsets.py`: new `group` domain + keywords
- [ ] `permission.py`: role/platform permissions, required args, progress labels
- [ ] `graph.py`: `GROUP_JOURNEY_TOOLS` dispatch block, prompt section, registration
- [ ] After `add_organization`, offer a "Start group scheme" chip
- [ ] Demo-mode census generator (random, never repeating)
- [ ] Process-graph markers `stage:group_*` rendered in UI
- [ ] Frontend `app/admin/organizations/[id]`: tabs for Scheme, Classes, Members, Quote

## Phase 4 — Endorsements

- [ ] `services/group_endorsement_engine.py`: ADD / DELETE / CHANGE (salary, grade, class)
- [ ] Pro-rata premium/contribution delta; FCL check on additions (above-FCL → UW case)
- [ ] Certificate issue / cancel per member; endorsement document
- [ ] Agent tools: `add_group_members`, `remove_group_members`, `change_group_member`
- [ ] Frontend Endorsements tab

## Phase 5 — Claims & renewal

- [ ] Claim document requirements branch for group certificates (salary slip, employer certificate, death certificate, CNICs)
- [ ] Payout split from `Beneficiary.share_pct` with override hook
- [ ] Dependent claims only when `GroupMemberDependent` covers the person
- [ ] `services/group_renewal.py`: group renewal scheduler (60 days before expiry)
- [ ] Census refresh + experience rating (claims ratio) + re-quote → employer acceptance
- [ ] Agent tool: `start_group_renewal`
- [ ] Frontend Claims and Renewals tabs

## Phase 6 — Takaful & extra products

- [ ] Takaful fields: Wakala fee %, PTF allocation, Retakaful share
- [ ] Contribution terminology in quotes, schedules and documents
- [ ] Coverages: Accidental Death, Disability, Pay Continuation, Fee Continuation
- [ ] Group Credit Life plan
- [ ] PTF surplus/deficit reporting (stretch)

---

## Open questions

- [x] First milestone: Takaful plan seeded from Phase 1 (business type selectable now); Wakala/PTF specifics stay in Phase 6
- [x] Census template: defined by us (see Phase 1) — revisit if Adamjee supplies a format
- [ ] Employer acceptance: in-app admin click only, or also a link the employer can use to accept?

## Decision log

| Date | Decision |
|---|---|
| 2026-10-06 | Build on existing `Organization`/`MasterPolicy`; add `GroupMember` instead of relying on `Customer.organization_id` |
| 2026-10-06 | Separate `group_journey.py` and `group_*` state namespace, following the `claims_journey.py` pattern |
| 2026-10-06 | Dropped `GroupScheme`; `MasterPolicy` is the scheme. `GroupQuote` / `GroupEndorsement` / `GroupRenewal` tables are created in the phases that use them |
| 2026-10-06 | Group FKs use ON DELETE CASCADE so individual/family delete paths need no changes |
| 2026-10-06 | Reused customers are never modified or deleted by group operations |
| 2026-10-06 | Group issuance is its own endpoint; individual `POST /policies/{id}/issue` gates (E-App, IPP, per-policy payment) don't apply to an employer-paid contract |
| 2026-10-06 | Above-FCL decline restricts cover to the FCL rather than excluding the member |
| 2026-10-06 | Benefit-class endpoints live in `organizations.py`; no separate `group_schemes.py` |
