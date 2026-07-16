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

export interface QuoteDetail extends QuoteListItem {
  applicant_dob: string;
  applicant_age: number;
  applicant_gender: string;
  applicant_occupation: string;
  applicant_declared_income: number;
  applicant_is_smoker: boolean;
  applicant_height_cm: number;
  applicant_weight_kg: number;
  applicant_bmi: number | null;
  nominee_name: string | null;
  nominee_relationship: string | null;
  dependent_name: string | null;
  dependent_dob: string | null;
}

export async function listQuotes(): Promise<QuoteListItem[]> {
  const resp = await api.get<QuoteListItem[]>("/quotes");
  return resp.data;
}

export async function getQuote(quoteId: string): Promise<QuoteDetail> {
  const resp = await api.get<QuoteDetail>(`/quotes/${quoteId}`);
  return resp.data;
}
