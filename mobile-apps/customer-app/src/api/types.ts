// Mirrors customer-portal/lib/types.ts (walk-in section).
export interface WalkInPlan {
  id: string; code: string; label: string; category: 'Individual' | 'Family' | 'Corporate'; type: string; product_category: string; description: string;
  entry_age_min: number; entry_age_max: number; term_min_years: number; term_max_years: number;
}
export interface WalkInLead {
  reference: string;
  applicant_type?: 'Self' | 'Family';
  plan: { id: string | null; label: string | null; category: string | null };
  submitted_at: string;
  preferred_contact: string | null;
  stage: string;
  note: string;
  closed: boolean;
  agent: { name: string; phone: string | null; email: string | null } | null;
  payment: { token: string; amount: number; proof_status: string; expired: boolean; expires_at: string | null } | null;
  handoff: { available: boolean; account_ready?: boolean };
}
export interface WalkInProfile { email: string; display_name: string; language: string }
