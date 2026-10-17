"""Walk-in customer adapter: endpoints only Customer Management may call (HMAC-signed, CM_TO_TENANT_KEY, caller "customer-management").

A walk-in is a visitor who verified an email address and asked about an insurance plan. This module turns that request into an
ordinary Customer (profile_status LEAD, source "Digital Walk-In") plus a WalkInLead record, hands it to services.lead_routing, and
reports back the customer-safe progress. It never exposes policies, premiums, notes, scores or staff identities beyond the assigned
agent's name and contact line.
"""

import logging
import re
import secrets
from datetime import date, datetime
from typing import Optional
from uuid import UUID

import asyncio
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field as PField
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.artifacts import SUPPORTED_MIME, _upload_to_s3
from routers.customer_portal_internal import signed_by_customer_management
from services import lead_routing as routing
from services import payment_gateway, payment_requests
from services.walkin_profile import FamilyApplication, WalkInProfile, build_details
from shared.models.core import (
    Branch,
    Case,
    Customer,
    Artifact,
    CustomerPortalAccount,
    FamilyGroup,
    FamilyPolicy,
    InitialPremiumPayment,
    IPPStatusEnum,
    InsurancePlan,
    PlanStatusEnum,
    Policy,
    ProfileStatusEnum,
    Tenant,
    User,
    UserProfile,
    WalkInLead,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/internal/customer-portal/v1/walk-in", tags=["Internal: Walk-in"], include_in_schema=False,
                   dependencies=[Depends(signed_by_customer_management)])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^\+?[0-9][0-9 \-]{6,18}$")
PREFERRED = ("Phone", "WhatsApp", "Email", "Any")
CATEGORY_LABEL = {"Individual": "Individual", "Family": "Family", "Group": "Corporate"}


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def plan_public(p: InsurancePlan) -> dict:
    """What a visitor may see about a plan. No premium rates, factors, loadings or internal rules."""
    return {"id": str(p.id), "code": p.code, "label": p.label, "category": CATEGORY_LABEL.get(_v(p.category), _v(p.category)),
            "type": _v(p.insurance_type), "product_category": _v(p.product_category), "description": p.description,
            "entry_age_min": p.entry_age_min, "entry_age_max": p.entry_age_max, "term_min_years": p.term_min_years,
            "term_max_years": p.term_max_years}


@router.get("/tenant")
async def tenant_by_code(code: str, session: AsyncSession = Depends(get_session)) -> dict:
    t = (await session.exec(select(Tenant).where(func.lower(Tenant.code) == code.strip().lower()))).first()
    if t is None or not t.is_active:
        raise _err(404, "TENANT_NOT_FOUND", "Unknown tenant")
    return {"tenant_id": str(t.id), "name": t.name}


@router.get("/plans")
async def list_plans(tenant_id: UUID, session: AsyncSession = Depends(get_session)) -> dict:
    rows = (await session.exec(select(InsurancePlan).where(InsurancePlan.tenant_id == tenant_id, InsurancePlan.status == PlanStatusEnum.ACTIVE, InsurancePlan.is_active.is_(True))
                               .order_by(InsurancePlan.category, InsurancePlan.label))).all()
    return {"plans": [plan_public(p) for p in rows if p.is_active]}


class OtpMail(BaseModel):
    tenant_id: UUID
    email: str = PField(max_length=255)
    code: str = PField(min_length=4, max_length=12)
    minutes: int = 10


@router.post("/otp-email")
async def otp_email(body: OtpMail, session: AsyncSession = Depends(get_session)) -> dict:
    """Mail a verification code. `delivered` is true only when the mail provider accepted the message."""
    if not _EMAIL_RE.match(body.email.strip()):
        raise _err(422, "INVALID_EMAIL", "Enter a valid email address")
    tenant = await session.get(Tenant, body.tenant_id)
    if tenant is None:
        raise _err(404, "TENANT_NOT_FOUND", "Unknown tenant")
    ok = await routing._send(body.email.strip(), f"{tenant.name}: your verification code",
                             f"Your verification code is {body.code}. It expires in {body.minutes} minutes.\n\nIf you did not ask for it, ignore this message.")
    return {"delivered": ok}


