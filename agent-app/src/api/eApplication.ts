import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type EApplicationStatus = 'NotSent' | 'Sent' | 'InProgress' | 'Submitted' | 'Verified' | 'Expired';

export interface EApplicationInvite {
  token: string;
  link_path: string;
  expires_at: string;
  status: string;
}

export interface FamilyHistoryEntry {
  relation: string;
  name?: string;
  age?: number | string;
  is_alive?: boolean;
  condition?: string;
  age_at_onset?: number | string;
}

export interface EApplication {
  status: EApplicationStatus;
  sent_at: string | null;
  started_at: string | null;
  submitted_at: string | null;
  verified_at?: string | null;
  medical_questionnaire: Record<string, any> | null;
  family_history: { entries?: FamilyHistoryEntry[] } | null;
  lifestyle_habits: Record<string, any> | null;
  existing_insurance: Record<string, any> | null;
  declaration: Record<string, any> | null;
}

export const inviteEApplication = async (caseId: string): Promise<EApplicationInvite> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/e-application/invite`);
  return res.data;
};

/** The customer's submitted (or in-progress) e-application, for the agent to review. */
export const fetchEApplication = async (caseId: string): Promise<EApplication> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const res = await api.get(`/tenants/${tenantId}/cases/${caseId}/e-application`);
  return res.data;
};

/** Approves (locks in "Verified", clears Gate 1) or rejects (reopens the form
 * for the customer to amend, back to "InProgress") a submitted application. */
export const verifyEApplication = async (
  caseId: string,
  action: 'approve' | 'reject',
  notes?: string
): Promise<{ status: EApplicationStatus }> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/e-application/verify`, { action, notes });
  return res.data;
};

// Customer web app origin — the E-Application form lives on the Next.js frontend,
// not in this app. Same env-var-with-fallback pattern as api.ts's EXPO_PUBLIC_API_URL.
const WEB_APP_URL = process.env.EXPO_PUBLIC_WEB_URL || 'http://192.168.1.83:3000';

export const buildEApplicationLink = (linkPath: string): string => `${WEB_APP_URL}${linkPath}`;
