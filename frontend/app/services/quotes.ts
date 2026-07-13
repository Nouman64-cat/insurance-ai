import api from "./api";

export interface QuoteListItem {
  quote_id: string;
  applicant_id: string;
  applicant_name: string;
  applicant_cnic: string;
  policy_id: string;
  plan_label: string;
  insurance_type: string;
  coverage_amount: number;
  term_years: number;
  base_premium: number;
  loading_applied: number;
  total_premium: number;
  rate_version: string;
  created_at: string;
}

export async function listQuotes(): Promise<QuoteListItem[]> {
  const resp = await api.get<QuoteListItem[]>("/quotes");
  return resp.data;
}
