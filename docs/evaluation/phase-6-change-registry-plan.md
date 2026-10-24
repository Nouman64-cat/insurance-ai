# Phase 6 Plan: Change Registry and Continuous Dataset Improvement

| | |
|---|---|
| **Status** | Version 1.2 (adds the RAG sync, section 9.1, and milestone M6b). Review decisions are in section 15. M0 and M1 are complete. No part of this plan beyond the items marked "built" in section 4 has been implemented. |
| **Owner** | Evaluation Platform |
| **Applies to** | The Individual Insurance golden datasets (single-turn and multi-turn) |
| **Related** | `docs/evaluation/architecture.md`, `docs/evaluation/implementation-progress.md` (Steps 6 to 9) |

---

## 1. Purpose

The golden datasets are only useful while they describe how the product actually behaves. The product keeps changing: premium rates and plans, underwriting rules, the proposal forms, the policy issuance workflow, the documents we produce. When any of these changes and a golden case is not revisited, one of two things happens. Either a test fails for a reason nobody can explain, or, worse, a test keeps passing while it no longer checks what matters.

This plan builds a **Change Registry**: a versioned record of everything in our product that a golden case depends on. When something in the registry changes, the platform finds the golden cases that are affected, shows a reviewer exactly what changed, and helps them produce an updated dataset version. The reviewer decides. The platform never edits an approved answer on its own.

## 2. Scope

### In scope

The parts of our own product that golden cases test, grouped by the stage of the policy journey:

| Area | Examples |
|---|---|
| **Illustration** (benefit illustration and quotation) | Plans and eligibility bands, premium rate tables, smoker and mode factors, the premium calculation, rounding |
| **Proposal writing** | The customer e-application, the Agent's Confidential Report, required fields and documents, lead and customer validation rules |
| **Underwriting** | Versioned underwriting rules, decision thresholds, medical and financial requirements, AML and sanctions screening thresholds |
| **Policy issuance** | The policy status workflow and its legal transitions, the initial premium payment gate, issuance preconditions, the policy application record document |
| **Servicing and claims** | Claim eligibility and authority rules, the claims status workflow, payment methods |
| **Security** | Role permissions, the points in the code where access is checked |

**Templates** managed in the Super Admin **Templates** section are in scope, starting with two: the **Illustration template (Lead / Acquisition source)** and the **Proposal template**. Further template types will be added on request. The Templates section does not exist yet, so section 6.1 states what it must provide. The registry is designed so that adding a new kind of watched item is configuration, not new code (section 6).

### Out of scope for this phase

- Changing, regenerating or auto-approving any golden answer without a named human reviewer.
- Training or fine-tuning any model.
- Production customer data other than de-identified traces that a reviewer explicitly submits (section 11).

## 3. Guiding principles

1. **Detect and propose automatically; decide manually.** The system may find a change and suggest a case. Only a person can accept it.
2. **No silent overwrite.** An approved golden case is never modified in place. Every update is a new, immutable dataset version published through the existing publish step.
3. **Every finding is explainable.** It names what changed, which version it changed from and to, which cases are affected, and why that matters.
4. **A finding never decides what is correct.** "The code now says X and the case says Y" is a question for a reviewer, not an instruction to change the case.
5. **Unknown stays unknown.** If a check cannot run, that is reported as its own finding. It is never counted as a pass or a mismatch.
6. **Generated content is a draft and is labelled as one.** Suggested cases have no expected answer; a reviewer writes it.
7. **Same bar as the rest of the platform.** A capability is complete only when it has a working API, a Super Admin page that uses it, and a frontend-to-backend test.

## 4. Where we are today

### Built and verified

| Item | Evidence |
|---|---|
| Detection logic (`shared/evaluation/drift.py`): rule mismatches, checks that cannot run, unconfirmed and unpinned cases, old approvals, coverage gaps, behaviour and performance change between runs, shifts in input patterns, de-identification of traces | 14 unit tests pass |
| Review rules: a proposal has no expected answer; accepting needs a named reviewer, a written reason and a reviewer-written expected value; nothing can overwrite an approved case or write to the Gold layer | Covered by the same tests |
| A read-only scan (`evals/tools/drift_scan.py`) that re-checks every case's pinned code check against the repository | First scan run on the 75 cases |
| Existing foundations this plan reuses: the Dataset Manager (drafts, approval, immutable publishing), the job worker with live events, the results API, benchmark history and comparison | Phases 3 to 5 |

