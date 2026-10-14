"""
Insurer-level config for the Premium Notice renderer.

Every field here can be overridden by a matching key inside
Tenant.details JSON if you ever move to per-tenant payment channels.
Until then this is the single place to update bank details per insurer.
"""
from __future__ import annotations

# ── Notice timing ─────────────────────────────────────────────────────────────
NOTICE_VALIDITY_DAYS: int = 30  # Pay-by window from notice issue date

# ── Payment channels ──────────────────────────────────────────────────────────
# Each entry: {"label", "detail", "note" (optional)}
PAYMENT_CHANNELS: list[dict] = [
    {
        "label": "Bank Transfer / IBFT",
        "detail": "Account No: 0123-4567-8901-234 (MCB Bank Limited)",
        "note": "Quote the Challan No. in the payment narration.",
    },
    {
        "label": "JazzCash",
        "detail": "Mobile Account: 0300-0000000",
        "note": "Use 'JazzCash Pay to Bank' and quote your Challan No.",
    },
    {
        "label": "Easypaisa",
        "detail": "Mobile Account: 0333-0000000",
        "note": "Use 'Easypaisa Send Money' and quote your Challan No.",
    },
    {
        "label": "Nearest Branch",
        "detail": "Visit any of our branch offices and present this notice.",
        "note": "Cash / pay-order accepted.",
    },
    {
        "label": "Online Portal",
        "detail": "insurer.portal.example.com  →  My Policies  →  Pay Premium",
        "note": "24/7 payment with instant confirmation SMS.",
    },
]

# ── Legal notices (SECP-expected) ─────────────────────────────────────────────
NOTICE_ACTIVATION_CLAUSE = (
    "Coverage under this policy commences only upon realization of the first "
    "premium in full. Until payment is realized no insurance cover is in force."
)

NOTICE_FREE_LOOK = (
    "Free-Look Period: You may cancel this policy within 14 days of receipt of "
    "the Policy Schedule by notifying us in writing. A refund of premium, less "
    "expenses incurred, will be processed within 30 days."
)

NOTICE_GRACE_LAPSE = (
    "Grace Period & Lapse: A grace period of 30 days is allowed for renewal "
    "premium payments. If premium is not received by the last day of the grace "
    "period, the policy will lapse and all benefits will cease. Revival may be "
    "subject to fresh underwriting."
)

NOTICE_NTU = (
    "Not-Taken-Up (NTU): If this notice remains unpaid beyond the due date, "
    "the proposal will be treated as Not-Taken-Up and the file will be closed. "
    "You may re-apply subject to prevailing underwriting terms."
)

NOTICE_FRAUD = (
    "Any misrepresentation, mis-statement, or concealment of material facts in "
    "the proposal form will render this policy void. Fraudulent claims will be "
    "referred to the relevant authorities."
)

NOTICE_GRIEVANCE = (
    "Grievance: For queries or complaints contact our UAN/helpline or write to "
    "the Compliance Officer. Unresolved grievances may be escalated to SECP at "
    "secp.gov.pk/complaint."
)


# ── Stage B recurring collection (step 3) ─────────────────────────────────────
import os as _os  # noqa: E402

# Late-payment surcharge applied when an installment is paid during the grace
# period (percentage of the base premium).
LATE_PAYMENT_SURCHARGE_PCT: float = float(_os.environ.get("LATE_PAYMENT_SURCHARGE_PCT", "2.0"))

# Agent commission earned per collected installment (percentage of base premium).
AGENT_COMMISSION_PCT: float = float(_os.environ.get("AGENT_COMMISSION_PCT", "5.0"))

# The planned reminder cadence around each due date (day offsets + kind).
REMINDER_SCHEDULE: list[dict] = [
    {"key": "T-7", "offset": -7, "kind": "Upcoming", "label": "7 days before"},
    {"key": "T-0", "offset": 0, "kind": "Due", "label": "On due date"},
    {"key": "T+3", "offset": 3, "kind": "Overdue", "label": "3 days overdue"},
    {"key": "T+7", "offset": 7, "kind": "FinalNotice", "label": "7 days overdue"},
]

REMINDER_CHANNELS: list[str] = ["Email", "SMS", "WhatsApp", "Letter"]
REMINDER_TEMPLATES: list[str] = ["Friendly", "Standard", "FinalNotice"]