class LeadBody(BaseModel):
    tenant_id: UUID
    email: str = PField(max_length=255)                    # the VERIFIED email — set by Customer Management, never the browser
    request_key: str = PField(min_length=8, max_length=80)
    applicant_type: str = "Self"                            # Self | Family
    profile: Optional[WalkInProfile] = None                 # Self: the information the staff "Add New Customer" form collects
    family: Optional[FamilyApplication] = None              # Family: the staff "Add New Family" form (details, policy, members)
    plan_id: UUID
    preferred_contact: str = "Any"
    message: Optional[str] = PField(default=None, max_length=1000)
    consent: bool = False


def _new_reference() -> str:
    return f"WI-{datetime.utcnow().year}-{secrets.token_hex(3).upper()}"


async def _find_existing_customer(session: AsyncSession, tenant_id: UUID, email: str) -> Optional[Customer]:
    """An individual customer whose recorded contact email is this verified address (never family members / employees)."""
    rows = (await session.exec(select(Customer).where(
        Customer.tenant_id == tenant_id, Customer.organization_id.is_(None), Customer.family_group_id.is_(None),
        func.lower(func.coalesce(Customer.details["contact_email"].as_string(), Customer.details["email"].as_string(), "")) == email.lower())
        .order_by(Customer.created_at))).all()
    return rows[0] if rows else None


