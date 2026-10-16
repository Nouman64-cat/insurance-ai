import api from "./api";

export type CustomerSegment = "individual" | "family" | "organization";

export interface CaseQueueItem {
  caseld: string;
  caseNumber: string;
  customer_id: string;
  policy_id: string | null;
  caseType: string;
  caseStatus: string;
  priorityLevel: string;
  sourceChannel: string;
  createdAt: string;
  updatedAt: string;
  customer_name: string | null;
  customer_cnic: string | null;
  customer_segment: CustomerSegment | null;
  product_name: string | null;
  coverage_amount: number | null;
  /** The linked policy's lifecycle status (Proposed, Approved, PendingPayment, Active, Declined, …). */
  policy_status?: string | null;
  latest_ai_decision: "Auto Approve" | "Approve with Loading" | "Human Review" | "Decline" | null;
  latest_composite_score: number | null;
  /** Underwriting hold: the case is frozen where it stands until the hold is removed. */
  on_hold?: boolean;
  hold_reason?: string | null;
  held_at?: string | null;
  family_group_id?: string;
  family_group_name?: string;
  organization_id?: string;
  e_application_status?: "NotSent" | "Sent" | "InProgress" | "Submitted" | "Verified" | "Expired";
  acr_status?: "NotStarted" | "Requested" | "Draft" | "Submitted" | "Waived";
  compliance_status?: "NotStarted" | "Passed" | "Flagged" | "Failed";
  ipp_status?: "NotStarted" | "Initiated" | "Realized" | "Failed";
  insurance_history_status?: "NotStarted" | "Clear" | "Flagged" | "Failed";
  medical_exam_status?:
    | "NotAssessed" | "NotRequired" | "Required" | "Invited"
    | "Scheduled" | "Completed" | "Waived" | "Expired";
  /** The medical and financial underwriting reviews; PENDING until an underwriter picks the track up. */
  medical_review?: UnderwritingReview;
  financial_review?: UnderwritingReview;
}

export type UnderwritingTrack = "medical" | "financial";
export type UnderwritingReviewStatus = "PENDING" | "IN_REVIEW" | "CLEARED" | "REFERRED" | "DECLINED";

export interface UnderwritingReview {
  status: UnderwritingReviewStatus;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  note: string | null;
  updated_at: string | null;
}

export interface TrackUnderwriter {
  id: string;
  full_name: string;
  email: string;
  role: string;
  tracks: UnderwritingTrack[];
}

/** Users who can take the medical and/or financial review (Medical / Financial Underwriter, Underwriter). */
export async function listTrackUnderwriters(tenantId: string): Promise<TrackUnderwriter[]> {
  const resp = await api.get<TrackUnderwriter[]>(`/tenants/${tenantId}/underwriting/underwriters`);
  return resp.data;
}

export async function updateUnderwritingTrack(
  tenantId: string,
  caseId: string,
  track: UnderwritingTrack,
  body: { status?: UnderwritingReviewStatus; assigned_user_id?: string; clear_assignee?: boolean; note?: string },
): Promise<UnderwritingReview> {
  const resp = await api.put<UnderwritingReview>(`/tenants/${tenantId}/cases/${caseId}/underwriting-tracks/${track}`, body);
  return resp.data;
}

export async function listCases(
  tenantId: string,
  caseType?: string,
  segment?: CustomerSegment,
): Promise<CaseQueueItem[]> {
  const resp = await api.get<CaseQueueItem[]>(`/tenants/${tenantId}/cases`, {
    params: {
      ...(caseType ? { case_type: caseType } : {}),
      ...(segment ? { segment } : {}),
    },
  });
  return resp.data;
}

export async function runCaseCompliance(tenantId: string, caseId: string): Promise<any> {
  const resp = await api.post(`/tenants/${tenantId}/cases/${caseId}/compliance/run`);
  return resp.data;
}

export async function clearComplianceCheck(tenantId: string, checkId: string): Promise<any> {
  const resp = await api.post(`/tenants/${tenantId}/compliance/${checkId}/clear`, {
    cleared_by: "underwriter",
    note: "Force proceeded from Underwriting UI",
  });
  return resp.data;
}
