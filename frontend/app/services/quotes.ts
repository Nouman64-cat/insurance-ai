import api from "./api";

export interface QuoteListItem {
  quote_id: string;
  customer_id: string;
  customer_name: string;
  customer_cnic: string;
  policy_id: string;
  plan_label: string;
  insurance_type: string;
  coverage_amount: number;
  term_years: number;
  base_premium: number;
  loading_applied: number;
  total_premium: number;
  rate_version: string;
  created_at: string;
  acquisition_source_id?: string | null;
  acquisition_source_name?: string | null;
  acquisition_source_type?: string | null;
  acquisition_source_partner?: string | null;
  // Set only for a group-life certificate issued under a corporate Master
  // Policy — null for individually underwritten quotes.
  organization_id?: string | null;
  organization_name?: string | null;
  master_policy_id?: string | null;
  master_policy_label?: string | null;
  // Set only for a floater's shared certificate or a life-bundle member's
  // own certificate, issued under a FamilyGroup — null otherwise. A quote
  // only ever carries one of organization_id / family_group_id, never both.
  family_group_id?: string | null;
  family_group_name?: string | null;
  family_policy_id?: string | null;
  family_policy_label?: string | null;
}

export interface QuoteDetail extends QuoteListItem {
  customer_dob: string;
  customer_age: number;
  customer_gender: string;
  customer_occupation: string;
  customer_declared_income: number;
  customer_is_smoker: boolean;
  customer_height_cm: number;
  customer_weight_kg: number;
  customer_bmi: number | null;
  nominee_name: string | null;
  nominee_relationship: string | null;
  dependent_name: string | null;
  dependent_dob: string | null;
}

export async function listQuotes(): Promise<QuoteListItem[]> {
  const tenantId = localStorage.getItem("tenant_id");
  const resp = await api.get<QuoteListItem[]>("/quotes", {
    headers: { "X-Tenant-Id": tenantId }
  });
  return resp.data;
}

export async function getQuote(quoteId: string): Promise<QuoteDetail> {
  const tenantId = localStorage.getItem("tenant_id");
  const resp = await api.get<QuoteDetail>(`/quotes/${quoteId}`, {
    headers: { "X-Tenant-Id": tenantId }
  });
  return resp.data;
}
