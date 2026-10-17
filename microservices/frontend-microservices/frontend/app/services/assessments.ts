import api from "./api";

export interface AssessmentListItem {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_cnic: string;
  customer_occupation: string | null;
  case_id: string | null;
  product_name: string | null;
  insurance_type: string | null;
  coverage_amount: number | null;
  medical_score: number;
  financial_score: number;
  fraud_probability: number;
  composite_risk_score: number | null;
  ai_decision: "Auto Approve" | "Approve with Loading" | "Human Review" | "Decline";
  suggested_loading: number | null;
  has_summary: boolean;
  created_at: string;
}

export async function listAssessments(): Promise<AssessmentListItem[]> {
  const resp = await api.get<AssessmentListItem[]>("/assessments");
  return resp.data;
}