# Reminder body templates keyed by template name. {name}/{amount}/{due}/{policy}
# are substituted at send time.
REMINDER_BODIES: dict[str, str] = {
    "Friendly": (
        "Hi {name}, just a friendly reminder that your premium of PKR {amount} for "
        "policy {policy} is due on {due}. Thank you for staying protected with us!"
    ),
    "Standard": (
        "Dear {name}, this is a reminder that a premium of PKR {amount} on policy "
        "{policy} is due on {due}. Please pay on time to keep your cover in force."
    ),
    "FinalNotice": (
        "FINAL NOTICE — Dear {name}, the premium of PKR {amount} on policy {policy} "
        "(due {due}) remains unpaid. Pay before the grace period ends to avoid lapse "
        "of cover. Reinstatement afterwards may require fresh underwriting."
    ),
}


# ── Stage B reinstatement (revive a lapsed policy) ────────────────────────────
# Reinstatement rules are set PER PRODUCT. Adamjee Life publishes the process
# (31-day grace → lapse → clear arrears + signed Declaration of Good Health,
# optional extra medical evidence, underwriting approval) but NOT a universal
# maximum revival period, so every number below is a configurable placeholder to
# be replaced with the product's contract terms. Resolution order for a policy:
#   REINSTATEMENT_PRODUCT_RULES[<product_name, lower-cased>]  →  DEFAULT.
REINSTATEMENT_DEFAULT_RULES: dict = {
    # Days after the lapse date during which a revival request is still accepted.
    "window_days": int(_os.environ.get("REINSTATEMENT_WINDOW_DAYS", "730")),
    # Lapsed this long or less (and clean declaration) → declaration alone is enough.
    "declaration_only_days": int(_os.environ.get("REINSTATEMENT_DECLARATION_ONLY_DAYS", "90")),
    # Lapsed longer than this AND sum assured above the Non-Medical Limit → a
    # medical examination is mandatory evidence.
    "medical_evidence_days": int(_os.environ.get("REINSTATEMENT_MEDICAL_EVIDENCE_DAYS", "180")),
    # Charges on top of the unpaid premiums (0 = none). Interest is simple, per
    # annum, on each unpaid instalment from its due date to the reinstatement date.
    "interest_pct_annual": float(_os.environ.get("REINSTATEMENT_INTEREST_PCT", "0")),
    "fee_amount": float(_os.environ.get("REINSTATEMENT_FEE_PKR", "0")),
    # Ceiling for a loading an underwriter may offer on revised terms.
    "max_loading_pct": float(_os.environ.get("REINSTATEMENT_MAX_LOADING_PCT", "300")),
}

REINSTATEMENT_PRODUCT_RULES: dict[str, dict] = {
    # "term life": {"window_days": 365, "medical_evidence_days": 120},
}

# Statements the policyholder signs in the Declaration of Good Health / Risk
# Evaluation Form. `adverse_if` is the answer that needs underwriter attention.
REINSTATEMENT_DECLARATION_QUESTIONS: list[dict] = [
    {"key": "good_health", "adverse_if": False, "needs_details": False,
     "text": "I am in good health today and know of nothing that would make me uninsurable."},
    {"key": "hospitalised", "adverse_if": True, "needs_details": True,
     "text": "Since the policy lapsed I have been hospitalised, had surgery, or been advised to have surgery."},
    {"key": "new_condition", "adverse_if": True, "needs_details": True,
     "text": "Since the policy lapsed I have been diagnosed with, or treated for, a new illness or condition."},
    {"key": "pending_tests", "adverse_if": True, "needs_details": True,
     "text": "I have current symptoms, or a medical test or specialist referral whose results are pending."},
    {"key": "new_medication", "adverse_if": True, "needs_details": True,
     "text": "I take regular medication that I was not taking when the policy was issued."},
    {"key": "tobacco_change", "adverse_if": True, "needs_details": True,
     "text": "My tobacco / nicotine use has increased or started since the policy was issued."},
    {"key": "occupation_change", "adverse_if": True, "needs_details": True,
     "text": "My occupation or hazardous pastimes (aviation, diving, racing, armed forces…) have changed since issue."},
    {"key": "other_insurer_action", "adverse_if": True, "needs_details": True,
     "text": "Another insurer has declined, postponed or loaded an application on my life since the policy lapsed."},
]

