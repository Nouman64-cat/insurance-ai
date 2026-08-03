import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface CaseItem {
  id: string;
  case_number: string;
  applicant_name: string;
  customer_cnic?: string;
  case_type: string;
  priority: string;
  status: string;
  created_at: string;
}

export const fetchCases = async (): Promise<CaseItem[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const res = await api.get(`/tenants/${tenantId}/cases`);
  const data = res.data || [];

  return data.map((c: any) => ({
    id: c.caseld || c.id,
    case_number: c.caseNumber || c.case_number || `CASE-${c.id?.slice(0, 6)}`,
    applicant_name: c.applicant_name || c.customer_name || 'Applicant',
    customer_cnic: c.customer_cnic || c.cnic,
    case_type: c.case_type || 'Underwriting',
    priority: c.priority || 'Normal',
    status: c.status || 'New',
    created_at: c.created_at || new Date().toISOString(),
  }));
};

export const createCase = async (data: {
  applicant_name: string;
  customer_cnic?: string;
  case_type?: string;
  priority?: string;
}) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');

  return api.post(`/tenants/${tenantId}/cases`, {
    applicant_name: data.applicant_name,
    customer_cnic: data.customer_cnic,
    case_type: data.case_type || 'Underwriting',
    priority: data.priority || 'Normal',
    assigned_agent_id: agentId || null,
  });
};
