import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { agentScopeParams } from './agentScope';

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

  const scope = await agentScopeParams('assigned_user');
  const res = await api.get(`/tenants/${tenantId}/cases`, { params: scope });
  const data = res.data || [];

  return data.map((c: any) => ({
    id: c.caseld || c.id,
    case_number: c.caseNumber || c.case_number || `CASE-${c.id?.slice(0, 6)}`,
    applicant_name: c.applicant_name || c.customer_name || 'Applicant',
    customer_cnic: c.customer_cnic || c.cnic,
    case_type: c.caseType || c.case_type || 'Underwriting',
    priority: c.priorityLevel || c.priority || 'Normal',
    status: c.caseStatus || c.status || 'New',
    created_at: c.createdAt || c.created_at || new Date().toISOString(),
  }));
};

export const createCase = async (data: {
  applicant_name: string;
  customer_cnic?: string;
  case_type?: string;
  priority?: string;
  /** Set when the case is for an existing lead picked from the list — skips
   * creating a second, duplicate customer record for the same person. */
  customer_id?: string;
}) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');

  let customerId = data.customer_id;

  if (!customerId) {
    // No existing lead was selected — create a new customer record.
    const nameParts = data.applicant_name.trim().split(' ');
    const firstName = nameParts[0] || 'Applicant';
    const lastName = nameParts.slice(1).join(' ');

    const customerRes = await api.post(`/tenants/${tenantId}/customers`, {
      first_name: firstName,
      last_name: lastName,
      cnic: data.customer_cnic || undefined,
      assigned_agent_id: agentId || undefined,
    });

    customerId = customerRes.data.id;
  }

  // 2. Create the case referencing the new customer
  // Map frontend case types to valid backend enums (Underwriting, Claim, Inquiry)
  let mappedCaseType = 'Underwriting';
  if (data.case_type === 'Claim' || data.case_type === 'Inquiry') {
    mappedCaseType = data.case_type;
  }

  return api.post(`/tenants/${tenantId}/cases`, {
    customer_id: customerId,
    caseType: mappedCaseType,
    priorityLevel: data.priority || 'Normal',
    sourceChannel: 'Agent',
    assignedAgentId: agentId || null,
  });
};
