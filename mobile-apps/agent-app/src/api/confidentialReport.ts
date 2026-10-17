import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ACRRecommendation = 'Recommend' | 'RecommendWithCaution' | 'DoNotRecommend';

export interface ConfidentialReportForm {
  known_proposer_since?: string;
  relationship_to_proposer?: string;
  purpose_of_insurance?: string;
  financial_interest_explained?: boolean;
  adverse_info_known?: boolean;
  adverse_info_details?: string;

  occupation_verified?: boolean;
  income_source_verified?: boolean;
  estimated_income_opinion?: number;
  income_consistency_note?: string;

  health_appearance_note?: string;
  hazardous_activity_known?: boolean;

  // Agent Declaration — the submit endpoint rejects the report unless all
  // three are true (services/tenant-service/routers/agent_confidential_report.py).
  terms_explained_to_proposer?: boolean;
  identity_verified_kyc?: boolean;
  signature_obtained_in_presence?: boolean;

  recommendation?: ACRRecommendation;
  remarks?: string;
}

export interface ConfidentialReport extends ConfidentialReportForm {
  status: 'NotStarted' | 'Draft' | 'Submitted';
  submitted_at: string | null;
}

export const fetchConfidentialReport = async (caseId: string): Promise<ConfidentialReport> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.get(`/tenants/${tenantId}/cases/${caseId}/acr`);
  return res.data;
};

export const saveConfidentialReport = async (
  caseId: string,
  data: ConfidentialReportForm,
): Promise<ConfidentialReport> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.put(`/tenants/${tenantId}/cases/${caseId}/acr`, data);
  return res.data;
};

export const submitConfidentialReport = async (caseId: string): Promise<ConfidentialReport> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/acr/submit`);
  return res.data;
};

/** An ACR the pipeline has asked this user (or the acquisition source whose
 * login they hold) to file. "Requested" = not opened yet. */
export interface ACRRequest {
  case_id: string;
  case_number: string | null;
  applicant_name: string | null;
  segment: 'individual' | 'family' | 'organization';
  group_name: string | null;
  status: 'Requested' | 'Draft' | 'Submitted';
  requested_at: string | null;
  requested_by_name: string | null;
  submitted_at: string | null;
}

export const fetchACRRequests = async (): Promise<ACRRequest[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.get(`/tenants/${tenantId}/acr-requests`);
  return res.data || [];
};
