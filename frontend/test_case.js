const axios = require('axios');
async function test() {
  try {
    const list = await axios.get("http://localhost:8011/tenants/00000000-0000-0000-0000-000000000001/customers");
    const customer = list.data[0];
    if (!customer) { console.log("No customers"); return; }
    const res = await axios.post("http://localhost:8011/tenants/00000000-0000-0000-0000-000000000001/cases", {
      customer_id: customer.id,
      caseType: "Underwriting",
      priorityLevel: "Normal",
      sourceChannel: "Online"
    });
    console.log("RESPONSE KEYS:", Object.keys(res.data));
    console.log("caseld:", res.data.caseld);
    console.log("caseId:", res.data.caseId);
    console.log("id:", res.data.id);
  } catch (e) {
    console.error(e.response?.data || e.message);
  }
}
test();
