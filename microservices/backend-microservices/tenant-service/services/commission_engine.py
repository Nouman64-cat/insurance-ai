"""Receipt-backed earnings, posted in the caller's transaction.

No network/LLM calls and no commits here. Configuration failures are durable
exceptions, so a successful premium collection never needs a guessed rate.
"""
from datetime import datetime
from uuid import NAMESPACE_URL, uuid5

from sqlmodel import select
from shared.commissions.calculator import allocate, money, policy_year
from shared.models.core import AcquisitionSource, Customer, User, InsurancePlan, Policy, PremiumReceipt, PremiumSchedule
from shared.models.commission import CommissionAccrual, CommissionAgreement, CommissionAssignment, CommissionEarning, CommissionPlanRule


async def automatic_assignment(session, policy, on_date, configuration=None):
    """Resolve an exact plan and assigned agent. Return an unsaved allocation.

    Never guess between namesakes, producers or overlapping contracts. The caller
    holds the policy lock and only persists after successful calculation.
    """
    customer = configuration['customers'].get(policy.customer_id) if configuration else await session.get(Customer, policy.customer_id)
    if not customer or customer.tenant_id != policy.tenant_id or not customer.assigned_agent_id:
        raise ValueError('Customer needs an assigned agent for automatic commission')
    agent = configuration['users'].get(customer.assigned_agent_id) if configuration else await session.get(User, customer.assigned_agent_id)
    if not agent or agent.tenant_id != policy.tenant_id or not agent.is_active or str(getattr(agent.status, 'value', agent.status)) != 'ACTIVE':
        raise ValueError('Assigned agent is missing or inactive')
    sources = [s for s in configuration['sources'].values() if s.user_id == agent.id and s.is_active
        and str(getattr(s.source_type, 'value', s.source_type)) == 'AGENT'] if configuration else (await session.exec(select(AcquisitionSource).where(
        AcquisitionSource.tenant_id == policy.tenant_id,
        AcquisitionSource.user_id == agent.id, AcquisitionSource.is_active == True,
        AcquisitionSource.source_type == 'AGENT'))).all()
    preferred = [s for s in sources if s.id == customer.acquisition_source_id]
    if len(preferred or sources) != 1:
        raise ValueError('Assigned agent needs one unambiguous active AGENT acquisition source')
    source = (preferred or sources)[0]
    plans = [p for p in configuration['plans'] if p.insurance_type == policy.insurance_type
        and str(getattr(p.category, 'value', p.category)) == 'Individual'] if configuration else (await session.exec(select(InsurancePlan).where(
        InsurancePlan.tenant_id == policy.tenant_id,
        InsurancePlan.insurance_type == policy.insurance_type,
        InsurancePlan.category == 'Individual'))).all()
    name = policy.product_name.strip().casefold()
    matches = [p for p in plans if name in (p.label.strip().casefold(), p.code.strip().casefold())]
    if len(matches) != 1:
        raise ValueError('Policy needs an unambiguous catalog plan for automatic commission')
    plan = matches[0]
    contracts = [configuration['agreements'][r.agreement_id] for r in configuration['rules']
        if r.plan_id == plan.id and r.agreement_id in configuration['agreements']
        and configuration['agreements'][r.agreement_id].status == 'APPROVED'
        and configuration['agreements'][r.agreement_id].effective_from <= on_date] if configuration else (await session.exec(select(CommissionAgreement).join(
        CommissionPlanRule, CommissionPlanRule.agreement_id == CommissionAgreement.id).where(
            CommissionPlanRule.tenant_id == policy.tenant_id, CommissionPlanRule.plan_id == plan.id,
            CommissionAgreement.tenant_id == policy.tenant_id,
            CommissionAgreement.status == 'APPROVED', CommissionAgreement.effective_from <= on_date))).all()
    latest = max((a.effective_from for a in contracts), default=None)
    eligible = [a for a in contracts if a.effective_from == latest]
    if len(eligible) != 1:
        raise ValueError('No unique approved plan commission agreement applies on the receipt date')
    agreement = eligible[0]
    if agreement.effective_to and on_date > agreement.effective_to:
        raise ValueError('Latest plan commission agreement has expired; no fallback rate applied')
    if agreement.basis != 'RECEIPT_BASE':
        raise ValueError('Unsupported commission basis')
    return CommissionAssignment(tenant_id=policy.tenant_id, policy_id=policy.id,
        source_id=source.id, agreement_id=agreement.id, split_pct=100,
        created_by=agreement.created_by), plan


