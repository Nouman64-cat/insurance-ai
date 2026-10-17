import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { agentScopeParams } from './agentScope';

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

/**
 * Real AI risk-assessment runs only — a case with no entry here simply hasn't
 * gone through the risk engine yet (still in Pre-Underwriting, most likely).
 * This used to fall back to the cases list and fabricate scores/decisions for
 * every case that had no assessment, which made the mobile Risk Engine tab
 * show "results" for cases underwriting had never actually touched. Better to
 * show nothing than to invent a decision.
 */
export const fetchAssessments = async (): Promise<AssessmentItem[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const scope = await agentScopeParams('assigned_user');

  // /assessments lives on the api-gateway, not tenant-service — it reads the
  // tenant from the X-Tenant-Id header (services/api-gateway/dependencies.py
  // get_tenant_id), not a /tenants/{id}/... path segment. Without this header
  // the request 422s ("field required"), which is exactly what surfaced once
  // the old fallback here stopped silently swallowing the error.
  const res = await api.get('/assessments', {
    params: scope,
    headers: { 'X-Tenant-Id': tenantId },
  });
  return Array.isArray(res.data) ? res.data : [];
};
