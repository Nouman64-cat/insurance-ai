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

/**
 * Every user in the tenant keyed by id, for turning an `assigned_agent_id` into
 * a display name. The list endpoints return only the id, so any screen showing
 * "who owns this lead" needs this lookup.
 *
 * Cached per tenant because the Leads board resolves names on every refresh,
 * and the directory changes far less often than the leads do — but bounded to
 * a short TTL rather than cached forever: a newly added/activated agent
 * otherwise never appears (shows "Unassigned" for their own leads) until the
 * tab is hard-reloaded, since the Leads board's own 15s poll kept reusing the
 * same stale snapshot indefinitely.
 */
const DIRECTORY_TTL_MS = 60_000;
let directoryCache: { tenantId: string; byId: Map<string, string>; fetchedAt: number } | null = null;

export async function getUserDirectory(tenantId: string): Promise<Map<string, string>> {
  if (directoryCache?.tenantId === tenantId && Date.now() - directoryCache.fetchedAt < DIRECTORY_TTL_MS) {
    return directoryCache.byId;
  }
  try {
    const res = await api.get<UserRow[]>(`/tenants/${tenantId}/users/directory`);
    const byId = new Map<string, string>(
      (res.data || []).map((u) => [String(u.id), u.full_name || u.email || "Unknown"]),
    );
    directoryCache = { tenantId, byId, fetchedAt: Date.now() };
    return byId;
  } catch {
    // Names are a nicety — the board must still render without them.
    return directoryCache?.byId ?? new Map();
  }
}

/** Drops the cache so a newly created user shows up without a page reload. */
export function invalidateUserDirectory() {
  directoryCache = null;
}
