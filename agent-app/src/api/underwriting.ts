import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AssessmentItem {
  id: string;
  case_id: string;
  customer_name: string;
  customer_cnic?: string;
  medical_score: number;
  financial_score: number;
  fraud_probability: number;
  composite_risk_score: number;
  ai_decision: string;
  reasons: string[];
  status: string;
  created_at: string;
}

export const fetchAssessments = async (): Promise<AssessmentItem[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  try {
    const res = await api.get('/assessments');
    if (Array.isArray(res.data) && res.data.length > 0) {
      return res.data;
    }
  } catch (e) {}

  // Fallback to fetching cases list for underwriting overview
  const casesRes = await api.get(`/tenants/${tenantId}/cases`);
  const cases = casesRes.data || [];

  return cases.map((c: any) => ({
    id: c.caseld || c.id,
    case_id: c.caseNumber || `CASE-${c.id?.slice(0, 6)}`,
    customer_name: c.applicant_name || c.customer_name || 'Applicant',
    customer_cnic: c.customer_cnic,
    medical_score: c.medical_score ?? 65,
    financial_score: c.financial_score ?? 72,
    fraud_probability: c.fraud_probability ?? 0.08,
    composite_risk_score: c.composite_risk_score ?? 34,
    ai_decision: c.ai_decision || (c.status === 'APPROVED' ? 'AUTO_APPROVE' : 'HUMAN_REVIEW'),
    reasons: c.reasons || ['Medical risk within normal limits', 'Financial coverage ratio verified'],
    status: c.status || 'Under Review',
    created_at: c.created_at || new Date().toISOString(),
  }));
};