@router.post("/leads")
async def submit_lead(body: LeadBody, session: AsyncSession = Depends(get_session)) -> dict:
    email = body.email.strip().lower()
    if not body.consent:
        raise _err(422, "CONSENT_REQUIRED", "Consent is required to submit your request")
    if not _EMAIL_RE.match(email):
        raise _err(422, "INVALID_EMAIL", "Enter a valid email address")
    if body.applicant_type not in ("Self", "Family"):
        raise _err(422, "VALIDATION", "Unknown applicant type")
    family = body.applicant_type == "Family"
    prof, fam = body.profile, body.family
    if family and fam is None:
        raise _err(422, "HOUSEHOLD_REQUIRED", "Add the members of your family")
    if not family and prof is None:
        raise _err(422, "VALIDATION", "Your details are required")
    phone_raw = fam.contact_phone if family else prof.mobile_number
    if not _PHONE_RE.match(phone_raw.strip()):
        raise _err(422, "INVALID_PHONE", "Enter a valid mobile number")
    if body.preferred_contact not in PREFERRED:
        raise _err(422, "VALIDATION", "Unknown contact preference")

    # Idempotent: the same request key returns the same lead, and one open request per person and plan.
    prior = (await session.exec(select(WalkInLead).where(WalkInLead.tenant_id == body.tenant_id, WalkInLead.request_key == body.request_key))).first()
    if prior is None:
        prior = (await session.exec(select(WalkInLead).where(
            WalkInLead.tenant_id == body.tenant_id, func.lower(WalkInLead.contact_email) == email, WalkInLead.plan_id == body.plan_id,
            WalkInLead.created_at >= datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)))).first()
    if prior is not None:
        return {"reference": prior.reference, "duplicate": True}

    tenant = await session.get(Tenant, body.tenant_id)
    plan = await session.get(InsurancePlan, body.plan_id)
    if tenant is None or not tenant.is_active:
        raise _err(404, "TENANT_NOT_FOUND", "Unknown tenant")
    if plan is None or plan.tenant_id != body.tenant_id or plan.status != PlanStatusEnum.ACTIVE:
        raise _err(422, "PLAN_UNAVAILABLE", "That plan is not available")

    if family:
        head = next(m for m in fam.members if m.relationship == "Self")
        name, phone, city = (fam.contact_person or head.name).strip(), fam.contact_phone.strip(), fam.city.strip()
    else:
        name, phone, city = f"{prof.first_name} {prof.last_name}".strip(), prof.mobile_number.strip(), prof.city.strip()
    reference = _new_reference()
    walk_in_info = {"reference": reference, "plan_id": str(plan.id), "plan_code": plan.code, "plan_label": plan.label,
                    "plan_category": _v(plan.category), "preferred_contact": body.preferred_contact, "message": body.message,
                    "consent_at": datetime.utcnow().isoformat()}

    if family and _v(plan.category) != "Family":
        raise _err(422, "PLAN_NOT_FOR_FAMILY", "Choose a family plan for a family application")
    if not family and _v(plan.category) == "Family":
        raise _err(422, "PLAN_FOR_FAMILY", "That is a family plan: choose “For my family”")
    term = fam.term_years if family else prof.policy_term
    if term and not (plan.term_min_years <= term <= plan.term_max_years):
        raise _err(422, "VALIDATION", f"This plan's term is {plan.term_min_years}–{plan.term_max_years} years")

    existing = None if family else await _find_existing_customer(session, body.tenant_id, email)
    linked = existing is not None
    group: Optional[FamilyGroup] = None
    if family:
        branches = (await session.exec(select(Branch).where(Branch.tenant_id == body.tenant_id, Branch.is_active.is_(True)))).all()
        branch = next((b for b in branches if (b.city or "").lower() == city.lower()), branches[0] if branches else None)
        group = FamilyGroup(
            tenant_id=body.tenant_id, name=fam.family_name.strip(), contact_person=name, contact_email=email, contact_phone=phone,
            household_declared_income=fam.household_declared_income or head.declared_income,
            branch_id=branch.id if branch else None, acquisition_source_id=(await routing.pool_source(session, body.tenant_id)).id,
            city=city, province=(fam.province or None), profile_status=ProfileStatusEnum.LEAD)
        session.add(group)
        await session.flush()
        customer = group
    elif linked:
        customer = existing
        d = dict(customer.details or {})
        # The customer's own record is not changed: what was submitted is kept beside the request.
        d.setdefault("walk_in_requests", []).append({**walk_in_info, "submitted_profile": prof.model_dump(mode="json")})
        customer.details = d
    else:
        if prof.cnic:
            taken = (await session.exec(select(Customer.id).where(Customer.tenant_id == body.tenant_id, Customer.cnic == prof.cnic))).first()
            if taken is not None:
                raise _err(409, "CNIC_UNAVAILABLE", "We could not accept this CNIC. Leave it blank and your advisor will complete it with you.")
        branches = (await session.exec(select(Branch).where(Branch.tenant_id == body.tenant_id, Branch.is_active.is_(True)))).all()
        branch = next((b for b in branches if (b.city or "").lower() == city.lower()), branches[0] if branches else None)
        details = build_details(prof, email)
        details["lead_source"], details["walk_in"] = "Digital Walk-In", walk_in_info
        if prof.policy_coverage and prof.policy_term:         # same shape the staff form stores, so "Send Draft" works as for any lead
            details["pending_plan"] = {"product_name": plan.label, "insurance_type": _v(plan.insurance_type),
                                       "coverage_amount": prof.policy_coverage, "term_years": prof.policy_term}
        customer = Customer(
            tenant_id=body.tenant_id, name=name, cnic=prof.cnic, dob=prof.date_of_birth, gender=prof.gender, marital_status=prof.marital_status,
            occupation=prof.occupation, declared_income=prof.declared_annual_income, is_smoker=bool(prof.is_smoker),
            height_cm=prof.height_cm or 170.0, weight_kg=prof.weight_kg or 70.0, city=city, province=(prof.province or None),
            profile_status=ProfileStatusEnum.LEAD, branch_id=branch.id if branch else None,
            acquisition_source_id=(await routing.pool_source(session, body.tenant_id)).id, details=details)
    session.add(customer)
    await session.flush()

    lead = WalkInLead(tenant_id=body.tenant_id, customer_id=None if family else customer.id, applicant_type=body.applicant_type,
                      family_group_id=group.id if group else None,
                      household_json=({"family": fam.model_dump(mode="json", exclude={"members"}), "members": [m.model_dump(mode="json", exclude_none=True) for m in fam.members],
                                       "plan": {"id": str(plan.id), "label": plan.label}} if family else None), reference=reference, request_key=body.request_key,
                      plan_id=plan.id, plan_code=plan.code, plan_label=plan.label, plan_category=_v(plan.category),
                      contact_email=email, contact_phone=phone, preferred_contact=body.preferred_contact,
                      message=body.message, consent_at=datetime.utcnow(), linked_existing=linked)
    session.add(lead)
    try:
        await session.flush()
    except IntegrityError:                                                  # a concurrent submit won the race
        await session.rollback()
        again = (await session.exec(select(WalkInLead).where(WalkInLead.tenant_id == body.tenant_id, WalkInLead.request_key == body.request_key))).first()
        if again is None:
            raise
        return {"reference": again.reference, "duplicate": True}
    routing.add_event(session, lead, "Submitted", "customer", plan=plan.label, linked_existing=linked)
    await routing.route_lead(session, lead, customer)
    await session.commit()

    # Notifications are best effort here and retried by the sweep; the lead is already safely saved and assigned (or queued).
    try:
        if lead.routing_status == "Assigned":
            await routing.notify_assigned_agent(session, lead, customer)
        elif lead.routing_status == "Unassigned":
            await routing.alert_staff(session, lead, customer, "Walk-in lead has no available agent")
        await session.commit()
    except Exception:
        await session.rollback()
        log.exception("walk-in notification failed for %s", reference)
    try:
        from main import app as _app                                          # live update for open staff screens
        from services.case_events import publish_data_changed
        await publish_data_changed(getattr(_app.state, "kafka_producer", None), tenant_id=body.tenant_id, resource="customers", method="POST")
    except Exception:
        pass
    return {"reference": reference, "duplicate": False}


