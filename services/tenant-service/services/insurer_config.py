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
