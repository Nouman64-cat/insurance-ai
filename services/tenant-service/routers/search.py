"""
Global search — backs the search box in the web app's top bar.

One GET endpoint that scans the four things a user jumps to by name or
reference number (cases, customers, policies, claims), tenant-scoped, and
returns a flat list of hits each carrying the frontend route to open it.

Deliberately plain `ILIKE` — same idiom as routers/customers.py::list_customers
and routers/claims.py. The pg_trgm GIN indexes added in migrate.py (v48*) keep
the leading-wildcard match off a sequential scan.
"""

import re
from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme
from shared.models.core import Case, Claim, Customer, Policy

router = APIRouter(prefix="/tenants/{tenant_id}/search", tags=["Search"])


class SearchResult(BaseModel):
    type: str          # "case" | "customer" | "policy" | "claim"
    id: str
    title: str
    subtitle: str
    url: str


class SearchResponse(BaseModel):
    results: List[SearchResult]


def _enum_str(value) -> str:
    """Enum column values come back either as the Enum or as the raw string
    depending on the column definition — normalise to the plain string."""
    if value is None:
        return ""
    return getattr(value, "value", str(value))


@router.get("", response_model=SearchResponse, summary="Search cases, customers, policies and claims")
async def global_search(
    tenant_id: UUID,
    q: str = Query(..., min_length=2, description="Free-text query — name, CNIC, or reference number"),
    limit: int = Query(5, ge=1, le=20, description="Max hits per record type"),
    session: AsyncSession = Depends(get_session),
    token: str = Depends(oauth2_scheme),
) -> SearchResponse:
    # Authenticate — any signed-in user of the tenant may search.
    await _get_current_user(token, session)

    term = q.strip()
    like = f"%{term}%"
    # Only treat the query as a CNIC fragment when it is substantially numeric —
    # otherwise a reference like "CASE-2026-E7A3CF" fuzzy-matches every CNIC that
    # happens to contain its stray digits ("73").
    digits = re.sub(r"\D", "", term)
    cnic_digits = digits if len(digits) >= 4 else None

    results: List[SearchResult] = []

    # ── Cases ────────────────────────────────────────────────────────────────
    case_rows = (await session.execute(
        select(Case, Customer.name)
        .join(Customer, Case.customer_id == Customer.id)
        .where(Case.tenant_id == tenant_id)
        .where(or_(Case.caseNumber.ilike(like), Customer.name.ilike(like)))
        .order_by(Case.createdAt.desc())
        .limit(limit)
    )).all()
    for case, customer_name in case_rows:
        results.append(SearchResult(
            type="case",
            id=str(case.caseld),
            title=case.caseNumber,
            subtitle=" · ".join(filter(None, [customer_name, _enum_str(case.caseType)])),
            url=f"/case/{case.caseld}",
        ))

    # ── Customers ────────────────────────────────────────────────────────────
    cnic_match = (
        func.replace(Customer.cnic, "-", "").ilike(f"%{cnic_digits}%")
        if cnic_digits else Customer.cnic.ilike(like)
    )
    customer_rows = (await session.execute(
        select(Customer)
        .where(Customer.tenant_id == tenant_id)
        .where(or_(
            Customer.name.ilike(like),
            cnic_match,
            Customer.policyholder_id.ilike(like),
        ))
        .order_by(Customer.created_at.desc())
        .limit(limit)
    )).scalars().all()
    for c in customer_rows:
        tail = c.policyholder_id or _enum_str(c.profile_status)
        subtitle = " · ".join(filter(None, [f"CNIC {c.cnic}" if c.cnic else None, tail]))
        results.append(SearchResult(
            type="customer",
            id=str(c.id),
            title=c.name,
            subtitle=subtitle,
            url=f"/admin/customers/{c.id}/plans",
        ))

    # ── Policies ─────────────────────────────────────────────────────────────
    policy_rows = (await session.execute(
        select(Policy, Customer.name)
        .join(Customer, Policy.customer_id == Customer.id)
        .where(Policy.tenant_id == tenant_id)
        .where(or_(
            Policy.policy_number.ilike(like),
            Policy.product_name.ilike(like),
            Customer.name.ilike(like),
        ))
        .order_by(Policy.created_at.desc())
        .limit(limit)
    )).all()
    for p, customer_name in policy_rows:
        results.append(SearchResult(
            type="policy",
            id=str(p.id),
            title=p.policy_number or p.product_name,
            subtitle=" · ".join(filter(None, [customer_name, _enum_str(p.insurance_type)])),
            # Issued policies have a post-issuance workspace; a quoted one does
            # not, so fall back to the holder's plans page.
            url=(f"/post-issuance/{p.id}" if p.policy_number else f"/admin/customers/{p.customer_id}/plans"),
        ))

    # ── Claims ───────────────────────────────────────────────────────────────
    claim_rows = (await session.execute(
        select(Claim)
        .where(Claim.tenant_id == tenant_id)
        .where(or_(
            Claim.claim_number.ilike(like),
            Claim.claimant_name.ilike(like),
        ))
        .order_by(Claim.created_at.desc())
        .limit(limit)
    )).scalars().all()
    for cl in claim_rows:
        results.append(SearchResult(
            type="claim",
            id=str(cl.id),
            title=cl.claim_number or f"Claim {str(cl.id)[:8]}",
            subtitle=" · ".join(filter(None, [cl.claimant_name, _enum_str(cl.status)])),
            url=f"/claims/{cl.id}",
        ))

    return SearchResponse(results=results)
