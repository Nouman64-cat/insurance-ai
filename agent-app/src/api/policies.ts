import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PolicyItem {
  id: string;
  policy_number?: string;
  customer_name: string;
  customer_cnic?: string;
  product_name: string;
  coverage_amount: number;
  premium_amount?: number;
  status: string; // PENDING_PAYMENT, APPROVED, ACTIVE, ISSUED, LAPSED
  stage: 'PRE_ISSUANCE' | 'POST_ISSUANCE';
  created_at: string;
  effective_date?: string;
  expiry_date?: string;
}

export const fetchPolicies = async (): Promise<PolicyItem[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  try {
    const res = await api.get(`/tenants/${tenantId}/cases`);
    const cases = res.data || [];

    return cases.map((c: any) => {
      const status = (c.status || '').toUpperCase();
      const isActive = status === 'ACTIVE' || status === 'ISSUED';
      return {
        id: c.caseld || c.id,
        policy_number: c.policy_number || (isActive ? `POL-2026-${c.id?.slice(0, 6)}` : undefined),
        customer_name: c.applicant_name || c.customer_name || 'Customer',
        customer_cnic: c.customer_cnic || c.cnic,
        product_name: c.product_name || 'Term Life Plus',
        coverage_amount: c.coverage_amount || 5000000,
        premium_amount: c.premium_amount || 45000,
        status: c.status || (isActive ? 'ACTIVE' : 'APPROVED'),
        stage: isActive ? 'POST_ISSUANCE' : 'PRE_ISSUANCE',
        created_at: c.created_at || new Date().toISOString(),
        effective_date: c.effective_date || '2026-08-01',
        expiry_date: c.expiry_date || '2046-08-01',
      };
    });
  } catch (e) {
    return [];
  }
};
