"""The platform's built-in roles.

Code across the system recognises these by name (verify_admin, the chat agent's
permission matrix, the portal's menus…), so they are seeded once at startup. A
SuperAdmin may rename or delete them (losing the access tied to the name);
only SuperAdmin itself is locked, so the platform console can't be lost.
"""

LOCKED_ROLE_NAME = "SuperAdmin"

SEED_ROLES = [
    ("SuperAdmin",  "Platform-level access — create tenants and bootstrap their first Admin."),
    ("Admin",       "Full tenant access — manage that tenant's users and configuration. Claims: configuration and oversight only, no claim decisions or payments."),
    ("Underwriter", "Evaluate proposals, review risk assessments, and make decisions."),
    ("ClaimsAdjuster", "Triage claims, verify documentation, evaluate benefit eligibility and issue payouts."),
    ("ClaimsManager",  "Run the claims department: register and assign claims, approve and authorise settlements within delegated authority, manage referrals."),
    ("Finance",     "Verify payment details and execute approved claim payments. Cannot approve claims."),
    ("Agent",       "Submit proposals and track their status."),
    ("Viewer",      "Read-only access to dashboards and reports."),
]

SYSTEM_ROLE_NAMES = frozenset(name for name, _ in SEED_ROLES)
