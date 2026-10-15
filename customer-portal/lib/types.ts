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

export type AccessLevel = "owner" | "guardian" | "summary";
export type PlanType = "Floater" | "LifeBundle";

export interface FamilyRef {
  family_id: string;
  family_name: string;
  family_policy_id: string;
  plan_type: PlanType;
  role: "head" | "member";
  holder_customer_id: string;
}

export interface PolicyCard {
  /** "family" policies belong to a Floater or Life Bundle arrangement; `access` says how much of it this customer may use. */
  segment: "individual" | "family";
  access: AccessLevel;
  family: FamilyRef | null;
  holder_name?: string;
  insured_names?: string[];
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
  claims: { total: number; open: number } | null;
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
  insured_lives: { customer_id: string; name: string; age: number | null; dob: string | null; relationship: string; is_policyholder: boolean; is_you: boolean; is_minor: boolean }[] | null;
  restricted: boolean;
  actions: { kind: string; available: boolean; reason: string | null }[];
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
  segment?: "individual" | "family";
  family?: FamilyRef | null;
  covered_person?: { name: string | null; relationship: string | null } | null;
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
  segment?: "individual" | "family";
  family?: FamilyRef | null;
  covered_persons: { id: string; name: string; relationship: string; is_minor: boolean; needs_consent: boolean; is_you: boolean }[];
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
  /** Present only when the customer belongs to a family with issued policies. */
  family: FamilyGroupSummary[] | null;
  policies: PolicyCard[];
  claims: ClaimRow[];
  notices: Notice[];
  unread_notices: number;
  sections: { profile: boolean; policies: boolean; claims: boolean; family: boolean };
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

// ── family ────────────────────────────────────────────────────────────────────
export interface FamilyTotals {
  coverage: number;
  policies_in_force: number;
  policies_total: number;
  next_premium: { date: string; amount: number; policy_number: string; policy_id: string; can_pay: boolean } | null;
  outstanding: number;
  remaining: number;
  open_claims: number;
  renewals_soon: { policy_id: string; policy_number: string; date: string }[];
}

export interface FamilyCounts { listed: number; insured: number; insured_total: number; nominees: number }

export interface FamilyGroupSummary {
  id: string;
  name: string;
  role: "head" | "member";
  plan_types: PlanType[];
  arrangements: { family_policy_id: string; plan_type: PlanType; plan_label: string; status: string; policy_count: number }[];
  members: FamilyCounts;
  totals: FamilyTotals;
}

export interface Arrangement {
  family_policy_id: string;
  plan_type: PlanType;
  plan_label: string;
  status: string;
  term_years: number;
  effective_date: string | null;
  shared_sum_insured: number | null;
  discount_percentage: number | null;
  policies: PolicyCard[];
}

export interface MemberRow {
  key: string;
  kind: "insured" | "nominee";
  name: string;
  insured: boolean;
  relationship: string;
  age: number | null;
  dob: string | null;
  is_minor: boolean;
  is_you: boolean;
  guardian_name?: string | null;
  share_pct?: number;
  also_insured?: boolean;
  policy_id: string;
  policy_number: string | null;
  plan_type: PlanType;
  family_policy_id: string;
  access: AccessLevel;
  coverage: { kind: "shared_pool" | "own"; amount: number; note: string | null } | null;
  coverage_effective_date?: string | null;
  policy_status: string;
  eligibility: "covered" | "pending" | "ended" | "nominee_only";
  can_manage: boolean;
}

export interface FamilyOverview extends Omit<FamilyGroupSummary, "arrangements"> {
  arrangements: Arrangement[];
  members_list: MemberRow[];
}

export interface BeneficiariesView {
  policy_id: string;
  policy_number: string | null;
  plan_type: PlanType;
  beneficiaries: { id: string; name: string; relationship: string; share_pct: number; is_minor: boolean; guardian_name: string | null; cnic_masked: string | null; date_of_birth: string | null }[];
  total_share: number;
  complete: boolean;
  can_request_change: boolean;
  change_blocked_reason: string | null;
  versions: { sequence: number; at: string; total_share: number; reason: string | null; changed_by: "insurer" | "you"; beneficiaries: { name: string; relationship: string; share_pct: number; is_minor: boolean }[] }[];
}

export interface FamilyRequest {
  id: string;
  family_id: string;
  policy_id: string | null;
  policy_number: string | null;
  kind: string;
  reference: string;
  summary: Record<string, unknown>;
  reason: string | null;
  status: "SUBMITTED" | "WITHDRAWN";
  created_at: string;
  updated_at: string;
}

export interface RenewalView {
  policy_id: string;
  policy_number: string | null;
  status: string;
  contract_renewable: boolean | null;
  annual_premium: number | null;
  next: { due_date: string; amount: number | null; surcharge: number; payable: number; renewal_type_label: string; frequency: string | null; in_ledger: boolean; installment_no: number | null; window_opens_on: string; days_until: number; state: string; period_end: string | null } | null;
  eligible: boolean | null;
  eligibility_message: string | null;
  case: { id: string; status: string; renewal_type_label: string; due_date: string; quoted_amount: number | null; acceptance: { required: boolean; accepted_at: string | null }; closed_reason: string | null; can: { accept: boolean; pay: boolean } } | null;
}

// ── walk-in ──────────────────────────────────────────────────────────────────
export interface WalkInPlan {
  id: string; code: string; label: string; category: "Individual" | "Family" | "Corporate"; type: string; product_category: string; description: string;
  entry_age_min: number; entry_age_max: number; term_min_years: number; term_max_years: number;
}
export interface WalkInLead {
  reference: string;
  applicant_type?: "Self" | "Family";
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

export interface WalkInPayView {
  state: "Open" | "ProofSubmitted" | "Rejected" | "Paid" | "Expired";
  customer_name: string; plan_label: string; amount: number; reference: string | null; channels: string[];
  insurer: { name: string | null; phone: string | null; email: string | null };
  expires_at: string | null; proof_uploaded_at: string | null; review_note: string | null;
  has_receipt?: boolean; proof_method?: string | null; proof_reference?: string | null;
  breakdown?: { base_premium: number; loading_amount: number; policy_fee: number; stamp_duty_amount: number; tax_amount: number; total_premium: number; split?: { upfront_pct: number; upfront_amount: number; remaining_pct: number; remaining_amount: number; message_upfront?: string | null } | null } | null;
  receipt?: { receipt_no: string; received_at: string; amount: number; method: string | null; reference: string | null; confirmed_by: string | null; customer_name: string | null; plan_label: string | null; insurer: { name: string | null } } | null;
}

// ── support tickets ───────────────────────────────────────────────────────────
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED" | "CANCELLED";
export interface SupportTicket { id: string; title: string; category: string; status: TicketStatus; created_at: string; updated_at: string; policy_id: string | null; overdue?: boolean }
export interface SupportTicketDetail extends SupportTicket { description: string; resolution: string | null; version: number; events: { id: number; actor_name: string; kind: string; body: string; created_at: string }[] }