# ── status ────────────────────────────────────────────────────────────────────

STAGES = ["Submitted", "Agent Assigned", "In Progress", "Proposal Being Prepared", "Application Under Review", "Payment Due", "Payment Verification", "Underwriting", "Approved", "Policy Issued"]
ISSUED = {"Issued", "Active", "PendingPayment", "GracePeriod"}


async def _stage_inputs(session: AsyncSession, lead: WalkInLead, subject) -> tuple[list, Optional[str]]:
    """The policies and underwriting case that belong to this request, whether it is one person or a household."""
    if lead.family_group_id:
        fp_ids = [x for x in (await session.exec(select(FamilyPolicy.id).where(FamilyPolicy.family_group_id == lead.family_group_id))).all()]
        member_ids = [x for x in (await session.exec(select(Customer.id).where(Customer.family_group_id == lead.family_group_id))).all()]
        pols = (await session.exec(select(Policy).where(Policy.family_policy_id.in_(fp_ids)))).all() if fp_ids else []
        case = (await session.exec(select(Case).where(Case.customer_id.in_(member_ids), Case.createdAt >= lead.created_at).order_by(Case.createdAt.desc()))).first() if member_ids else None
    else:
        pols = (await session.exec(select(Policy).where(Policy.customer_id == subject.id, Policy.created_at >= lead.created_at))).all()
        case = (await session.exec(select(Case).where(Case.customer_id == subject.id, Case.createdAt >= lead.created_at).order_by(Case.createdAt.desc()))).first()
    return list(pols), (_v(case.caseStatus) if case else None)


