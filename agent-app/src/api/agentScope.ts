import AsyncStorage from '@react-native-async-storage/async-storage';
import { normaliseRole, roleSeesAllLeads } from '../context/SessionContext';

/**
 * Query params that scope a list fetch to the logged-in Agent's own leads —
 * empty for Admin/Underwriter/SuperAdmin, who work the whole tenant. Shared
 * by every api/*.ts list fetch so a case/policy/assessment endpoint doesn't
 * silently show every agent's book on an Agent's device.
 */
export const agentScopeParams = async (paramName: string): Promise<Record<string, string>> => {
  const [role, agentId] = await Promise.all([
    AsyncStorage.getItem('user_role'),
    AsyncStorage.getItem('agent_id'),
  ]);
  if (roleSeesAllLeads(normaliseRole(role)) || !agentId) return {};
  return { [paramName]: agentId };
};