REINSTATEMENT_REQUEST_CHANNELS: list[str] = ["Branch", "Portal", "Agent", "Phone", "Email"]
REINSTATEMENT_APPLICANT_RELATIONSHIPS: list[str] = ["Policyholder", "Nominee", "Agent", "Representative"]


def reinstatement_rules(product_name: str | None) -> dict:
    """Rules in force for a product (product override merged over the default)."""
    rules = dict(REINSTATEMENT_DEFAULT_RULES)
    rules.update(REINSTATEMENT_PRODUCT_RULES.get((product_name or "").strip().lower(), {}))
    return rules


# ── Stage B renewals (premium renewal vs contract renewal) ────────────────────
# Adamjee Life runs TWO different processes and they must not be mixed:
#   • Premium Renewal  — collect the next scheduled premium of a policy that stays
#                        in force (Individual, Family). Paying year-2 of a 20-year
#                        policy is NOT a renewal of the contract.
#   • Contract Renewal — renew cover for another contractual term (Corporate Group
#                        Life at master-policy level — see group_renewal.py — and
#                        eligible annually renewable individual products).
# Which products renew as a contract is a product term, so it is configured per
# product; every default below is a placeholder to replace with contract terms.
RENEWAL_DEFAULT_RULES: dict = {
    # True → the product's cover expires at the end of each period and must be
    # renewed (Contract Renewal). False → ordinary Premium Renewal only.
    "contract_renewable": False,
    "renewal_term_years": 1,
    # Adamjee sends the renewal notice and SMS one month before the premium due date.
    "notice_days": int(_os.environ.get("RENEWAL_NOTICE_DAYS", "30")),
    # Contract renewals only.
    "max_renewal_age": int(_os.environ.get("RENEWAL_MAX_AGE", "65")),      # age at renewal date
    "reassess_from_age": int(_os.environ.get("RENEWAL_REASSESS_AGE", "55")),  # at/after → underwriting
    "stp_max_claims": int(_os.environ.get("RENEWAL_STP_MAX_CLAIMS", "0")),    # claims in the period beyond which → underwriting
    # Force an underwriting evaluation even on an ordinary premium renewal.
    "reassessment_required": False,
    "max_loading_pct": float(_os.environ.get("RENEWAL_MAX_LOADING_PCT", "300")),
}

RENEWAL_PRODUCT_RULES: dict[str, dict] = {
    # Keyed by lower-cased product name, e.g. an annually renewable product:
    # "salary protection plan": {"contract_renewable": True, "max_renewal_age": 60},
}

RENEWAL_NOTICE_CHANNELS: list[str] = ["Email", "SMS", "WhatsApp", "Letter"]


def renewal_rules(product_name: str | None) -> dict:
    """Renewal rules in force for a product (override merged over the default)."""
    rules = dict(RENEWAL_DEFAULT_RULES)
    rules.update(RENEWAL_PRODUCT_RULES.get((product_name or "").strip().lower(), {}))
    return rules


# ── Stage B claims management (step 8) ────────────────────────────────────────
# Claims are INDEPENDENT of reinstatement and renewals: a claim can arise whenever
# the relevant cover applies, and a policy that is lapsed or closed today may still
# owe a valid claim for an event that happened while cover was in force.
# Adamjee publishes the process (intimation → documents → verification → decision,
# normally 5–7 working days after COMPLETE documents) and separate individual and
# group claim forms, but not the exact checklists, waiting periods or benefit
# formulas — every number and checklist below is a configurable PLACEHOLDER to be
# aligned with the product wording and the published forms.
CLAIM_CATEGORIES: dict[str, dict] = {
    "Death": {
        "label": "Death Claim", "claim_type": "Death Claim", "applies": "Individual, Family, Corporate",
        "insurance_types": ["TERM_LIFE", "WHOLE_LIFE", "ENDOWMENT", "SAVINGS", "SINGLE_PREMIUM",
                            "CHILD_EDUCATION_MARRIAGE", "GROUP_LIFE"],
        "rider_keywords": [], "terminates_policy": True,
    },
    "AccidentalDeath": {
        "label": "Accidental Death Claim", "claim_type": "Accidental Death Claim",
        "applies": "Policies with accidental-death cover", "insurance_types": [],
        "rider_keywords": ["accidental death"], "terminates_policy": True,
    },
    "Disability": {
        "label": "Disability Claim", "claim_type": "Disability Claim", "applies": "Policies with a disability benefit",
        "insurance_types": [], "rider_keywords": ["disability"], "terminates_policy": False,
    },
    "Hospitalization": {
        "label": "Hospitalization / Reimbursement", "claim_type": "Hospitalization / Reimbursement",
        "applies": "Only plans providing hospitalization benefits",
        "insurance_types": ["HEALTH_CASH", "FAMILY_FLOATER"], "rider_keywords": ["hospital"], "terminates_policy": False,
    },
}

