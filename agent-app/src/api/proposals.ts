import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { agentScopeParams } from './agentScope';

export interface ProposalItem {
  id: string;
  customer_id: string;
  policy_id: string;
  customer_name: string;
  customer_cnic?: string;
  product_name: string;
  coverage_amount: number;
  term_years: number;
  status: string;
  created_at: string;
}

export const fetchProposals = async (): Promise<ProposalItem[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const scope = await agentScopeParams('assigned_agent_id');

  try {
    const res = await api.get('/quotes', { 
      params: scope,
      headers: { 'X-Tenant-Id': tenantId }
    });
    if (Array.isArray(res.data)) {
      return res.data.map((q: any) => ({
        id: q.quote_id || q.id,
        customer_id: q.customer_id,
        policy_id: q.policy_id,
        customer_name: q.customer_name,
        customer_cnic: q.customer_cnic,
        product_name: q.plan_label || q.product_name || 'Insurance Plan',
        coverage_amount: q.coverage_amount,
        term_years: q.term_years,
        status: q.status,
        created_at: q.created_at,
      }));
    }
  } catch (e) {
    // If quotes endpoint is unavailable or returns an error,
    // just return an empty array instead of polluting proposals with cases.
    console.warn('Failed to fetch proposals/quotes', e);
  }

  return [];
};

export const createProposal = async (data: {
  customer_name: string;
  customer_cnic?: string;
  product_name: string;
  coverage_amount: number;
  term_years: number;
}) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');

  // Map simple product names from the UI to valid catalog plan codes.
  let planCode = 'PROTECT_PLAN';
  if (data.product_name.includes('Whole Life')) planCode = 'LIFE_PROTECTION_PLUS';
  if (data.product_name.includes('Endowment')) planCode = 'MUSTAQBIL_KI_ZAMANAT_PLAN';
  if (data.product_name.includes('Health')) planCode = 'FAMILY_HEALTH_PLAN';

  return api.post('/quote', {
    customer: {
      name: data.customer_name,
      cnic: data.customer_cnic || '00000-0000000-0',
      dob: '1990-01-01', // Mock DOB for quick quote
      gender: 'Male',
      occupation: 'Agent Lead',
      monthly_income: 150000,
      is_smoker: false,
      height_cm: 175,
      weight_kg: 75,
      assigned_agent_id: agentId || undefined,
    },
    policy: {
      plan_code: planCode,
      coverage_amount: Number(data.coverage_amount),
      term_years: Number(data.term_years),
      nominee_name: 'Pending',
      nominee_relationship: 'Pending',
    }
  }, {
    headers: { 'X-Tenant-Id': tenantId }
  });
};

export const submitProposalToUnderwriting = async (proposal: ProposalItem) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');

  return api.post(`/tenants/${tenantId}/cases`, {
    customer_id: proposal.customer_id,
    policy_id: proposal.policy_id,
    caseType: 'Underwriting',
    sourceChannel: 'Agent',
    assignedAgentId: agentId || null,
  });
};

