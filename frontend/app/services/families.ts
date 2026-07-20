import api from "./api";

export type FamilyCategory = "active" | "in_progress" | "new";

export interface FamilyStats {
  total_families: number;
  active: number;
  in_progress: number;
  new_no_members: number;
}

export interface FamilyListParams {
  search?: string;
  category?: FamilyCategory;
}

const base = (tenantId: string) => `/tenants/${tenantId}/families`;

export async function fetchFamilyStats(tenantId: string): Promise<FamilyStats> {
  const resp = await api.get<FamilyStats>(`${base(tenantId)}/stats`);
  return resp.data;
}

export async function listFamilies<T = any>(tenantId: string, params: FamilyListParams = {}): Promise<T[]> {
  const query: Record<string, string> = {};
  if (params.search?.trim()) query.search = params.search.trim();
  if (params.category) query.category = params.category;
  const resp = await api.get<T[]>(base(tenantId), { params: query });
  return resp.data;
}