CLAIM_CAUSES: list[str] = ["Natural / illness", "Accident", "Suicide", "Other unnatural"]
CLAIM_CHANNELS: list[str] = ["Branch", "Phone", "Email", "Portal", "Agent"]
CLAIM_CLAIMANT_RELATIONSHIPS: list[str] = ["Self", "Spouse", "Child", "Parent", "Sibling", "Legal heir", "Employer", "Representative"]
CLAIM_COVERED_RELATIONSHIPS: list[str] = ["Self", "Spouse", "Child", "Parent"]
CLAIM_PAYOUT_METHODS: list[str] = ["Bank Transfer", "Pay Order", "JazzCash", "Easypaisa"]

CLAIM_DECISION_SLA_WORKING_DAYS: int = int(_os.environ.get("CLAIM_DECISION_SLA_DAYS", "7"))   # Adamjee: 5–7 working days
CLAIM_PUBLIC_HOLIDAYS: list[str] = []          # ISO dates excluded from working-day counts
CLAIM_MANAGER_LIMIT: float = float(_os.environ.get("CLAIM_MANAGER_LIMIT", "500000"))   # same threshold routers/claims.py enforces
CLAIM_CONTESTABLE_DAYS: int = int(_os.environ.get("CLAIM_CONTESTABLE_DAYS", "730"))    # matches routers/claims._claim_dict
CLAIM_EARLY_CLAIM_DAYS: int = int(_os.environ.get("CLAIM_EARLY_CLAIM_DAYS", "365"))    # a death this soon after cover starts is investigated
CLAIM_LATE_REPORT_DAYS: int = int(_os.environ.get("CLAIM_LATE_REPORT_DAYS", "90"))
CLAIM_SUICIDE_EXCLUSION_DAYS: int = int(_os.environ.get("CLAIM_SUICIDE_EXCLUSION_DAYS", "365"))
CLAIM_WAITING_PERIOD_DAYS: dict[str, int] = {"Hospitalization": int(_os.environ.get("CLAIM_HOSPITAL_WAITING_DAYS", "30"))}  # illness only
CLAIM_COPAY_PCT: float = float(_os.environ.get("CLAIM_COPAY_PCT", "0"))
CLAIM_FUZZY_NAME_MATCH: float = 0.6            # payee vs bank-account-title similarity needed to avoid a flag

