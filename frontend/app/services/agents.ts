import api from "./api";

export interface Agent {
  id: string;
  full_name: string;
  email: string;
}

interface Role {
  id: string;
  name: string;
}

interface UserRow {
  id: string;
  role_id: string;
  full_name: string;
  email: string;
}

async function listUsersByRole(tenantId: string, roleName: string): Promise<Agent[]> {
  const [rolesResp, usersResp] = await Promise.all([
    api.get<Role[]>("/roles"),
    api.get<UserRow[]>(`/tenants/${tenantId}/users/directory`),
  ]);
  const role = (rolesResp.data || []).find((r) => r.name === roleName);
  if (!role) return [];
  return (usersResp.data || [])
    .filter((u) => u.role_id === role.id)
    .map((u) => ({ id: u.id, full_name: u.full_name, email: u.email }));
}

/** Users holding the "Agent" RBAC role — used to populate "assigned agent" pickers. */
export async function listAgents(tenantId: string): Promise<Agent[]> {
  return listUsersByRole(tenantId, "Agent");
}

export async function listUnderwriters(tenantId: string): Promise<Agent[]> {
  return listUsersByRole(tenantId, "Underwriter");
}
