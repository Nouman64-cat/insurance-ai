import api from "./api";

export interface QuoteListItem {
  quote_id: string;
  customer_id: string;
  customer_name: string;
  customer_cnic: string;
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
  acquisition_source_id?: string | null;
  acquisition_source_name?: string | null;
  acquisition_source_type?: string | null;
  acquisition_source_partner?: string | null;
}

export interface QuoteDetail extends QuoteListItem {
  customer_dob: string;
  customer_age: number;
  customer_gender: string;
  customer_occupation: string;
  customer_declared_income: number;
  customer_is_smoker: boolean;
  customer_height_cm: number;
  customer_weight_kg: number;
  customer_bmi: number | null;
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
