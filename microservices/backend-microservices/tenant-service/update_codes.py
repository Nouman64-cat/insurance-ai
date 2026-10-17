import re

file_path = "/home/rizvi/projects/insurance-ai/services/tenant-service/routers/rules.py"

mapping = {
    "medical.nml_grid.window_takaful": "RS-MED-002",
    "medical.nml_grid.bancassurance_mcb": "RS-MED-003",
    "medical.nml_grid.bancassurance_alfalah": "RS-MED-004",
    "medical.nml_grid": "RS-MED-001",
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

with open(file_path, "r") as f:
    content = f.read()

for old_code, new_code in mapping.items():
    content = content.replace(f'"code": "{old_code}"', f'"code": "{new_code}"')

with open(file_path, "w") as f:
    f.write(content)

print("Updated rules.py")
