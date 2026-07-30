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