# Checklist items. `when` conditions: always | individual | group | illness | accident_or_unnatural |
# claimant_not_nominee | contestable. required=False means "ask only if needed".
_CORE = [
    {"key": "policy_doc", "label": "Original policy document / schedule", "required": True, "when": "always"},
    {"key": "bank_details", "label": "Payee bank account details / cancelled cheque", "required": True, "when": "always"},
]
CLAIM_DOCUMENTS: dict[str, list[dict]] = {
    "Death": [
        {"key": "claim_form", "label": "Death Claim Form (individual / family)", "required": True, "when": "individual"},
        {"key": "claim_form", "label": "Group Life Claim Form (employer)", "required": True, "when": "group"},
        {"key": "employer_cert", "label": "Employer's certificate of employment and cover", "required": True, "when": "group"},
        {"key": "claimant_cnic", "label": "Claimant's CNIC (copy)", "required": True, "when": "always"},
        {"key": "deceased_cnic", "label": "Deceased's CNIC (copy)", "required": True, "when": "always"},
        {"key": "death_certificate", "label": "Death certificate (NADRA / union council)", "required": True, "when": "always"},
        {"key": "medical_records", "label": "Hospital records / attending physician's statement", "required": True, "when": "illness"},
        {"key": "police_report", "label": "Police report / FIR", "required": True, "when": "accident_or_unnatural"},
        {"key": "postmortem", "label": "Post-mortem report", "required": True, "when": "accident_or_unnatural"},
        {"key": "legal_heir", "label": "Legal heir / succession certificate", "required": True, "when": "claimant_not_nominee"},
        {"key": "prior_treatment", "label": "Prior treatment records (contestability review)", "required": True, "when": "contestable"},
    ] + _CORE,
    "AccidentalDeath": [
        {"key": "claim_form", "label": "Accidental Death Claim Form", "required": True, "when": "always"},
        {"key": "claimant_cnic", "label": "Claimant's CNIC (copy)", "required": True, "when": "always"},
        {"key": "deceased_cnic", "label": "Deceased's CNIC (copy)", "required": True, "when": "always"},
        {"key": "death_certificate", "label": "Death certificate (NADRA / union council)", "required": True, "when": "always"},
        {"key": "police_report", "label": "Police report / FIR", "required": True, "when": "always"},
        {"key": "postmortem", "label": "Post-mortem report", "required": True, "when": "always"},
        {"key": "accident_statement", "label": "Statement of the accident circumstances", "required": True, "when": "always"},
        {"key": "legal_heir", "label": "Legal heir / succession certificate", "required": True, "when": "claimant_not_nominee"},
    ] + _CORE,
    "Disability": [
        {"key": "claim_form", "label": "Disability Claim Form", "required": True, "when": "always"},
        {"key": "insured_cnic", "label": "Insured's CNIC (copy)", "required": True, "when": "always"},
        {"key": "medical_certificate", "label": "Specialist / medical-board disability certificate", "required": True, "when": "always"},
        {"key": "treatment_records", "label": "Treatment records and investigation reports", "required": True, "when": "always"},
        {"key": "accident_report", "label": "Police / medico-legal report of the accident", "required": True, "when": "accident_or_unnatural"},
        {"key": "employer_statement", "label": "Employer's statement on the loss of income", "required": False, "when": "always"},
    ] + _CORE,
    "Hospitalization": [
        {"key": "claim_form", "label": "Hospitalization / Reimbursement Claim Form", "required": True, "when": "always"},
        {"key": "insured_cnic", "label": "Patient's CNIC / B-form (copy)", "required": True, "when": "always"},
        {"key": "discharge_summary", "label": "Hospital discharge summary", "required": True, "when": "always"},
        {"key": "hospital_bills", "label": "Original hospital bills and receipts", "required": True, "when": "always"},
        {"key": "investigation_reports", "label": "Laboratory / radiology investigation reports", "required": True, "when": "always"},
        {"key": "prescriptions", "label": "Prescriptions / medicine bills", "required": False, "when": "always"},
        {"key": "doctor_certificate", "label": "Treating doctor's certificate", "required": False, "when": "always"},
        {"key": "prior_treatment", "label": "Prior treatment records (contestability review)", "required": True, "when": "contestable"},
    ] + [d for d in _CORE if d["key"] != "policy_doc"],
}

# Requirements for a payee to be accepted for disbursement.
CLAIM_IBAN_PATTERN = r"^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$"


