import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface EApplicationInvite {
  token: string;
  link_path: string;
  expires_at: string;
  status: string;
}

export const inviteEApplication = async (caseId: string): Promise<EApplicationInvite> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/e-application/invite`);
  return res.data;
};

// Customer web app origin — the E-Application form lives on the Next.js frontend,
// not in this app. Same env-var-with-fallback pattern as api.ts's EXPO_PUBLIC_API_URL.
const WEB_APP_URL = process.env.EXPO_PUBLIC_WEB_URL || 'http://192.168.1.137:3000';

export const buildEApplicationLink = (linkPath: string): string => `${WEB_APP_URL}${linkPath}`;
