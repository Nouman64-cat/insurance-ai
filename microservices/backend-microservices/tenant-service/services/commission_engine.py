"""Receipt-backed earnings, posted in the caller's transaction.

No network/LLM calls and no commits here. Rates come from the RS-COM-002 rule
set; configuration failures are durable exceptions, so a successful premium
collection never needs a guessed rate.
"""
from datetime import datetime
from uuid import NAMESPACE_URL, uuid5

from sqlmodel import select
from services.agent_commission import AGENT_COMMISSION_RULE_SET_CODE, commission_context, commission_rate
from shared.commissions.calculator import allocate, disburse_date, money, policy_year
from shared.models.core import AcquisitionSource, Customer, User, Policy, PremiumReceipt, PremiumSchedule
from shared.models.commission import CommissionAccrual, CommissionAssignment, CommissionEarning


async def automatic_assignment(session, policy, configuration=None):
    """Resolve the customer's assigned agent's AGENT source. Return an unsaved 100% allocation.

    Never guess between namesakes or producers. The caller holds the policy lock
    and only persists after successful calculation. Rates come from RS-COM-002.
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
    # System allocation: recorded against the agent's own login.
    return CommissionAssignment(tenant_id=policy.tenant_id, policy_id=policy.id,
        source_id=(preferred or sources)[0].id, split_pct=100, created_by=agent.id)


async def resolve_allocation(session, policy, schedule, base_amount):
    """Who earns what on one premium of `base_amount` against `schedule`.

    Returns (policy_year, installment, automatic, assignments, resolved, amounts) where
    resolved is [(assignment, source, decision, context)]. Raises ValueError on missing
    configuration. Writes nothing: posting and previews share this path.
    """
    if policy.master_policy_id or policy.family_policy_id:
        raise ValueError("Group and family allocation is not enabled; no member-level commission posted")
    if str(getattr(policy.status, 'value', policy.status)) not in {
        'Issued', 'Active', 'GracePeriod', 'Lapsed', 'Cancelled', 'Matured', 'Surrendered', 'Expired',
    }:
        raise ValueError("Commission requires an issued policy; a quote or pending payment does not earn commission")
    if not policy.effective_date:
        raise ValueError("Receipt needs a policy inception date and installment")
    if not schedule or schedule.policy_id != policy.id:
        raise ValueError("Receipt installment does not belong to this policy")
    year = policy_year(policy.effective_date, schedule.due_date)
    # The policy's earliest installment is the first premium after issuance (top-ups included).
    installments = list((await session.exec(select(PremiumSchedule.id).where(
        PremiumSchedule.policy_id == policy.id).order_by(PremiumSchedule.due_date, PremiumSchedule.created_at))).all())
    installment = installments.index(schedule.id) + 1
    assignments = list((await session.exec(select(CommissionAssignment).where(
        CommissionAssignment.tenant_id == policy.tenant_id,
        CommissionAssignment.policy_id == policy.id,
    ))).all())
    automatic = not assignments
    if automatic:
        assignments = [await automatic_assignment(session, policy)]
    inputs = []
    resolved = []
    for assignment in assignments:
        source = await session.get(AcquisitionSource, assignment.source_id)
        if not source or source.tenant_id != policy.tenant_id or not source.is_active:
            raise ValueError("Producer is missing or inactive")
        context = commission_context(policy, source, premium=money(base_amount), policy_year=year, installment=installment)
        decision = await commission_rate(session, policy.tenant_id, context)
        inputs.append((source.id, decision["rate"] or 0, assignment.split_pct))
        resolved.append((assignment, source, decision, context))
    return year, installment, automatic, assignments, resolved, allocate(base_amount, inputs)


def payable_from(source, earned_on):
    """The producer's start day-of-month in the month after earning (creation date when unset)."""
    return disburse_date(earned_on, source.start_date or source.created_at.date())


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
        year, installment, automatic, assignments, resolved, amounts = await resolve_allocation(
            session, policy, schedule, receipt.base_amount)
    except ValueError as exc:
        accrual.status, accrual.reason = "EXCEPTION", str(exc)
        session.add(accrual)
        await session.flush()
        return accrual

    payable = [r for r in resolved if r[2]["rate"] is not None]
    if not payable:
        # Not an error: the rule pays this premium nothing. Reconciling after a rule change re-evaluates it.
        accrual.status, accrual.reason = "NOT_APPLICABLE", resolved[0][2]["reason"]
        session.add(accrual)
        await session.flush()
        return accrual
    customer = await session.get(Customer, policy.customer_id)
    if automatic:
        session.add_all(assignments)
    earned_on = receipt.created_at.date()
    for assignment, source, decision, context in payable:
        session.add(CommissionEarning(
            tenant_id=receipt.tenant_id, accrual_id=accrual.id, policy_id=policy.id,
            receipt_id=receipt.id, source_id=source.id,
            rule_set_code=AGENT_COMMISSION_RULE_SET_CODE, rule_code=decision["rule_code"], rule_version=decision["rule_version"],
            disburse_date=payable_from(source, earned_on),
            basis_amount=money(receipt.base_amount), gross_amount=amounts[source.id],
            rate_pct=decision["rate"], split_pct=assignment.split_pct, policy_year=year,
            snapshot={
                "rule_set_code": AGENT_COMMISSION_RULE_SET_CODE, "rule_code": decision["rule_code"],
                "rule_version": decision["rule_version"], "rule_reason": decision["reason"],
                "commission_recurring": decision["recurring"], "withholding_tax_pct": decision["withholding_tax_pct"],
                "is_first_premium": context["is_first_premium"], "installment_number": installment,
                "basis": "RECEIPT_BASE", "basis_description": "Receipt base including fees/duty; excludes surcharge",
                "payee_name": source.name, "payee_code": source.code,
                "channel": source.source_type.value if hasattr(source.source_type, "value") else source.source_type,
                "payout_day_from": "start_date" if source.start_date else "created_at",
                "policy_number": policy.policy_number, "product_name": policy.product_name,
                "customer_name": customer.name if customer else None,
                "receipt_no": receipt.receipt_no, "receipt_date": receipt.created_at.isoformat(),
                "schedule_id": str(schedule.id), "due_date": schedule.due_date.isoformat(),
                "allocation_method": 'AUTO_AGENT' if automatic else 'POLICY_ASSIGNMENT',
            },
        ))
    # Compatibility for receipt consumers: retain the actual posted gross total,
    # without the old hard-coded agent commission. Multi-payee identity lives in
    # the earnings ledger, not in this legacy single-agent column.
    receipt.commission_amount = float(sum(amounts[source.id] for _, source, _, _ in payable))
    receipt.commission_pct = float(sum(d["rate"] * a.split_pct / 100 for a, _, d, _ in payable))
    receipt.commission_agent_id = str(payable[0][1].user_id or payable[0][1].id) if len(payable) == 1 else None
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
