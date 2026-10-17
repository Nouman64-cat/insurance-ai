import sys
import json
from underwriting_rules import check_plan_rules

customer = {"dob": "2003-01-01", "declared_income": 2050000}
policy = {"coverage_amount": 5000000, "term_years": 10, "insurance_type": "Apna Savings"}
is_valid, errors = check_plan_rules("Apna Savings", customer, policy)
print(json.dumps({"is_valid": is_valid, "errors": errors}))
