import api from "./api";

export interface AcquisitionSource {
  id: string;
  name: string;
  source_type: string;
  partner_name: string | null;
}

export async function listAcquisitionSources(tenantId: string): Promise<AcquisitionSource[]> {
  const resp = await api.get<AcquisitionSource[]>(`/tenants/${tenantId}/acquisition-sources`);
  return resp.data;
}