async def derive_status(session: AsyncSession, lead: WalkInLead, customer) -> dict:
    """Customer-safe progress. A linked existing customer's own policies, cases and status are never consulted or revealed."""
    stage, note, closed = "Submitted", "We received your request.", False
    if lead.routing_status in ("Assigned", "Escalated") and lead.assigned_agent_id:
        stage, note = "Agent Assigned", "An advisor has been assigned to you."
    elif lead.routing_status in ("Unassigned", "Escalated"):
        stage, note = "Submitted", "We are finding the right advisor for you."
    if lead.acknowledged_at:
        stage, note = "In Progress", "Your advisor is working on your request."

    if not lead.linked_existing:
        pols, cstat = await _stage_inputs(session, lead, customer)
        pstat = {_v(p.status) for p in pols}
        if customer.profile_status == ProfileStatusEnum.NOT_INTERESTED:
            stage, note, closed = "In Progress", "This request has been closed.", True
        elif customer.profile_status == ProfileStatusEnum.POLICYHOLDER or pstat & ISSUED:
            stage, note = "Policy Issued", "Your policy has been issued."
        elif cstat == "Approved" or pstat & {"Approved", "AcceptedWithLoadings"}:
            stage, note = "Approved", "Your application was approved."
        elif cstat == "Rejected" or "Declined" in pstat:
            stage, note, closed = "Declined", "We are unable to offer cover for this application.", True
        elif cstat and cstat != "Closed":
            stage, note = "Underwriting", "Your application is being assessed."
        elif not lead.family_group_id and pstat & {"Proposed", "UnderReview"} and (pay := await _open_payment(session, pols)) is not None:
            if pay.proof_status == "Submitted":
                stage, note = "Payment Verification", "We received your payment screenshot and are checking it."
            else:
                stage, note = "Payment Due", "Please pay the initial premium so your application can move on."
        elif pstat & {"Proposed", "UnderReview", "InformationRequested", "CounterOffer"}:
            stage, note = "Application Under Review", "Your application is under review."
        elif "Quoted" in pstat or customer.profile_status in (ProfileStatusEnum.PROSPECT, ProfileStatusEnum.DRAFT, ProfileStatusEnum.UNDERWRITING_READY):
            stage, note = "Proposal Being Prepared", "Your advisor is preparing your proposal."
    return {"stage": stage, "note": note, "closed": closed}


async def _open_payment(session: AsyncSession, pols: list) -> Optional[InitialPremiumPayment]:
    """The initial premium staff have asked this customer to pay and that has not yet been confirmed."""
    ids = [p.id for p in pols]
    if not ids:
        return None
    return (await session.exec(select(InitialPremiumPayment).where(
        InitialPremiumPayment.policy_id.in_(ids), InitialPremiumPayment.request_version > 0,
        InitialPremiumPayment.status != IPPStatusEnum.REALIZED))).first()


async def _payment_block(session: AsyncSession, lead: WalkInLead, customer) -> Optional[dict]:
    if lead.linked_existing or lead.family_group_id:      # the initial-premium step is for individual applications
        return None
    pols = (await session.exec(select(Policy).where(Policy.customer_id == customer.id, Policy.created_at >= lead.created_at))).all()
    pay = await _open_payment(session, list(pols))
    if pay is None:
        return None
    return {"token": payment_requests.make_token(pay), "amount": pay.amount, "proof_status": pay.proof_status,
            "expired": not payment_requests.is_open(pay), "expires_at": pay.request_expires_at.isoformat() if pay.request_expires_at else None}


async def _agent_card(session: AsyncSession, lead: WalkInLead) -> Optional[dict]:
    if not lead.assigned_agent_id or lead.routing_status not in ("Assigned", "Escalated"):
        return None
    u = await session.get(User, lead.assigned_agent_id)
    if u is None:
        return None
    prof = (await session.exec(select(UserProfile).where(UserProfile.user_id == u.id))).first()
    return {"name": u.full_name, "phone": prof.phone if prof else None, "email": u.email}


async def _handoff(session: AsyncSession, lead: WalkInLead, customer) -> dict:
    """Once the walk-in's policy is issued the customer continues in the normal portal (invite-based activation)."""
    if lead.linked_existing:
        return {"available": False}
    account_owner = customer.primary_member_customer_id if lead.family_group_id else customer.id
    acct = (await session.exec(select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == account_owner))).first() if account_owner else None
    return {"available": True, "account_ready": acct is not None}


