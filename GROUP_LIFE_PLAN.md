# Group Life / Group Family Takaful — Implementation Plan

Tracking doc for adding Adamjee-style Group Life and Group Family Takaful automation **without disturbing the individual flow**.

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done

| Phase | Title | Status |
|---|---|---|
| 0 | Safety net | Done (E2E journey test deferred) |
| 1 | Data foundation | Done |
| 2 | Quote → issuance backend | Done |
| 3 | Agent automation (group journey) | Done (not yet exercised through a live LLM chat) |
| 4 | Endorsements | Done |
| 5 | Claims & renewal | Done (renewal scheduler is opt-in) |
| 6 | Takaful & extra products | Done (rates and splits are placeholders — see decision log) |

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
docker compose exec tenant-service python test_group_backfill.py
docker compose exec tenant-service python test_group_census_upload.py
docker compose exec tenant-service python test_underwriting_gate.py
docker compose exec chat-agent python test_journey_isolation.py
docker compose exec chat-agent python test_group_journey.py
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
- [x] `test_registries.py` runs once pytest is installed (`docker compose exec chat-agent pip install pytest` — not in requirements.txt, so it is lost when the image is rebuilt)

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
- [x] Plan picker and the new census columns: delivered in Phase 3 (create-scheme modal + CSV/XLSX upload). The manual census form on the Overview tab still sends only the original 6 columns

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
- [x] `test_group_pricing.py` (9 unit), `test_group_issuance.py` (8 integration, incl. a full HTTP run through FastAPI, the Takaful split, and Kafka publishing with a fake producer) and `test_group_backfill.py` (6 integration)
- [x] Takaful Wakala fee / PTF split: `group_pricing.takaful_split()` allocates the **risk contribution** between the operator's Wakala fee and the Participants' Takaful Fund; policy fee and stamp duty are charges and sit outside the split, so the total doesn't change. Rate comes from `InsurancePlan.wakala_fee_pct` (new nullable column, seeded 30% on `GROUP_FAMILY_TAKAFUL` — a **placeholder**, set the real figure per plan), falling back to `TAKAFUL_WAKALA_FEE_PCT` (default 30). Stored on `GroupQuote.wakala_fee_pct / wakala_fee / ptf_allocation` (+ `breakdown["takaful"]`), returned by the quote API, and printed on the quote and schedule PDFs. Migrations v51c–v51e. Retakaful share and surplus/deficit reporting stay in Phase 6.
- [x] Group transitions published to Kafka: `issue` (`GroupCertificateIssued`) and `payments` (`GroupCoverBound`) publish each certificate's `PolicyEvent` to `insurance.policy.lifecycle.v1` after the commit, through the same `_publish_policy_event` individual issuance uses (up to 20 sends in flight). Best-effort: a broker outage never fails or rolls back an issuance. Quote/accept/decline only change the master policy, which has no `PolicyEvent`, so there is nothing to publish for them.
- [x] Legacy `Active` master policies: `group_backfill.py` (dry run by default, `--apply` to write) allocates the master policy number and expiry, numbers certificates that have none (existing numbers kept), fills members' `annual_premium`, and reconstructs an Accepted v1 quote (`breakdown["legacy_backfill"]`, `decided_by = "legacy-backfill"`) from the current roster. Cover, status and money are untouched. Schemes with an undecided above-FCL member are skipped; an empty roster is numbered but gets no quote. Idempotent.
- [x] `_outcome()` now reads certificates in `PendingPayment` / `Active` as already decided (Approved, or Loaded if the decision carried a loading) instead of "awaiting a decision" — without this an issued scheme with above-FCL members couldn't be re-priced, which Phase 4 endorsements and the backfill both need.

## Phase 3 — Agent automation

