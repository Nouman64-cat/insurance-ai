import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ProposalItem {
  id: string;
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

  try {
    const res = await api.get('/quotes');
    if (Array.isArray(res.data)) {
      return res.data;
    }
  } catch (e) {
    // Fallback if quotes endpoint format differs
  }

  // Fallback: extract proposals from cases
  const casesRes = await api.get(`/tenants/${tenantId}/cases`);
  const cases = casesRes.data || [];
  
  return cases.map((c: any) => ({
    id: c.caseld || c.id,
    customer_name: c.applicant_name || c.customer_name || 'Applicant',
    customer_cnic: c.customer_cnic || c.cnic,
    product_name: c.product_name || 'Term Life Insurance',
    coverage_amount: c.coverage_amount || 5000000,
    term_years: c.term_years || 20,
    status: c.status || 'QUOTED',
    created_at: c.created_at || new Date().toISOString(),
  }));
};

export const createProposal = async (data: {
  customer_name: string;
  customer_cnic?: string;
  product_name: string;
  coverage_amount: number;
  term_years: number;
}) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  return api.post('/quotes', {
    tenant_id: tenantId,
    customer_name: data.customer_name,
    customer_cnic: data.customer_cnic,
    product_name: data.product_name,
    coverage_amount: Number(data.coverage_amount),
    term_years: Number(data.term_years),
  });
};