def lead_view(lead: WalkInLead, owner_customer_id: Optional[UUID] = None) -> dict:
    return {"customer_id": str(owner_customer_id or lead.customer_id) if (owner_customer_id or lead.customer_id) else None, "applicant_type": lead.applicant_type, "reference": lead.reference, "plan": {"id": str(lead.plan_id) if lead.plan_id else None, "label": lead.plan_label, "category": lead.plan_category},
            "submitted_at": lead.created_at.isoformat(), "preferred_contact": lead.preferred_contact}


@router.get("/leads")
async def my_leads(tenant_id: UUID, email: str, session: AsyncSession = Depends(get_session)) -> dict:
    rows = (await session.exec(select(WalkInLead).where(WalkInLead.tenant_id == tenant_id, func.lower(WalkInLead.contact_email) == email.strip().lower())
                               .order_by(WalkInLead.created_at.desc()))).all()
    out = []
    for lead in rows:
        customer = await routing.subject_of(session, lead)
        out.append({**lead_view(lead, getattr(customer, "primary_member_customer_id", None)), **(await derive_status(session, lead, customer)), "agent": await _agent_card(session, lead),
                    "payment": await _payment_block(session, lead, customer), "handoff": await _handoff(session, lead, customer)})
    return {"leads": out}


# ── paying the initial premium from the customer's side ──────────────────────

MAX_PROOF_BYTES = 10 * 1024 * 1024


async def _pay_context(session: AsyncSession, token: str) -> tuple[InitialPremiumPayment, Policy, Customer]:
    ipp = await payment_requests.find_by_token(session, token)
    if ipp is None:
        raise HTTPException(404, detail={"code": "PAY_LINK_INVALID", "message": "This payment link is not valid."})
    policy, customer = await session.get(Policy, ipp.policy_id), await session.get(Customer, (await session.get(Policy, ipp.policy_id)).customer_id)
    return ipp, policy, customer


def _pay_state(ipp: InitialPremiumPayment) -> str:
    if ipp.status == IPPStatusEnum.REALIZED or ipp.proof_status == "Accepted":
        return "Paid"
    if not payment_requests.is_open(ipp):
        return "Expired"
    return {"Submitted": "ProofSubmitted", "Rejected": "Rejected"}.get(ipp.proof_status, "Open")


async def _pay_view(session: AsyncSession, ipp: InitialPremiumPayment, policy: Policy, customer: Customer) -> dict:
    tenant = await session.get(Tenant, ipp.tenant_id)
    paid = _pay_state(ipp) == "Paid"
    return {
        "receipt": await payment_requests.build_receipt(session, ipp) if paid else None,
        "state": _pay_state(ipp), "breakdown": ipp.breakdown_json, "customer_name": customer.name, "plan_label": policy.product_name, "amount": ipp.amount, "reference": ipp.reference,
        "channels": [m["label"] if isinstance(m, dict) else str(m) for m in payment_gateway.available_methods()],
        "insurer": {"name": tenant.name if tenant else None, "phone": getattr(tenant, "contact_phone", None), "email": getattr(tenant, "contact_email", None)},
        "expires_at": ipp.request_expires_at.isoformat() if ipp.request_expires_at else None,
        "proof_uploaded_at": ipp.proof_uploaded_at.isoformat() if ipp.proof_uploaded_at else None, "has_receipt": ipp.proof_artifact_id is not None,
        "proof_method": ipp.proof_method, "proof_reference": ipp.proof_reference,
        "review_note": ipp.proof_review_note if ipp.proof_status == "Rejected" else None,
    }


@router.get("/pay/{token}")
async def pay_details(token: str, session: AsyncSession = Depends(get_session)) -> dict:
    ipp, policy, customer = await _pay_context(session, token)
    return await _pay_view(session, ipp, policy, customer)


def _check_open(ipp: InitialPremiumPayment) -> None:
    state = _pay_state(ipp)
    if state == "Paid":
        raise _err(409, "ALREADY_PAID", "This payment has already been confirmed.")
    if state == "Expired":
        raise _err(410, "PAY_LINK_EXPIRED", "This link has expired. Please ask your advisor for a new one.")


