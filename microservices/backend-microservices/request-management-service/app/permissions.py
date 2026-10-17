"""What each role may do in Request Management.

Roles are the platform's role names (tenant-service Role.name, seeded in role_seed.py); a user's role always comes
from the verified session, never from the request. Unknown roles get nothing. SuperAdmin has no tenant and gets no
business capability here: platform administration is not business approval.

Per request type (app/types/registry.py) the type lists who may submit and who may review. On top of that:
  * TENANT_ADMIN_ROLES manage routing for their tenant, reassign requests and see the tenant-wide and overdue queues.
  * Nobody may decide their own request, whatever their roles (separation of duties).
"""

TENANT_ADMIN_ROLES = frozenset({"Admin"})

# Roles that hold a tenant seat and may use the module at all (read their own requests, notifications).
KNOWN_ROLES = frozenset({"Admin", "Underwriter", "ClaimsAdjuster", "ClaimsManager", "Agent", "Broker", "Viewer"})


def is_tenant_admin(role: str) -> bool:
    return role in TENANT_ADMIN_ROLES


def is_known_role(role: str) -> bool:
    return role in KNOWN_ROLES
