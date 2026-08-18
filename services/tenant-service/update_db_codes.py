import asyncio
from sqlmodel.ext.asyncio.session import AsyncSession
from database import engine
from sqlmodel import select
from shared.models.core import RuleSet

mapping = {
    "medical.nml_grid": "RS-MED-001",
    "medical.nml_grid.window_takaful": "RS-MED-002",
    "medical.nml_grid.bancassurance_mcb": "RS-MED-003",
    "medical.nml_grid.bancassurance_alfalah": "RS-MED-004",
    "commission.secp_rate_card": "RS-COM-001",
    "compliance.secp_aml": "RS-CMP-001",
    "pricing.base_loading": "RS-PRC-001",
    "ai.composite_decision_bands": "RS-AI-001",
    "eligibility.proposal_gates": "RS-ELG-001",
    "underwriting.six_gates": "RS-UW-001",
    "history.hlv_ceiling": "RS-HIS-001",
    "history.score_bands": "RS-HIS-002",
    "rbac.action_role_matrix": "RS-RBA-001",
    "reinsurance.retention_grid": "RS-REI-001",
    "reinsurance.referral_decision": "RS-REI-002",
    "pricing.occupational_loading": "RS-PRC-002"
}

async def update_db():
    async with AsyncSession(engine) as session:
        result = await session.exec(select(RuleSet))
        rule_sets = result.all()
        for rs in rule_sets:
            if rs.rule_code in mapping:
                rs.rule_code = mapping[rs.rule_code]
                session.add(rs)
        await session.commit()
        print("Updated RuleSet codes in database.")

if __name__ == "__main__":
    asyncio.run(update_db())