- [x] `state.py`: `group_*` namespace (stage, organization, master policy, plan/business type, quote, scheme snapshot, pending members, census errors, missing nominations, outcome, audit, error, blocking chips) + `requires_group_intervention`
- [x] `group_journey.py`: nodes `g_scheme` … `g_enroll`, `g_resume`, `g_finish`, routers, `register_group_journey`. Every stage reads the scheme's real status and skips itself when the scheme is already past it; `g_resume` re-derives the stage from that status, so a census upload, an underwriting decision, an acceptance or a payment made anywhere (portal, chip, standalone tool) is picked up. A declined quote waits for a revised one — it is never re-quoted automatically
- [x] `group_tools.py` (new module, registered by import at the foot of `tool_executor.py`) + `tools.py`: `start_group_journey`, `continue_group_journey` and 11 granular tools — `create_group_scheme`, `add_group_benefit_class`, `submit_group_census`, `upload_group_census`, `get_group_scheme_status`, `list_group_members`, `generate_group_quote`, `accept_group_quote`, `decline_group_quote`, `issue_group_policy`, `record_group_payment`
- [x] Census upload: `upload_group_census` resolves the organization and master policy server-side, then returns the `__client_execute__` marker (the `upload_claim_document` pattern — the browser can't turn a company name into a master policy id, so it isn't in `CLIENT_EXECUTED_TOOLS`). The browser half is `frontend/components/group/GroupCensusClientTool.tsx`: file picker → `POST …/census/parse` → validate → confirm, then hands the outcome back to the agent (a closed picker resumes it too). New tenant-service endpoint `POST …/master-policies/{mp}/census/parse` + `services/census_file.py` read CSV and XLSX with the standard library only (header aliases, Excel date cells, numeric CNICs, 5 MB / 5,000-row limits)
- [x] `toolsets.py`: `group` domain + keywords (bound only when the conversation is about group schemes)
- [x] `permission.py`: `GROUP_TOOLS` is **admin-only, read tools included** (tenant-service gates every group endpoint on `verify_admin`; without the guard the read-only tools sit in `SAFE_TOOLS`, which hands them to Viewer). `start_group_journey` is one confirmation like the other journeys; `generate_group_quote` is a guided step; `record_group_payment` requires a bank `reference` outside demo mode (demo generates one). Required args, progress labels added
- [x] `graph.py`: `GROUP_JOURNEY_TOOLS` dispatch block, `group` prompt section, registration. Employer acceptance is never automatic — the stage always waits
- [x] After `add_organization`, a "Start group scheme" chip (admins only)
- [x] Demo-mode census generator (`generate_demo_census`): random names, CNICs, ages, pay and hire dates on every call, never repeating a CNIC; covers sit below the lowest Free Cover Limit a demo group can get, so a demo scheme is guaranteed-issue and never calls the risk engine unless `above_fcl_count` asks for senior staff above it. Demo classes + census are demo-only (`ENV_VAR=demo`); outside it the journey stops for the real census
- [x] Process-graph markers `stage:group_*`: each node emits `journey_done` / `journey_next`, which `routers/chat.py` already renders as steps (no frontend change was needed)
- [x] Frontend `app/admin/organizations/[id]`: tabs Overview (the existing page, unchanged) · Scheme · Classes · Members · Quote, deep-linkable with `?tab=` (the chat navigates there). New components in `frontend/components/group/`: scheme pipeline + issue + payment + schedule PDF; benefit-class list/add/delete; members roster (paged, searchable) with a CSV/XLSX census uploader and a drawer for dependants and nominees; quote generate/revise/accept/decline/PDF with the Takaful split. The create-scheme modal now has the plan picker (Group Life / SME / Group Family Takaful)
- [x] Roster API now returns `nominations` per member (one grouped query) for the "missing nominee" follow-up
- [x] Tests: `test_group_journey.py` (19, chat-agent: the real graph edges against an in-memory tenant API, demo and prod), `test_registries.py` now runs (324 passing with the isolation tests; install pytest in the container first), `test_journey_isolation.py` pins the group nodes, `test_group_census_upload.py` (6). The journey was also run end to end against a real tenant-service on a scratch database: demo Takaful scheme → quote with the Wakala/PTF split → accept → issue → payment → 12 active members, 48 lifecycle events published; prod stopped at the census as designed
- [ ] Not covered: a live conversation through the LLM and the chat UI (no model credits / browser session available while building); the browser census picker was verified with a temporary probe page and a stubbed API, the tabs with a stubbed API
- [ ] The Overview tab's manual census form still sends the original 6 columns — the new columns arrive through file upload
- [ ] Employer acceptance is an admin action (tab or chat); a link the employer can use themselves is still an open question (below)

