import api from "./api";

export type ProfileStatus = "LEAD" | "PROSPECT" | "UNDERWRITING_READY" | "NOT_INTERESTED";
export type CustomerCategory = "active" | "full_details" | "quick_lead" | "not_interested";

export interface CustomerStats {
  total_customers: number;
  active_policyholders: number;
  full_details: number;
  quick_leads: number;
  not_interested: number;
}

export interface CustomerListParams {
  search?: string;
  category?: CustomerCategory;
  acquisition_source_id?: string;
}

const base = (tenantId: string) => `/tenants/${tenantId}/customers`;

export async function fetchCustomerStats(tenantId: string): Promise<CustomerStats> {
  const resp = await api.get<CustomerStats>(`${base(tenantId)}/stats`);
  return resp.data;
}

export async function listCustomers<T = any>(tenantId: string, params: CustomerListParams = {}): Promise<T[]> {
  const query: Record<string, string> = {};
  if (params.search?.trim()) query.search = params.search.trim();
  if (params.category) query.category = params.category;
  if (params.acquisition_source_id) query.acquisition_source_id = params.acquisition_source_id;
  const resp = await api.get<T[]>(base(tenantId), { params: query });
  return resp.data;
}

export async function setProfileStatus(tenantId: string, customerId: string, profile_status: ProfileStatus): Promise<void> {
  await api.put(`${base(tenantId)}/${customerId}`, { profile_status });
}

export async function updateCustomer(tenantId: string, customerId: string, data: any): Promise<void> {
  await api.put(`${base(tenantId)}/${customerId}`, data);
}
