import asyncio
from uuid import uuid4
from datetime import datetime, timedelta
import random

from sqlmodel import select

from database import _session_factory
from shared.models.core import (
    Customer,
    Policy,
    PremiumQuote,
    PolicyStatusEnum,
    Tenant,
    InsurancePlan
)
from shared.pricing.calculator import calculate_premium

async def main():
    session_factory = _session_factory
    async with session_factory() as session:
        # Get first tenant
        tenant_stmt = select(Tenant)
        tenant = (await session.exec(tenant_stmt)).first()
        if not tenant:
            print("No tenant found!")
            return
            
        # Get all plans for this tenant
        plans_stmt = select(InsurancePlan).where(InsurancePlan.tenant_id == tenant.id)
        plans = (await session.exec(plans_stmt)).all()
        if not plans:
            print("No plans found!")
            return

        # Get some customers that don't have policies yet
        # We'll just fetch a bunch of customers and pick those without policies
        cust_stmt = select(Customer).where(Customer.tenant_id == tenant.id)
        customers = (await session.exec(cust_stmt)).all()
        
        statuses = [
            PolicyStatusEnum.QUOTED,
            PolicyStatusEnum.PROPOSED,
            PolicyStatusEnum.UNDER_REVIEW,
            PolicyStatusEnum.INFORMATION_REQUESTED,
            PolicyStatusEnum.APPROVED,
            PolicyStatusEnum.DECLINED,
            PolicyStatusEnum.ISSUED
        ]
        
        count = 0
        for customer in customers:
            # Check if customer already has a policy
            pol_stmt = select(Policy).where(Policy.customer_id == customer.id)
            existing_policy = (await session.exec(pol_stmt)).first()
            if existing_policy:
                continue
                
            # Create a mock policy
            plan = random.choice(plans)
            status = random.choice(statuses)
            
            # Mock coverage amount
            coverage_amount = random.randint(1000000, 10000000)
            term_years = random.randint(5, 20)
            
            policy = Policy(
                tenant_id=tenant.id,
                customer_id=customer.id,
                product_name=plan.label,
                insurance_type=plan.insurance_type,
                coverage_amount=coverage_amount,
                term_years=term_years,
                status=status,
                effective_date=datetime.utcnow().date() + timedelta(days=random.randint(1, 30)),
                updated_at=datetime.utcnow() - timedelta(days=random.randint(0, 10))
            )
            session.add(policy)
            await session.flush()
            
            # Calculate premium (mock values for age, etc)
            if customer.dob:
                age = (datetime.utcnow().date() - customer.dob).days // 365
            else:
                age = 35
            breakdown = calculate_premium(
                coverage_amount=coverage_amount,
                base_premium_rate=plan.base_premium_rate,
                smoker_factor=plan.smoker_factor,
                age=age,
                is_smoker=customer.is_smoker,
                height_cm=customer.height_cm,
                weight_kg=customer.weight_kg
            )
            
            quote = PremiumQuote(
                tenant_id=tenant.id,
                policy_id=policy.id,
                base_premium=breakdown.base_premium,
                loading_applied=breakdown.loading_applied,
                total_premium=breakdown.total_premium,
                rate_version=plan.rate_version,
                created_at=datetime.utcnow() - timedelta(days=random.randint(5, 15))
            )
            session.add(quote)
            
            # also update customer status
            if status in [PolicyStatusEnum.PROPOSED, PolicyStatusEnum.UNDER_REVIEW, PolicyStatusEnum.INFORMATION_REQUESTED]:
                customer.profile_status = "PROSPECT"
            elif status == PolicyStatusEnum.APPROVED:
                customer.profile_status = "UNDERWRITING_READY"
            elif status == PolicyStatusEnum.ISSUED:
                customer.profile_status = "POLICYHOLDER"
            elif status == PolicyStatusEnum.DECLINED:
                customer.profile_status = "NOT_INTERESTED"
                
            session.add(customer)
            count += 1
            if count >= 30: # Generate at least 30 quotes
                break
                
        await session.commit()
        print(f"Successfully generated {count} mock proposals with diverse statuses!")

if __name__ == "__main__":
    asyncio.run(main())
