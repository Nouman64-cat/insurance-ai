import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

export interface FunnelResetResult {
  purged_customers: number;
  seeded_leads: number;
  leads: string[];
}

/**
 * Wipe every customer + all funnel data for the current tenant and restore the
 * canonical 5 leads + 5 in-progress proposals (seeds/funnel_seed.py). Every other
 * screen (underwriting / applications / issuance / policyholders) returns to 0.
 */
export async function resetFunnel(): Promise<FunnelResetResult> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/demo/reset-funnel`);
  return res.data;
}
