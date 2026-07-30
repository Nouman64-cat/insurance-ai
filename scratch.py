import os
import sys
sys.path.append("/home/hussain/Documents/insurance_ai/insurance-ai")
from services.risk_engine.underwriting_rules import check_plan_rules

customer = {"dob": "2003-01-01", "declared_income": 2050000}
policy = {"coverage_amount": 5000000, "term_years": 10, "insurance_type": "Apna Savings"}
is_valid, errors = check_plan_rules("Apna Savings", customer, policy)
print(is_valid, errors)
