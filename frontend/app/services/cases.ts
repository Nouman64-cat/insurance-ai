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