### What the first scan found

On the 75 authoring cases: 174 pinned checks, 166 still true. It reported:

- **2 rule changes (real drift):** IND-SEC-009 and IND-SEC-011 quote text from `claims.py` that is no longer there.
- **21 unconfirmed cases:** the business has not confirmed the expected value.
- **6 checks that could not run:** the policy issuance cases (IND-ISS-001, 002, 003, 006) hit an import error (`Field() takes no arguments`) in the scan environment. This is treated as a defect to resolve first (milestone M0), not as drift.

### Not built

- Nothing watches data that is changed through the admin panel (rule versions, plans and rates, and later templates).
- No stored registry, no dependency links from cases to what they depend on, no automatic trigger, no database tables for findings, no API, and no Super Admin page for review.

## 5. Solution overview

```
 Something changes                 The platform notices                 A person decides                 The dataset moves forward
 (code, rule version,   ───────►   Registry takes a new     ───────►   Review queue shows the  ───►   New draft in the Dataset Manager,
  plan or rate, template)          fingerprint and finds               change, the affected cases       approved, published as a new
                                   the cases that depend on it         and a suggested next step        immutable version, then re-run
```

Five parts:

1. **Change Registry.** Each watched item has a stable identity and a sequence of versions. A version records a fingerprint (a content hash), when it was captured, where it came from, and a readable summary of its content.
2. **Dependencies.** A golden case declares what it depends on, next to the code checks it already has. For example, an illustration case depends on `plan:TERM-LIFE-SECURE` and `calc:premium`; a policy issuance case depends on `workflow:policy-status` and `rule:ipp-gate`.
3. **Detection.** Scans compare the current fingerprints with the last recorded ones and run the existing pinned checks. A change plus a dependency produces a review item for each affected case.
4. **Review queue.** The Super Admin Drift Monitor lists review items with the before-and-after difference, the affected cases and the options available to the reviewer.
5. **Publication and verification.** An accepted change becomes a draft in the Dataset Manager, goes through the normal approval, and is published as a new immutable version. The benchmark and evaluation runs are then repeated and compared across dataset versions.

## 6. The Change Registry

### Watched item types

Each type defines how an item is read and fingerprinted. Adding a type means adding a reader, not changing the registry.

| Type | Source of truth | Fingerprint | Available |
|---|---|---|---|
| `plan` | Plan and eligibility rows (age and term bands, rates, factors) | Hash of the normalised row | Now |
| `calc` | Premium and benefit calculation code | Hash of the function's syntax tree, so comments and whitespace do not count | Now |
| `rule` | Underwriting and commission rule versions (`RuleVersion`) | Version id and content hash | Now |
| `workflow` | Policy and claim status workflows and their legal transitions | Hash of the transition table | Now |
| `gate` | Preconditions such as the initial premium payment gate and screening thresholds | Hash of the configured values and the guarding code | Now |
| `access` | Role permissions and the access check points in routers | Hash of the permission table and the guarding statements | Now |
| `message` | Exact wording a case quotes from source | Presence and hash of the text (this is the check IND-SEC-009 uses today) | Now |
| `template` | Illustration (Lead / Acquisition source) and Proposal templates in the Super Admin Templates section | Hash of the stored template content | When the Templates section stores versioned templates (section 6.1) |
| `form` | E-application and ACR field definitions | Hash of the field list | When field definitions are stored as data (after the two template types) |

### 6.1 What the Templates section must provide

The registry reads templates; it does not own them. For the registry to follow a template, the Templates section needs to expose, for every template:

| Requirement | Why |
|---|---|
| A **stable key** per template, for example `illustration:<lead-source>` and `proposal` | So a change is recognised as a new version of the same template |
| A **version number** that increases on every save, and a status of draft or published | So the registry follows published versions only |
| The **content**, readable through an API | To fingerprint it and show a difference |
| Who changed it and when | For the review item and the audit trail |
| A **published event** (or a version list the scan can read) | So a scan can run after a publish, and so history can be compared |
| The list of **fields or sections** the template uses | So a new or removed field can be matched to the cases that fill it in |

