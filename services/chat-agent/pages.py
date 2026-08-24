"""Canonical registry of every navigable page in the frontend.

Single source of truth shared by `navigate_to_page` (which needs the literal
route list for its enum) and `show_record` (which needs to know, for a given
record type, which page lists it and which query param that page self-selects
on). Keeping both in one table stops the two tools from drifting apart as
routes are added.

`highlight_param` is the query-string key the destination page reads to scroll
to + ring the matching row. Pages that predate the `data-entity-id` convention
use their own param (admin/leads' `?cnic=`, cases' `?case_id=`); everything
else uses the generic `?highlight=` that useHighlightTarget picks up.
"""

from __future__ import annotations

from typing import NamedTuple, Optional


class Page(NamedTuple):
    route: str
    label: str
    description: str
    # Record type this page lists, if any — keyed on by show_record().
    lists: Optional[str] = None
    highlight_param: str = "highlight"
    # Real URL path when it differs from the model-facing route name — the
    # dashboard is the app's index page ("/"), but "dashboard" is what users
    # and the model naturally call it.
    path: Optional[str] = None

    @property
    def url_path(self) -> str:
        return self.route if self.path is None else self.path


PAGES: list[Page] = [
    # ── Main ────────────────────────────────────────────────────────────────
    Page("dashboard", "Dashboard", "Management intelligence overview — KPIs, risk index, fraud alerts.", path=""),
    Page("submissions", "Submissions", "Incoming submission queue."),
    Page("cases", "Cases", "All cases across every workflow stage.", lists="case", highlight_param="case_id"),
    Page("artifacts", "Artifacts", "Uploaded documents and their OCR/processing status.", lists="artifact"),
    # ── Underwriting ────────────────────────────────────────────────────────
    Page("underwriting", "Underwriting", "Underwriting case queue grouped by customer.", lists="case", highlight_param="case_id"),
    Page("applications", "Applications", "Insurance applications with downloadable PDFs.", lists="case", highlight_param="case_id"),
    Page("claims", "Claims", "Claim cases and their investigation status.", lists="claim"),
    Page("reimbursements", "Reimbursements", "Reimbursement requests."),
    Page("fraud", "Fraud Detection", "Fraud ring analysis and flagged patterns."),
    Page("score-engine", "Score Engine", "Risk scoring engine configuration and outputs."),
    # ── Intelligence ────────────────────────────────────────────────────────
    Page("proposal", "Proposal", "Generated quotations and proposals.", lists="quote"),
    Page("live-evaluation", "Live Evaluation", "Run a risk evaluation live with SSE streaming."),
    Page("case-summarizer", "Case Summarizer", "AI summarisation of case documents."),
    Page("assessments", "Assessment History", "Historical AI risk assessments.", lists="assessment"),
    Page("agents", "Agents", "Sales agent roster and performance."),
    Page("financial", "Financial", "Premium collection and financial reporting."),
    Page("reports", "Reports", "Exportable operational reports."),
    Page("plans", "Plans", "Insurance product catalogue.", lists="plan"),
    # ── Policy lifecycle ───────────────────────────────────────────────────
    Page("policy-issuance", "Policy Issuance", "Policy issuance queue — issue approved proposals and confirm payments.", lists="policy"),
    Page("policy-management/post-issuance", "Post-Issuance Policies", "Active policies in the post-issuance management section.", lists="policy"),
    # ── Workflow stages ─────────────────────────────────────────────────────
    Page("pre-underwriting", "Pre-Underwriting", "The 6 clearance gates before risk assessment.", lists="case", highlight_param="case_id"),
    Page("post-underwriting", "Post-Underwriting", "Reinsurance referral and post-decision review."),
    Page("renewals", "Renewals", "Policies due for renewal."),
    # ── Commission & distribution ───────────────────────────────────────────
    Page("commissions", "Commissions", "Commission overview — earnings, rate card, payees."),
    Page("commissions/rate-card", "Rate Card", "Versioned SECP statutory commission rates by segment and policy year."),
    Page("commissions/payees", "Payees", "Everyone who can be owed commission — producers, managers, partners."),
    Page("commissions/calculator", "Commission Calculator", "Preview the commission waterfall for a policy."),
    Page("commissions/types", "Commission Types", "Commission kinds — commission, override, partner and referral fees."),
    Page("commissions/bonuses", "Bonuses & Incentives", "Production bonuses and persistency incentives."),
    Page("commission-ops", "Commission Operations", "Commission operations overview."),
    Page("commission-ops/ledger", "Commission Ledger", "Every commission entry and its release status."),
    Page("commission-ops/statements", "Statements", "Per-payee commission statements."),
    # ── Treasury ────────────────────────────────────────────────────────────
    Page("treasury/runs", "Payout Runs", "Maker–checker payout runs awaiting approval or disbursement."),
    Page("treasury/banking", "Banking & Dispatch", "Payment file generation and bank dispatch batches."),
    Page("treasury/settlement", "Settlement", "Bank settlement reconciliation and returned payments."),
    Page("treasury/holdbacks", "Holdbacks", "Commission liens — licence, debt recovery and suspension holds."),
    # ── Risk & regulatory ───────────────────────────────────────────────────
    Page("risk/clawbacks", "Clawback Engine", "Commission recoveries on free-look cancellation and early lapse."),
    Page("risk/tax", "Tax & Withholding", "Payee tax profiles and s.233 withholding rates."),
    Page("risk/secp", "SECP Compliance", "Distribution expense ratios against statutory caps."),
    # ── Admin ───────────────────────────────────────────────────────────────
    Page("admin/rule-engine", "Rule Engine", "Versioned underwriting rule sets — catalogue, criteria, simulator and audit log."),
    Page("admin/leads", "Leads", "Prospective customers not yet converted.", lists="customer", highlight_param="cnic"),
    Page("admin/customers", "Customers", "All registered customers.", lists="customer", highlight_param="cnic"),
    Page("admin/policyholders", "Policy Holders", "Customers with an active policy.", lists="customer", highlight_param="cnic"),
    Page("admin/acquisition-sources", "Acquisition Sources", "Channels customers arrived through."),
    Page("admin/organizations", "Organizations", "Corporate / group-life clients.", lists="organization"),
    Page("admin/families", "Family Groups", "Family floater groups.", lists="family"),
    Page("admin/users", "Users", "System users and their roles.", lists="user", highlight_param="userId"),
    # ── Super Admin ─────────────────────────────────────────────────────────
    Page("super-admin/tenants", "Tenant Management", "Tenants on the platform.", lists="tenant"),
    Page("super-admin/admins", "Admin Management", "Tenant administrators."),
    Page("super-admin/branches", "Branch Management", "Branch offices.", lists="branch"),
    Page("super-admin/tokens", "Token Economy", "LLM token usage and quotas."),
    # ── Personal ────────────────────────────────────────────────────────────
    Page("profile", "Profile", "Your own account settings."),
]

PAGE_ROUTES: list[str] = [p.route for p in PAGES]

_BY_ROUTE = {p.route: p for p in PAGES}
# First page that lists a given record type wins — the "canonical home" for it.
_BY_RECORD: dict[str, Page] = {}
for _p in PAGES:
    if _p.lists and _p.lists not in _BY_RECORD:
        _BY_RECORD[_p.lists] = _p


def page_for_route(route: str) -> Optional[Page]:
    return _BY_ROUTE.get(route)


def page_for_record(record_type: str) -> Optional[Page]:
    return _BY_RECORD.get(record_type)


def build_route(route: str, entity_id: Optional[str] = None) -> str:
    """Resolve a model-facing route name to the real URL path, appending the
    destination page's own highlight param so it self-selects the record
    instead of just landing on the list."""
    page = _BY_ROUTE.get(route)
    if not page:
        return route
    if not entity_id:
        return page.url_path
    return f"{page.url_path}?{page.highlight_param}={entity_id}"


def catalogue() -> str:
    """Human-readable page list, injected into the system prompt so the model
    can map fuzzy user phrasing ("show me the leads") onto a real route."""
    return "\n".join(f"- {p.route} — {p.label}: {p.description}" for p in PAGES)
