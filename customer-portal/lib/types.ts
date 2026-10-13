// Shapes returned by Customer Management (services/customer-management). Fields the UI does not use are omitted.
export interface PremiumInfo {
  next_due_date: string | null;
  next_due_amount: number | null;
  next_due_state: string | null;
  due_now: number;
  remaining: number;
  arrears_count: number;
  in_grace: boolean;
  grace_until: string | null;
  grace_days_left: number | null;
  lapse_due: boolean;
  paid_count: number;
  installments_total: number;
  total_paid: number;
  can_pay: boolean;
}

export interface PolicyCard {
  id: string;
  policy_number: string | null;
  product_name: string;
  insurance_type: string;
  status: string;
  status_key: string;
  pending_issuance: boolean;
  in_force: boolean;
  reinstated: boolean;
  sum_assured: number;
  term_years: number;
  annual_premium: number | null;
  installment_amount: number | null;
  premium_frequency: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  maturity_date: string | null;
  issued_at: string | null;
  grace_period_end_date: string | null;
  free_look_end_date: string | null;
  premium: PremiumInfo;
  claims: { total: number; open: number };
}

export interface DocumentItem {
  id: string;
  kind: string;
  title: string;
  policy_id: string;
  policy_number: string | null;
  date: string | null;
  available: boolean;
  amount?: number;
}

export interface PolicyDetail extends PolicyCard {
  policyholder: { name: string; policyholder_id: string | null; cnic_masked: string | null; dob: string | null; email: string | null; phone: string | null; address: string | null };
  insured: { name: string; relationship: string; dob: string | null };
  plan: { product_name: string; insurance_type: string; term_years: number };
  coverage: {
    sum_assured: number;
    riders: { name: string; sum_assured: number; annual_premium: number; status: string }[];
    benefits: { category: string; label: string; sum_assured: number; detail: string }[];
  };
  nominees: { name: string; relationship: string; share_pct: number; is_minor: boolean; cnic_masked: string | null }[];
  premium_schedule: { id: string; installment_no: number; due_date: string; amount_due: number; amount_paid: number; payable: number; state: string; status: string }[];
  versions: { version_number: string; effective_from: string; total_premium: number; event_type: string }[];
  documents: DocumentItem[];
  timeline: { id: string; event: string; title: string; at: string; to_status: string | null; detail: { amount?: number; receipt_no?: string; claim_number?: string } }[];
}

export interface Installment {
  id: string;
  installment_no: number;
  billing_frequency: string;
  due_date: string;
  amount_due: number;
  amount_paid: number;
  outstanding: number;
  surcharge: number;
  payable: number;
  status: string;
  state: string;
  days_until: number;
  paid_at: string | null;
  receipt: { id: string; receipt_no: string } | null;
  payable_now: boolean;
}

export interface Receipt {
  id: string;
  receipt_no: string;
  schedule_id: string | null;
  amount: number;
  surcharge: number;
  total: number;
  method: string | null;
  reference: string | null;
  paid_at: string;
  has_document: boolean;
  policy_id?: string;
  policy_number?: string;
}

export interface PremiumsView {
  policy_id: string;
  policy_number: string | null;
  policy_status: string;
  can_pay: boolean;
  payable_installment_id: string | null;
  surcharge_pct: number;
  summary: { total: number; paid: number; outstanding_count: number; arrears_count: number; total_outstanding: number; next_due_date: string | null; next_due_amount: number | null; in_grace: boolean; grace_until: string | null; grace_days_left: number | null; lapse_due: boolean; total_paid: number; overdue_amount: number; due_now: number; remaining: number };
  installments: Installment[];
  receipts: Receipt[];
}

export interface PaymentsOverview {
  simulated_payments: boolean;
  payments_enabled: boolean;
  partial: boolean;
  totals: { total_paid: number; outstanding: number; remaining: number; overdue: number; next_due: { policy_number: string; date: string; amount: number } | null };
  policies: { policy: PolicyCard; premiums: PremiumsView | null }[];
  history: Receipt[];
}

export interface ClaimRow {
  id: string;
  claim_number: string | null;
  policy_id: string;
  policy_number: string | null;
  product_name: string;
  claim_type: string;
  category: string | null;
  incident_date: string | null;
  reported_date: string | null;
  claimed_amount: number;
  approved_amount: number | null;
  status: string;
  status_key: string;
  settled_amount: number | null;
  settled_at: string | null;
  closed_at: string | null;
  last_update: string;
  own_claim: boolean;
}

export interface ClaimDetail extends ClaimRow {
  stages: { key: string; step: number; state: "complete" | "current" | "attention" | "skipped" | "pending" }[] | null;
  documents: { key: string; label: string; required: boolean; status: string; received_at: string | null; file_name: string | null; can_upload: boolean }[];
  documents_progress?: { received: number; required: number; complete: boolean };
  timeline: { id: string; title: string; at: string }[];
  decision: { decision: string | null; amount: number | null; reason: string | null; at: string | null } | null;
  eligibility: { status: string; message: string | null } | null;
  settlement: { paid_total: number; payouts: { amount: number; method: string; status: string; reference: string | null; completed_at: string | null }[] } | null;
  event: { date: string; end_date: string | null; place: string | null; cause: string | null; description: string | null } | null;
}

export interface ClaimOptions {
  policy_id: string;
  policy_number: string | null;
  status: string;
  can_claim_online: boolean;
  categories: { key: string; label: string; available: boolean; sum_assured: number | null }[];
  causes: string[];
  in_force_today: boolean;
  note: string | null;
  out_of_scope: string[];
}

export interface Notice {
  key: string;
  kind: string;
  severity: "critical" | "warning" | "success" | "info";
  policy_id: string | null;
  claim_id: string | null;
  at: string;
  read: boolean;
  params: Record<string, string | number | null | undefined>;
}

export interface Dashboard {
  customer: { name: string; policyholder_id: string; company: string | null };
  summary: {
    total_policies: number | null;
    active_policies: number | null;
    in_force_policies: number | null;
    coverage_total: number | null;
    next_premium: { policy_id: string; policy_number: string; date: string; amount: number; state: string | null } | null;
    outstanding_amount: number | null;
    remaining_amount: number | null;
    open_claims: number | null;
    upcoming_expiry: { policy_id: string; policy_number: string; date: string }[];
  };
  policies: PolicyCard[];
  claims: ClaimRow[];
  notices: Notice[];
  unread_notices: number;
  sections: { profile: boolean; policies: boolean; claims: boolean };
}

export interface Profile {
  customer_id: string;
  name: string;
  policyholder_id: string | null;
  cnic_masked: string | null;
  dob: string | null;
  gender: string | null;
  marital_status: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  username: string;
  language: string;
  tenant: { id: string; code: string | null; name: string | null; contact_email: string | null; contact_phone: string | null; website: string | null; address: string | null };
}

export interface Me {
  account_id: string;
  username: string;
  display_name: string;
  language: string;
  tenant_code: string;
  must_change_password: boolean;
  scope: string;
}
