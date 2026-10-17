"""How existing approval flows could join Request Management later, without two engines authorizing one action.

Today these flows keep their own approvals, and Request Management does NOT take part in them:

  Underwriting decision   tenant-service PATCH /tenants/{t}/cases/{id}/status (routers/cases.py), with the gate and
                          decision rules in decision_status.py and family_approval.py. Reviewed in the Underwriting
                          Workbench.
  Claim approval / payout tenant-service PATCH /tenants/{t}/claims/{id}/status and POST .../payout (routers/claims.py).
  Commission agreement    tenant-service POST /tenants/{t}/commissions/agreements/{id}/approve (routers/commissions.py):
  maker-checker           a different administrator must approve a DRAFT agreement.
  Commission payouts      no backend approval exists yet (the portal's payout-run screens are illustrative).

To bring one of them in, write an adapter and register it as the request type's execution handler (workers.HANDLERS)
— and, in the same change, make the owning service's own endpoint refuse that action unless it arrives from this
adapter (for example by requiring the signed service call and an approved execution key). Until both halves exist,
the flow stays where it is: an approval here must never be a second, independent authorization of the same action.
"""
from typing import Protocol
from uuid import UUID


class ApprovalAdapter(Protocol):
    """Carries out one approved request in its owning service.

    Must be idempotent on `execution_key` (a retry after a crash returns the first result), must send the requester
    and approver so the owner can re-check them, and must report a changed record as a conflict instead of
    overwriting it. Return codes map to execution outcomes in workers.Outcome.
    """

    operation: str

    async def execute(self, *, tenant_id: UUID, request_id: UUID, revision_no: int, execution_key: str,
                      requested_by: UUID, approved_by: UUID, payload: dict, snapshot: dict) -> "object": ...


# Operations with a real, owner-side implementation. Anything else is not executable.
SUPPORTED_OPERATIONS = {
    "customer.profile_correction": "tenant-service routers/request_management_internal.py (allowlisted fields, conflict check, idempotent)",
}