## Phase 4 — Endorsements

- [x] `services/group_endorsement_engine.py`: ADD / DELETE / CHANGE (salary, grade, designation, class, loan balance). Pure helpers (`pro_rata`, `adjustment_totals`, `next_certificate_sequence`) are unit-tested without a database; `preview_endorsement` prices without writing, `create_endorsement` applies
- [x] Pro-rata premium/contribution delta (days remaining counted inclusively, stamp duty included, Takaful delta split into Wakala / PTF / retakaful); FCL check on additions and increases — above-FCL lines wait as `PendingUnderwriting` and `resolve_endorsement` applies them once the policy status / Case is decided
- [x] Certificate issue / cancel per member (certificate numbers are never reused after a removal); endorsement PDF (`generate_group_endorsement`); settlement Due → Settled with a bank reference. Table `group_endorsements`, endpoints under `.../master-policies/{mp}/endorsements` (preview, create, list, detail, resolve, settle, document)
- [x] Agent tools: `preview_group_endorsement`, `add_group_members`, `remove_group_members`, `change_group_member`, `list_group_endorsements`, `resolve_group_endorsement`, `settle_group_endorsement` (preview first; members are named, never UUIDs)
- [x] Frontend Endorsements tab (new endorsement with preview, history, settle, resolve, PDF)
- `enroll_census_rows` was extracted from `confirm_employee_census` so enrolment and ADD share one code path; `confirm_employee_census` behaves as before.

## Phase 5 — Claims & renewal