async def _record_claim(session: AsyncSession, ipp: InitialPremiumPayment, policy: Policy, customer: Customer, *, method: Optional[str],
                        reference: Optional[str], note: Optional[str], artifact_id: Optional[UUID]) -> dict:
    """The customer says they have paid (with a receipt, or just by telling us). It shows on staff screens at once and staff are told;
    staff decide whether to confirm it. Nothing is cleared until they do."""
    now = datetime.utcnow()
    ipp.proof_status, ipp.proof_uploaded_at = "Submitted", now
    if artifact_id is not None:
        ipp.proof_artifact_id = artifact_id
    ipp.proof_method = (method or "").strip()[:50] or None
    ipp.proof_reference = (reference or "").strip()[:100] or None
    ipp.proof_note = (note or "").strip()[:500] or None
    ipp.proof_review_note, ipp.proof_reviewed_at, ipp.proof_reviewed_by = None, None, None
    ipp.updated_at = now
    session.add(ipp)
    await session.commit()
    await session.refresh(ipp)
    try:
        await payment_requests.notify_staff_proof(session, ipp, policy, customer)
        await payment_requests.publish_change(ipp.tenant_id)
    except Exception:
        log.exception("could not notify staff about the payment claim for %s", ipp.id)
    return await _pay_view(session, ipp, policy, customer)


class DeclareBody(BaseModel):
    method: Optional[str] = PField(default=None, max_length=50)
    reference: Optional[str] = PField(default=None, max_length=100)
    note: Optional[str] = PField(default=None, max_length=500)


@router.post("/pay/{token}/declare")
async def pay_declare(token: str, body: DeclareBody, session: AsyncSession = Depends(get_session)) -> dict:
    """"I have paid": no receipt attached."""
    ipp, policy, customer = await _pay_context(session, token)
    _check_open(ipp)
    return await _record_claim(session, ipp, policy, customer, method=body.method, reference=body.reference, note=body.note, artifact_id=None)


@router.post("/pay/{token}/proof")
async def pay_upload_proof(token: str, file: UploadFile = File(...), note: Optional[str] = Form(None), method: Optional[str] = Form(None),
                           reference: Optional[str] = Form(None), session: AsyncSession = Depends(get_session)) -> dict:
    """The customer uploads their receipt. Staff are told straight away and decide whether to confirm it."""
    ipp, policy, customer = await _pay_context(session, token)
    _check_open(ipp)
    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext not in SUPPORTED_MIME:
        raise _err(422, "UNSUPPORTED_FILE", "Upload a photo or screenshot (PNG, JPG) or a PDF.")
    data = await file.read()
    if not data:
        raise _err(422, "EMPTY_FILE", "That file is empty.")
    if len(data) > MAX_PROOF_BYTES:
        raise _err(413, "FILE_TOO_LARGE", "That file is too large (10 MB maximum).")

    artifact_id = uuid4()
    safe = (file.filename or f"payment.{ext}").replace("/", "_")[:200]
    key = f"{ipp.tenant_id}/payments/{ipp.id}/{artifact_id}/{safe}"
    try:
        url = await asyncio.get_running_loop().run_in_executor(None, lambda: _upload_to_s3(data, key, SUPPORTED_MIME[ext]))
    except Exception as exc:
        log.exception("payment proof upload failed for %s", ipp.id)
        raise _err(502, "UPLOAD_FAILED", "We could not save that file. Please try again.") from exc
    session.add(Artifact(id=artifact_id, tenant_id=ipp.tenant_id, case_id=ipp.case_id, customer_id=customer.id, source_request_id=ipp.id,
                         document_type="Payment Proof", file_name=safe, file_size=len(data), file_type=SUPPORTED_MIME[ext], storage_url=url, status="Uploaded"))
    return await _record_claim(session, ipp, policy, customer, method=method, reference=reference, note=note, artifact_id=artifact_id)