# ── Stage B policy maturity & exit (step 9) ───────────────────────────────────
# Four exits: Maturity (a savings / investment-linked policy reaches maturity — pay the
# maturity proceeds), Expiry (a protection-only term ends — close without a payout), Surrender
# (the policyholder leaves early — pay the eligible net surrender value) and CorporateExpiry
# (a group certificate's master policy was not renewed). A death benefit is settled by
# Claims Management; this module only closes the policy afterwards (DeathClaimClosure).
#
# Adamjee states that maturity benefits depend on the policy terms and, for unit-linked plans,
# are the cash value less indebtedness and recoverable amounts. Published surrender terms
# now live on InsurancePlan.surrender_terms as sourced catalog references; this engine
# does not yet apply them. Without real unit holdings/prices and contract-version matching,
# every figure below remains a configurable PLACEHOLDER: the "fund" is premiums,
# net of an allocation charge, accumulated at an assumed
# rate — replace `fund_value()` with the real unit-price feed when it exists.
EXIT_PROFILE_BY_TYPE: dict[str, str] = {
    "SAVINGS": "Savings", "ENDOWMENT": "Savings", "WHOLE_LIFE": "Savings",
    "CHILD_EDUCATION_MARRIAGE": "Savings", "SINGLE_PREMIUM": "Savings",
    "TERM_LIFE": "Protection", "HEALTH_CASH": "Protection", "FAMILY_FLOATER": "Protection",
    "GROUP_LIFE": "Group",
}
EXIT_PROFILE_BY_PRODUCT: dict[str, str] = {
    # "protect plan": "Protection",     # keyed by lower-cased product name
}
EXIT_DEFAULT_RULES: dict = {
    "maturity_window_days": int(_os.environ.get("EXIT_MATURITY_WINDOW_DAYS", "90")),   # start identifying this far ahead
    "allocation_pct": float(_os.environ.get("EXIT_ALLOCATION_PCT", "95")),             # share of each premium that is invested
    "assumed_growth_pct": float(_os.environ.get("EXIT_ASSUMED_GROWTH_PCT", "4")),      # annual, compounded daily-count/365
    "maturity_guarantee_pct": float(_os.environ.get("EXIT_MATURITY_GUARANTEE_PCT", "0")),   # floor as % of sum assured (0 = none)
    "surrender_min_years": int(_os.environ.get("EXIT_SURRENDER_MIN_YEARS", "2")),
    # completed policy years → % of the fund value payable on surrender (largest key ≤ years).
    "surrender_factors": {2: 50.0, 3: 60.0, 4: 70.0, 5: 80.0, 7: 90.0, 10: 100.0},
    "quote_valid_days": int(_os.environ.get("EXIT_QUOTE_VALID_DAYS", "15")),
    "withholding_pct": float(_os.environ.get("EXIT_WITHHOLDING_PCT", "0")),           # tax treatment is not public — off by default
    "dual_control_limit": float(_os.environ.get("EXIT_DUAL_CONTROL_LIMIT", "1000000")),   # above this the authoriser must differ from the calculator
}
EXIT_PRODUCT_RULES: dict[str, dict] = {}        # per product, lower-cased name → overrides

EXIT_DECLARATIONS: dict[str, list[dict]] = {
    "Maturity": [
        {"key": "owner", "text": "I confirm that I am the policyholder and the person entitled to the maturity proceeds."},
        {"key": "closure", "text": "I understand that cover ends when the maturity benefit is paid and the policy will be closed."},
    ],
    "Surrender": [
        {"key": "owner", "text": "I confirm that I am the policyholder and am entitled to surrender this policy."},
        {"key": "loss_of_cover", "text": "I understand that surrender ends all cover and benefits under the policy, and it cannot be reinstated afterwards."},
        {"key": "charges", "text": "I understand that surrender charges and recoverable amounts are deducted and that the amount paid may be less than the premiums I paid."},
        {"key": "tax", "text": "I understand that the proceeds may be subject to tax."},
    ],
}
EXIT_DOCUMENTS: dict[str, list[dict]] = {
    "Maturity": [
        {"key": "claim_form", "label": "Maturity claim form (Adamjee Life)", "required": True},
        {"key": "cnic", "label": "Policyholder's CNIC (copy)", "required": True},
        {"key": "policy_doc", "label": "Original policy document (or an indemnity bond if lost)", "required": True},
        {"key": "bank_details", "label": "Bank account details / cancelled cheque", "required": True},
    ],
    "Surrender": [
        {"key": "surrender_form", "label": "Surrender request form (Adamjee Life)", "required": True},
        {"key": "cnic", "label": "Policyholder's CNIC (copy)", "required": True},
        {"key": "policy_doc", "label": "Original policy document (or an indemnity bond if lost)", "required": True},
        {"key": "bank_details", "label": "Bank account details / cancelled cheque", "required": True},
    ],
}
EXIT_CONSENT_METHODS: list[str] = ["Signed form", "Portal", "Branch (in person)", "Phone (recorded)"]
EXIT_PAYOUT_METHODS: list[str] = ["Bank Transfer", "Pay Order", "JazzCash", "Easypaisa"]


def exit_profile(product_name: str | None, insurance_type: str | None) -> str:
    """Savings | Protection | Group — what the product pays at its end."""
    key = (product_name or "").strip().lower()
    return EXIT_PROFILE_BY_PRODUCT.get(key) or EXIT_PROFILE_BY_TYPE.get(insurance_type or "", "Protection")


def exit_rules(product_name: str | None) -> dict:
    rules = dict(EXIT_DEFAULT_RULES)
    rules.update(EXIT_PRODUCT_RULES.get((product_name or "").strip().lower(), {}))
    return rules
