import api from "./api";

export type OrganizationCategory = "active" | "in_progress" | "new";

export interface OrganizationStats {
  total_organizations: number;
  active: number;
  in_progress: number;
  new_no_policy: number;
}

export interface OrganizationListParams {
  search?: string;
  category?: OrganizationCategory;
}

const base = (tenantId: string) => `/tenants/${tenantId}/organizations`;

export async function fetchOrganizationStats(tenantId: string): Promise<OrganizationStats> {
  const resp = await api.get<OrganizationStats>(`${base(tenantId)}/stats`);
  return resp.data;
}

export async function listOrganizations<T = any>(tenantId: string, params: OrganizationListParams = {}): Promise<T[]> {
  const query: Record<string, string> = {};
  if (params.search?.trim()) query.search = params.search.trim();
  if (params.category) query.category = params.category;
  const resp = await api.get<T[]>(base(tenantId), { params: query });
  return resp.data;
}
