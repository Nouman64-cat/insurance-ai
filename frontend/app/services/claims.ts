import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

export type ClaimStatus =
  | "New"
  | "Triaged"
  | "Under Investigation"
  | "Pending Documents"
  | "Approved"
  | "Partial Approval"
  | "Declined"
  | "Referred to Manager"
  | "Reinsurance Referred"
  | "Re-Underwriting Required"
  | "Settled"
  | "Closed";

export interface ClaimArtifact {
  id: string;
  document_type: string;
  file_name: string;
  file_size?: number;
  file_type?: string;
  storage_url?: string;
  download_url?: string;
  status: string;
  ocr_result?: any;
  created_at: string;
}

export interface ClaimStatusHistoryItem {
  id: string;
  from_status?: string | null;
  to_status: string;
  actor_name: string;
  notes?: string | null;
  created_at: string;
}

export interface ClaimPayoutItem {
  id: string;
  amount: number;
  method: string;
  status: string;
  reference_number?: string | null;
  initiated_at: string;
  completed_at?: string | null;
  notes?: string | null;
}

export interface Claim {
  id: string;
  tenant_id: string;
  policy_id: string;
  case_id?: string | null;
  claim_number: string;
  claim_type: string;
  submitted_amount: number;
  approved_amount: number;
  status: ClaimStatus;
  fraud_probability: number;
  duplicate_flag: boolean;
  ai_recommendation?: string | null;
  incident_date?: string | null;
  reported_date: string;
  assigned_adjuster_id?: string | null;
  assigned_adjuster_name?: string | null;
  reinsurance_referral_id?: string | null;
  is_contestable?: boolean;
  underwriting_referral_reason?: string | null;
  underwriting_decision_notes?: string | null;
  settlement_amount?: number | null;
  settled_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  policy_number?: string | null;
  policy_type?: string | null;
  coverage_amount?: number;
  customer_id?: string | null;
  customer_name?: string | null;
  claimant_name: string;
  claimant_type?: string | null;
  claimant_cnic?: string | null;
  claimant_relationship?: string | null;
  claimant_phone?: string | null;
  nominee_name?: string | null;
  nominee_relationship?: string | null;
  nominee_match?: boolean;
  artifacts_count?: number;
  status_history?: ClaimStatusHistoryItem[];
  payouts?: ClaimPayoutItem[];
  artifacts?: ClaimArtifact[];
}

export interface CreateClaimRequest {
  policy_id: string;
  claim_type: string;
  submitted_amount: number;
  incident_date?: string;
  notes?: string;
  claimant_type?: string;
  claimant_name?: string;
  claimant_cnic?: string;
  claimant_relationship?: string;
  claimant_phone?: string;
}

export interface AdjudicateClaimRequest {
  decision: "APPROVED" | "PARTIAL_APPROVAL" | "DECLINED" | "REFERRED_TO_MANAGER";
  approved_amount?: number;
  notes?: string;
  fraud_probability?: number;
  duplicate_flag?: boolean;
}

export interface ClaimPayoutRequest {
  amount: number;
  method?: string;
  reference_number?: string;
  notes?: string;
}

export interface ListClaimsParams {
  status?: string;
  claim_type?: string;
  search?: string;
  start_date?: string;
  end_date?: string;
  date_field?: string;
  risk_level?: string;
  min_amount?: number;
  max_amount?: number;
}

export async function listClaims(params?: ListClaimsParams): Promise<Claim[]> {
  const tid = tenantId();
  const query = new URLSearchParams();
  if (params?.status) query.append("status", params.status);
  if (params?.claim_type) query.append("claim_type", params.claim_type);
  if (params?.search) query.append("search", params.search);
  if (params?.start_date) query.append("start_date", params.start_date);
  if (params?.end_date) query.append("end_date", params.end_date);
  if (params?.date_field) query.append("date_field", params.date_field);
  if (params?.risk_level) query.append("risk_level", params.risk_level);
  if (params?.min_amount !== undefined) query.append("min_amount", params.min_amount.toString());
  if (params?.max_amount !== undefined) query.append("max_amount", params.max_amount.toString());

  const res = await api.get(`/tenants/${tid}/claims?${query.toString()}`);
  return res.data;
}

export async function getClaimDetail(claimId: string): Promise<Claim> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/claims/${claimId}`);
  return res.data;
}

export async function createClaim(payload: CreateClaimRequest): Promise<Claim> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/claims`, payload);
  return res.data;
}

export async function updateClaimStatus(
  claimId: string,
  status: ClaimStatus,
  notes?: string,
  assigned_adjuster_id?: string
): Promise<Claim> {
  const tid = tenantId();
  const res = await api.patch(`/tenants/${tid}/claims/${claimId}/status`, {
    status,
    notes,
    assigned_adjuster_id,
  });
  return res.data;
}

export async function adjudicateClaim(
  claimId: string,
  payload: AdjudicateClaimRequest
): Promise<Claim> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/claims/${claimId}/adjudicate`, payload);
  return res.data;
}

export async function createClaimPayout(
  claimId: string,
  payload: ClaimPayoutRequest
): Promise<any> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/claims/${claimId}/payout`, payload);
  return res.data;
}

export async function referClaimToReinsurance(claimId: string): Promise<any> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/claims/${claimId}/reinsurance-refer`, {});
  return res.data;
}

export async function uploadClaimDocument(
  claimId: string,
  file: File,
  documentType: string
): Promise<ClaimArtifact> {
  const tid = tenantId();
  const formData = new FormData();
  formData.append("file", file);
  formData.append("document_type", documentType);

  const res = await api.post(`/tenants/${tid}/claims/${claimId}/artifacts`, formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
  return res.data;
}

export async function referClaimToUnderwriting(
  claimId: string,
  referral_reason: string,
  notes?: string
): Promise<Claim> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/claims/${claimId}/re-underwrite`, {
    referral_reason,
    notes,
  });
  return res.data;
}

export async function resolveClaimUnderwriting(
  claimId: string,
  decision: "APPROVE_CONTINUE" | "APPROVE_WITH_EXCLUSION" | "APPROVE_WITH_LOADING" | "DECLINE_NON_DISCLOSURE",
  decision_notes: string
): Promise<Claim> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/claims/${claimId}/resolve-underwriting`, {
    decision,
    decision_notes,
  });
  return res.data;
}