async def accrue_receipt(session, receipt):
    await session.flush()
    # All commission writes for a policy (including assignment changes) use this
    # lock. Duplicate receipt delivery serializes before checking the unique key.
    policy = (await session.exec(select(Policy).where(
        Policy.id == receipt.policy_id, Policy.tenant_id == receipt.tenant_id,
    ).with_for_update())).one()
    accrual = (await session.exec(select(CommissionAccrual).where(
        CommissionAccrual.tenant_id == receipt.tenant_id,
        CommissionAccrual.receipt_id == receipt.id,
    ))).first()
    if accrual and accrual.status == "POSTED":
        return accrual
    if accrual is None:
        accrual = CommissionAccrual(tenant_id=receipt.tenant_id, policy_id=policy.id, receipt_id=receipt.id)
        session.add(accrual)
    try:
        if policy.master_policy_id or policy.family_policy_id:
            raise ValueError("Group and family allocation is not enabled; no member-level commission posted")
        if not policy.effective_date or not receipt.schedule_id:
            raise ValueError("Receipt needs a policy inception date and installment")
        schedule = await session.get(PremiumSchedule, receipt.schedule_id)
        if not schedule or schedule.policy_id != policy.id:
            raise ValueError("Receipt installment does not belong to this policy")
        year = policy_year(policy.effective_date, schedule.due_date)
        assignments = list((await session.exec(select(CommissionAssignment).where(
            CommissionAssignment.tenant_id == receipt.tenant_id,
            CommissionAssignment.policy_id == policy.id,
        ))).all())
        automatic_plan = None
        if not assignments:
            allocation, automatic_plan = await automatic_assignment(session, policy, receipt.created_at.date())
            assignments = [allocation]
        inputs = []
        resolved = []
        for assignment in assignments:
            agreement = await session.get(CommissionAgreement, assignment.agreement_id)
            source = await session.get(AcquisitionSource, assignment.source_id)
            if not agreement or agreement.tenant_id != receipt.tenant_id or agreement.status != "APPROVED":
                raise ValueError("Producer agreement is missing or not approved")
            if not source or source.tenant_id != receipt.tenant_id or not source.is_active:
                raise ValueError("Producer is missing or inactive")
            on_date = receipt.created_at.date()
            if on_date < agreement.effective_from or (agreement.effective_to and on_date > agreement.effective_to):
                raise ValueError("Receipt date is outside the producer agreement's effective period")
            if agreement.basis != "RECEIPT_BASE":
                raise ValueError("Unsupported commission basis")
            rate = agreement.first_year_pct if year == 1 else agreement.renewal_pct
            inputs.append((source.id, rate, assignment.split_pct))
            resolved.append((assignment, agreement, source, rate))
        amounts = allocate(receipt.base_amount, inputs)
    except ValueError as exc:
        accrual.status, accrual.reason = "EXCEPTION", str(exc)
        session.add(accrual)
        await session.flush()
        return accrual

    customer = await session.get(Customer, policy.customer_id)
    if automatic_plan:
        session.add_all(assignments)
    for assignment, agreement, source, rate in resolved:
        session.add(CommissionEarning(
            tenant_id=receipt.tenant_id, accrual_id=accrual.id, policy_id=policy.id,
            receipt_id=receipt.id, source_id=source.id, agreement_id=agreement.id,
            basis_amount=money(receipt.base_amount), gross_amount=amounts[source.id],
            rate_pct=rate, split_pct=assignment.split_pct, policy_year=year,
            snapshot={
                "agreement_code": agreement.code, "agreement_version": agreement.version,
                "basis": agreement.basis, "basis_description": "Receipt base including fees/duty; excludes surcharge",
                "payee_name": source.name, "payee_code": source.code,
                "channel": source.source_type.value if hasattr(source.source_type, "value") else source.source_type,
                "policy_number": policy.policy_number, "product_name": policy.product_name,
                "customer_name": customer.name if customer else None,
                "receipt_no": receipt.receipt_no, "receipt_date": receipt.created_at.isoformat(),
                "schedule_id": str(schedule.id), "due_date": schedule.due_date.isoformat(),
                "approved_by": str(agreement.approved_by),
                "allocation_method": 'AUTO_PLAN' if automatic_plan else 'POLICY_ASSIGNMENT',
                "plan_id": str(automatic_plan.id) if automatic_plan else None,
            },
        ))
    # Compatibility for receipt consumers: retain the actual posted gross total,
    # without the old hard-coded agent commission. Multi-payee identity lives in
    # the earnings ledger, not in this legacy single-agent column.
    receipt.commission_amount = float(sum(amounts.values()))
    receipt.commission_pct = float(sum(rate * assignment.split_pct / 100 for assignment, _, _, rate in resolved))
    receipt.commission_agent_id = str(resolved[0][2].user_id or resolved[0][2].id) if len(resolved) == 1 else None
    session.add(receipt)
    accrual.status, accrual.reason = "POSTED", None
    session.add(accrual)
    await session.flush()
    return accrual


async def record_binding_receipt(session, policy, detail):
    """One receipt for the first settled installment, including credited IPP.
    The stable ID prevents an IPP credit and binding replay becoming two receipts.
    We deliberately do not backfill old Active policies from their status.
    """
    await session.flush()
    schedule = (await session.exec(select(PremiumSchedule).where(
        PremiumSchedule.policy_id == policy.id,
    ).order_by(PremiumSchedule.due_date, PremiumSchedule.created_at))).first()
    if not schedule or schedule.amount_paid <= 0:
        return
    receipt_id = uuid5(NAMESPACE_URL, f"insurance-ai:binding-receipt:{schedule.id}")
    receipt = await session.get(PremiumReceipt, receipt_id)
    if receipt is None:
        receipt = PremiumReceipt(
            id=receipt_id, tenant_id=policy.tenant_id, policy_id=policy.id,
            schedule_id=schedule.id, receipt_no=f"BIND-{schedule.id.hex}",
            base_amount=schedule.amount_paid, surcharge_amount=0,
            total_amount=schedule.amount_paid, method=detail.get("method"),
            payment_reference=detail.get("payment_reference"),
            created_at=schedule.paid_at or datetime.utcnow(),
        )
        session.add(receipt)
    await accrue_receipt(session, receipt)
