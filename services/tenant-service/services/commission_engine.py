"""Receipt-backed earnings, posted in the caller's transaction.

No network/LLM calls and no commits here. Configuration failures are durable
exceptions, so a successful premium collection never needs a guessed rate.
"""
from datetime import datetime
from uuid import NAMESPACE_URL, uuid5

from sqlmodel import select
from shared.commissions.calculator import allocate, money, policy_year
from shared.models.core import AcquisitionSource, Customer, Policy, PremiumReceipt, PremiumSchedule
from shared.models.commission import CommissionAccrual, CommissionAgreement, CommissionAssignment, CommissionEarning


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
        if not assignments:
            raise ValueError("No producer agreement assigned to this policy")
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