If these are agreed before the Templates section is built, the registry reader (M6) is small.

### What a version stores

`item key`, `version number`, `fingerprint`, `captured at`, `captured from` (scan, publish event, or manual), `summary` (a readable rendering of the content for the diff view), and `previous version`. Content is stored only as a summary needed to show a difference; secrets are never captured.

## 7. Case dependencies

The golden case schema gains an optional `depends_on` list:

```json
"depends_on": ["plan:term-life-secure", "calc:premium", "workflow:policy-status"]
```

- It is optional and backward compatible: existing cases remain valid.
- A coverage report lists cases with **no** dependency and no code pin. Those cases cannot notice a change, so they are shown as an "unpinned" finding.
- A dependency is a statement by the case author. The scan checks that every key exists in the registry and reports unknown keys.

## 8. Detection

| Finding | Meaning | Typical severity |
|---|---|---|
| `config_changed` | A watched item changed and these cases depend on it | By the most severe affected case |
| `rule_changed` | A pinned check no longer matches the code | By the case |
| `oracle_error` | A check could not run | By the case |
| `unconfirmed` | The business has not confirmed the expected value | By the case |
| `unpinned` | An approved case has no check or dependency tying it to the product | Low to medium |
| `review_due` | Approved long ago and not revisited | Low |
| `coverage_gap` | A workflow stage or scenario type has too few cases | Low to medium |
| `behaviour_changed` | The same case behaved differently between two runs (verdict or tools used) | By the case |
| `performance_changed` | Pass rate, latency or cost moved between two runs | Medium to high |
| `input_shift` | The inputs people send no longer look like the dataset's | Low to medium |

**Triggers:** on demand from the Drift Monitor; a scheduled scan (default nightly); after a rule version is published; and as a check before a dataset version is published. A finding that is no longer present in the next scan is marked cleared automatically. A cleared finding never changes a case.

**De-duplication:** a finding has a stable key, so the same problem found by two scans is a single open item.

## 9. Review workflow

States: `open` → `in review` → `accepted` | `rejected` | `dismissed`. A rejected or dismissed item can be reopened. A cleared item (the problem went away) is closed by the system.

| Action | Requirements | Result |
|---|---|---|
| Start review | A signed-in reviewer | The item is assigned |
| Accept | A named reviewer, a written reason, and, where a case will change, an expected value written by the reviewer | A draft is prepared in the Dataset Manager. Nothing approved is touched |
| Reject | A reason | The case is kept as it is; the reason is recorded |
| Dismiss | A reason | Used for noise; kept in the history |

Every transition is recorded with who, when and why, and is written to the audit trail.

**What accepting does (decision).** In the first release, accepting records the decision and opens each affected case in the Dataset Manager, where the reviewer makes the edit, approves it and publishes. For template changes (M6), accepting additionally **prepares a draft** of each affected case with the mechanical change applied, for example a new template field added to the case's input, shown as a before-and-after. The prepared draft is saved only in the working copy. The new expected answer is never written by the system: where a calculation exists, an independent calculation may be shown as a labelled hint, and the reviewer confirms or corrects it.

**Suggested cases.** For a coverage gap or a new area, the platform names the workflow stage, the scenario type to cover and a seed case to model it on. A suggestion has no expected answer and no input; both are written by the reviewer. A model may be used to draft wording for the reviewer's convenience; its output is labelled as a suggestion and can never be accepted unchanged.

### 9.1 Templates, the agent's knowledge base (RAG) and suggestions

When a template is **published**, two things follow. They are kept separate because only one may be automatic.

| Flow | Automatic? | What happens |
|---|---|---|
| **Keep the knowledge base current** | Yes | The agent's knowledge base is re-indexed from the published template, so the assistant answers from the current wording. Only published templates are indexed. The previous index version is kept so it can be rolled back. Each re-index is logged. This is product content, not an expected test answer |
| **Suggest tests** | No: reviewed by a Super Admin | The same change produces suggested cases and prepared drafts: questions whose answers come from the template ("what does this field mean?", "what must the proposal contain?"), and updates to existing cases that fill the template in. A Super Admin approves; a new dataset version is published; a **Model Benchmarking** run checks the assistant against it |

