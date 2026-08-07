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
  latest_ai_decision: "Auto Approve" | "Approve with Loading" | "Human Review" | "Decline" | null;
  latest_composite_score: number | null;
  family_group_id?: string;
  family_group_name?: string;
  organization_id?: string;
  e_application_status?: "NotSent" | "Sent" | "InProgress" | "Submitted" | "Expired";
  acr_status?: "NotStarted" | "Draft" | "Submitted";
  compliance_status?: "NotStarted" | "Passed" | "Flagged" | "Failed";
  ipp_status?: "NotStarted" | "Initiated" | "Realized" | "Failed";
  insurance_history_status?: "NotStarted" | "Clear" | "Flagged" | "Failed";
  medical_exam_status?:
    | "NotAssessed" | "NotRequired" | "Required" | "Invited"
    | "Scheduled" | "Completed" | "Waived" | "Expired";
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
