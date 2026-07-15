import api from "./api";

export interface CaseQueueItem {
  caseld: string;
  caseNumber: string;
  applicant_id: string;
  policy_id: string | null;
  caseType: string;
  caseStatus: string;
  priorityLevel: string;
  sourceChannel: string;
  createdAt: string;
  updatedAt: string;
  applicant_name: string | null;
  applicant_cnic: string | null;
  product_name: string | null;
  coverage_amount: number | null;
  latest_ai_decision: "Auto Approve" | "Approve with Loading" | "Human Review" | "Decline" | null;
  latest_composite_score: number | null;
}

export async function listCases(tenantId: string, caseType?: string): Promise<CaseQueueItem[]> {
  const resp = await api.get<CaseQueueItem[]>(`/tenants/${tenantId}/cases`, {
    params: caseType ? { case_type: caseType } : undefined,
  });
  return resp.data;
}
