import api from "./api";

export interface Branch {
  id: string;
  name: string;
  branch_code: string;
  city: string;
}

export async function listBranches(tenantId: string): Promise<Branch[]> {
  const resp = await api.get<Branch[]>(`/tenants/${tenantId}/branches`);
  return resp.data;
}