The two meet at one point: after a re-index, the new tests check that the assistant's answers match the new template. That is the proof that the knowledge base update worked. The existing knowledge base (`seed_agent_rag.py`, `routers/agent.py`) is read and understood first; the sync is designed around how it is built today.

## 10. The Drift Monitor page (Super Admin)

| Section | Content |
|---|---|
| **Overview** | Dataset freshness (age of the last scan and the oldest unreviewed approval), open findings by severity and kind, coverage by workflow stage and scenario type |
| **Review queue** | Filterable by kind, severity, workflow stage, state and case. Each item shows the before-and-after difference, the affected cases and the available actions |
| **Affected cases** | For a selected change, every dependent case with its last result, so the reviewer can see impact before deciding |
| **Suggested cases** | Proposals for gaps, each linked to its seed case |
| **Scans** | History of scans: when, what was compared, counts, and a button to start a new one |
| **Versions** | Comparison of evaluation performance across dataset versions and across models, reusing the benchmark history |

Every control is backed by a real API. Access is limited to the Super Admin role. Super Admin is also the only role that may change business rules, so there is no separate approver permission.

## 11. Safety, privacy and audit

- Approved golden answers cannot be overwritten by a scan, a finding, a suggestion or a model. Enforced in the detection module, the API layer and by the existing database triggers on published versions.
- Traces may become suggestions only after de-identification: ID numbers, phone numbers, emails, account numbers, dates of birth and names are replaced, and a trace that still contains identifier-like text afterwards is rejected whole. Only the user's wording is kept.
- Reviewer decisions, scan runs and publications are recorded with who and when.
- **Retention.** Review decisions and their history are kept for as long as the dataset versions they relate to. Raw scan reports, and cleared or dismissed findings, are kept for 365 days, matching the data lake. Rejected trace-derived suggestions are deleted after 30 days. If a compliance rule requires longer, it replaces these figures.
- Scans are read-only. They run with the repository mounted read-only and no network.

## 12. Delivery plan

Effort sizes are relative: **S** is under a day, **M** is one to three days, **L** is three to five days.

| Milestone | Deliverables | Size | Done when |
|---|---|---|---|
| **M0. Make the scan trustworthy** | Resolve the `Field()` import error behind the 6 checks that cannot run; decide IND-SEC-009 and IND-SEC-011 (update the cases or the code) | S | A scan on the published dataset has no `oracle_error`, and every remaining finding is real |
| **M1. Storage** | Tables for registry items and versions, case dependencies, scans, review items and their history; migration; immutability for history rows | M | Migration applies twice cleanly; tests show history cannot be edited |
| **M2. Registry readers** | Readers for `plan`, `calc`, `rule`, `workflow`, `gate`, `access`, `message`; first snapshot; `depends_on` added to the case schema and the verifier | L | Changing a watched item in a test produces exactly one new version and the correct affected cases |
| **M3. Scan job and ingestion** | A scan job type run by the existing worker; ingestion of results into review items with de-duplication and automatic clearing; scheduled and on-publish triggers | M | The same scan twice creates no duplicates; a fixed problem clears |
| **M4. API and gateway** | List and filter items, item detail with difference and affected cases, state transitions with the review rules, start a scan, scan history; gateway routes | M | API tests pass with real tokens: an unauthenticated or non-Super-Admin caller is refused; an illegal transition is refused |
| **M5. Drift Monitor page** | Overview, review queue, affected cases, suggested cases, scans, version comparison | L | The frontend-to-backend test drives the page's own API module through scan, review, accept and reject, and checks that no approved case changed |
| **M6. Templates** | Readers for the Illustration (Lead / Acquisition source) and Proposal templates against the contract in 6.1; prepared drafts for affected cases when a template changes; `form` readers afterwards | M per template type | A changed template produces a finding that lists its dependent cases and prepares a draft for each. Starts when the Templates section stores versioned templates |
| **M6b. Knowledge-base sync and suggestions** | Read the existing agent knowledge base; re-index on template publish with rollback and logging; template-derived question suggestions and prepared drafts into the review queue; a freshness check that asks the assistant template-derived questions after a re-index | M to L | Publishing a changed template updates the index, logs it, and creates suggestions; the freshness check passes against the new wording and fails against the old. Starts with M6 |
| **M7. Hardening** | Frontend test coverage, tracker and documentation update | S | Full regression suites green |

