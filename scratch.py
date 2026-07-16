import requests

tenant_id = "b627b73f-8084-4be8-bf6e-ad9386b9cf6e"

# Get quotes
quotes = requests.get(f"http://localhost:8010/quotes", headers={"X-Tenant-Id": tenant_id}).json()
if not quotes:
    print("No quotes")
    exit()

quote_id = quotes[0]["quote_id"]
detail = requests.get(f"http://localhost:8010/quotes/{quote_id}", headers={"X-Tenant-Id": tenant_id}).json()

payload = {
    "customer": {
        "cnic": detail["customer_cnic"],
        "name": detail["customer_name"],
        "dob": detail["customer_dob"],
        "gender": detail["customer_gender"],
        "occupation": detail["customer_occupation"],
        "declared_income": detail["customer_declared_income"],
    },
    "policy": {
        "product_name": detail["plan_label"],
        "insurance_type": detail["insurance_type"],
        "coverage_amount": detail["coverage_amount"],
        "term_years": detail["term_years"],
    },
}
if detail.get("dependent_name"):
    payload["policy"]["dependent_name"] = detail["dependent_name"]
    payload["policy"]["dependent_dob"] = detail["dependent_dob"]

print("Payload:", payload)

res = requests.post(f"http://localhost:8010/evaluate/stream", headers={"X-Tenant-Id": tenant_id}, json=payload, stream=True)
print("Status:", res.status_code)
for line in res.iter_lines():
    if line:
        print(line.decode())