- [x] Claim document requirements branch for group certificates (`services/group_claims.py`: `GROUP_CLAIM_DOCUMENTS` by benefit — death adds the death certificate, employer certificate, salary slip and the nominees' CNICs; disability / continuation have their own lists), exposed through `GET /claims/{id}/group-context`
- [x] Payout split from `Beneficiary.share_pct` to the paisa, with `SPLIT_RULES` / `register_split_rule` as the override hook for policy wording, plus a reasoned manual override (must total 100%); minors are paid to a guardian and a minor without one blocks the payout; no nominee on file pays the claimant only after explicit confirmation
- [x] Dependent claims only when a `GroupMemberDependent` covers the person (and are paid to the employee); eligibility also checks cover dates, certificate status and the rider schedule
- [x] `services/group_renewal.py`: scheduler opens renewals `GROUP_RENEWAL_LEAD_DAYS` (60) before expiry and lapses forgotten ones; **opt-in** with `GROUP_RENEWAL_SCHEDULER=true`. An admin can also start one up to `GROUP_RENEWAL_WINDOW_DAYS` (120) ahead; `POST /tenants/{t}/group-renewals/run` runs a cycle by hand
- [x] Census refresh (joiners / changes applied as endorsements, leavers only when asked) + experience rating + re-quote → employer acceptance → payment starts the next period. The renewal quote is tied to the renewal (`GroupQuote.renewal_id`); accepting never changes `MasterPolicy.status`
- [x] Agent tools: `start_group_renewal` (opens, optionally refreshes the census, prices), `get_group_renewal`, `accept_group_renewal`, `decline_group_renewal`, `record_group_renewal_payment`; claims: `register_group_claim`, `list_group_claims`, `preview_group_claim_payout`, `pay_group_claim`
- [x] Frontend Claims tab (register for a member or dependant, document checklist, payout split with override, pay) and Renewals tab (experience card, workforce refresh with preview, quote, accept / decline, payment, PDF, history)
- Claims approval and document upload stay in the existing Claims module; the group tab links to it. `open_claim`, `assert_claim_payable` and `settle_claim_with_payouts` were extracted from `routers/claims.py` and the individual endpoints behave as before.

## Phase 6 — Takaful & extra products

- [x] Takaful fields: Wakala fee %, PTF allocation and Retakaful share (`InsurancePlan.retakaful_share_pct`, `GroupQuote.retakaful_share_pct / retakaful_contribution`; retakaful is a share of the PTF allocation) on the quote, schedule, renewal quote and endorsement deltas
- [x] Contribution terminology: Takaful quotes, schedules, renewal quotes and endorsement documents say "Contribution", conventional ones "Premium" (covered by a test that reads the generated PDF text)
- [x] Coverages: Accidental Death, Disability, Pay Continuation, Fee Continuation as `GroupClassCoverage` rows (percent of the member's life cover, optional cap), priced flat per mille (`RIDER_RATES_PER_MILLE`) into the quote, `breakdown.by_coverage`, endorsements and claim eligibility. Endpoints `POST/DELETE .../benefit-classes/{class}/coverages`; adding one withdraws an open quote; locked once the quote is accepted. Classes UI has the rider editor; chat has `add_group_class_coverage` and a `coverages` field on `add_group_benefit_class`
- [x] Group Credit Life plan (`GROUP_CREDIT_LIFE`, seeded; existing tenants need `python seeds/insurance_plans_seed.py --all`): new `LoanBalance` basis — cover is each borrower's `loan_amount` (census column + `GroupMember.loan_amount`), capped by the class maximum, and a CHANGE endorsement re-bases it after repayments
- [x] PTF surplus/deficit reporting: `GET .../master-policies/{mp}/ptf-report` (Takaful only) per period — Wakala fee, fund, retakaful, claims incurred / paid / reserved, result — shown on the Scheme tab. Claims are counted gross; Qard Hassan and surplus distribution are noted, not modelled

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
| 2026-10-06 | Takaful Wakala fee is a % of the risk contribution only; policy fee and stamp duty are charges outside the split. The fee % lives on the plan (placeholder 30%), not the master policy |
| 2026-10-06 | Group lifecycle events publish per certificate, after commit, best-effort — same contract as individual issuance |
| 2026-10-06 | Group tools are admin-only including the read-only ones: tenant-service gates every group endpoint on `verify_admin`, and `SAFE_TOOLS` would otherwise grant reads to Viewer |
| 2026-10-06 | The group journey is status-driven: each stage skips when the scheme is past it and resume re-derives the stage from the scheme, so work done outside the chat is never repeated or lost |
| 2026-10-06 | Employer acceptance is never automatic (not even in demo); a declined quote waits for a revised one |
| 2026-10-06 | Census files are read server-side with the standard library (CSV + XLSX), so no spreadsheet dependency is added to the image or the frontend |
| 2026-10-06 | Legacy backfill is an explicit script (dry run first), not an automatic startup migration: it writes numbers and a reconstructed quote, so a person should see the report before it runs |
| 2026-10-06 | Endorsement pro rata counts both the effective and expiry day; a refund mirrors the charge, and certificate numbers are never reused |
| 2026-10-06 | An above-FCL endorsement line never changes cover until its decision exists; it is applied by an explicit re-check, not a background job |
| 2026-10-06 | Group claims reuse the individual claim record and payout rows (extended with `group_member_id`, `payee_*`, `share_pct`) rather than a parallel claims table |
| 2026-10-06 | Experience rating: loss ratio against a 0.60 target, clamped 0.85–1.50, weighted by credibility sqrt(lives/250) — **placeholder bands**, replace with the actuarial table |
| 2026-10-06 | Placeholder rates pending the real figures: Wakala fee 30%, Retakaful share 20% of the PTF allocation, rider rates in `RIDER_RATES_PER_MILLE`. All sit on the plan or in one table, not in code paths |
| 2026-10-06 | The renewal scheduler is opt-in (`GROUP_RENEWAL_SCHEDULER=true`) so a new service can't open renewals on a tenant before someone has chosen the lead time |
| 2026-10-06 | `migrate.py` skips the legacy business-rule column steps once rule-engine v2 is applied; repeated add/drop of those columns had exhausted Postgres' 1600-column limit on `business_rules` and stopped the service starting |

## How to run the group tests

```
docker compose exec tenant-service python test_group_pricing.py        # pure rules
docker compose exec tenant-service python test_group_phase6.py         # needs a migrated Postgres
# every test_group_*.py plus test_migrations.py; chat agent:
docker compose exec chat-agent python -m pytest -q test_group_journey.py test_registries.py test_journey_isolation.py
```