M0 to M5 are the committed scope and need nothing new from other teams. M6 starts as soon as the Templates section exists and meets section 6.1. Because templates are the first priority, M6 is built straight after M5, and the template contract (6.1) should be shared with whoever builds the Templates section now.

## 13. Acceptance criteria for Phase 6

1. A change to a watched item produces a finding that lists the affected cases, within one scan cycle.
2. The first full scan of the published dataset reports no check that could not run, and every reported rule change is explained.
3. A reviewer can open an item, see the difference and the affected cases, and accept, reject or dismiss it, with the reason recorded.
4. Accepting an item creates a draft only. A test proves that no approved case and no published version is modified by any scan, finding or suggestion.
5. An accepted change that is approved and published creates a new immutable version; the dataset comparison shows the cases added, removed and changed.
6. The Drift Monitor page is covered by a frontend-to-backend integration test against the live gateway.
7. Performance and behaviour changes between two runs are visible in the page and exportable.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Too many findings; reviewers stop looking | Severity from the affected case; de-duplication; clearing of resolved items; stage-level coverage rules that default to the two scenario types that matter most (negative and boundary) |
| A fingerprint changes for harmless reasons (formatting, comments) | Syntax-tree fingerprints for code; normalised rows for data |
| A case depends on something nobody declared | The coverage report lists cases with no dependency; the verifier flags unknown keys |
| Reviewers approve without reading | A reason is mandatory; the difference is shown inline; decisions are audited |
| Suggested wording biases the dataset | Suggestions have no expected value; model-drafted text is labelled and cannot be accepted unchanged |
| Scan environment differs from production | Scans run with the whole repository mounted and fail loudly if it is not readable, instead of reporting false findings |
| Personal data in traces | De-identification with a refusal rule, reviewer-submitted traces only |

## 15. Decisions and remaining items

### Decided in review

| # | Question | Decision |
|---|---|---|
| 1 | Which areas first | Illustration (Lead / Acquisition source) and Proposal templates from the Super Admin Templates section. Other areas on request |
| 2 | Scan cadence | Nightly, and after each published rule version |
| 3 | Who confirms and changes business rules | Super Admin only. No separate approver permission |
| 4 | Review of old approvals | Flag after 180 days |
| 5 | What accepting does | First release: open the case in the Dataset Manager for the reviewer to edit. Template changes (M6): also prepare a draft for the reviewer |
| 6 | Template types first | Illustration (Lead / Acquisition source) and Proposal |
| 8 | Naming | The menu entries are **Evaluation Datasets** and **Model Benchmarking** (formerly Golden Datasets and LLM Benchmarking). "Golden case" stays the term for an approved test |
| 9 | Approvers | Super Admin first. Roles are defined afterwards; the approver is a setting, so roles plug in without a rewrite |
| 7 | Retention | Decisions kept with their dataset versions; scan reports and cleared findings 365 days; rejected trace suggestions 30 days |

### Still open

1. **The Templates section** does not exist yet. Who builds it, and when? M6 waits for it, and it should follow the contract in 6.1.
2. **The list of Lead / Acquisition sources** that have their own illustration template, so each can be a registry item.
3. **Compliance retention.** If any rule requires longer than the retention in 11, give the figure.

## Appendix A: Glossary

- **Golden case:** a test with an approved expected outcome.
- **Pinned check:** an executable statement attached to a case that ties it to the current code, for example "this text is in this file".
- **Fingerprint:** a hash of an item's content, used to tell whether it changed.
- **Finding / review item:** a detected problem and the person-facing record of how it was handled.
- **Draft:** a case in the working copy that is not yet approved or published.
- **Immutable version:** a published dataset version that can never be altered.
