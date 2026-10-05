"""The platform's built-in roles.

Code across the system recognises these by name (verify_admin, the chat agent's
permission matrix, the portal's menus…), so they are seeded at startup and
protected from rename / deletion in the role management API.
"""

SEED_ROLES = [
    ("SuperAdmin",  "Platform-level access — create tenants and bootstrap their first Admin."),
    ("Admin",       "Full tenant access — manage that tenant's users and all resources."),
    ("Underwriter", "Evaluate proposals, review risk assessments, and make decisions."),
    ("ClaimsAdjuster", "Triage claims, verify documentation, evaluate benefit eligibility and issue payouts."),
    ("ClaimsManager",  "Oversee claims department, approve high-value claims, manage adjusters and fraud reviews."),
    ("Agent",       "Submit proposals and track their status."),
    ("Viewer",      "Read-only access to dashboards and reports."),
]

SYSTEM_ROLE_NAMES = frozenset(name for name, _ in SEED_ROLES)
