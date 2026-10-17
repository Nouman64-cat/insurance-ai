// Shared types and helpers for the Group Life / Group Family Takaful tabs
// (GROUP_LIFE_PLAN.md Phase 3). The shapes mirror tenant-service's
// routers/organizations.py and routers/group_policies.py responses.

import React from "react";
import api from "@/app/services/api";

export interface GroupMasterPolicy {
  id: string;
  organization_id: string;
  sum_assured_multiple: number;
  term_years: number;
  effective_date: string;
  status: string;
  free_cover_limit: number | null;
  policy_number?: string | null;
  expiry_date?: string | null;
  plan_code?: string | null;
  plan_label?: string | null;
  business_type?: string | null;
}

export interface ServiceBand { min_years: number; amount: number }

export interface BenefitClass {
  id: string;
  name: string;
  basis: "Flat" | "SalaryMultiple" | "ServiceBanded" | "LoanBalance";
  flat_amount?: number | null;
  salary_multiple?: number | null;
  service_bands?: ServiceBand[] | null;
  grades?: string[] | null;
  min_cover?: number | null;
  max_cover?: number | null;
  is_default: boolean;
  coverages?: ClassCoverage[];
}

/** An extra benefit on a class, priced as a share of the member's life cover. */
export interface ClassCoverage {
  id?: string;
  coverage_type: string;
  percent_of_base: number;
  max_amount?: number | null;
}

export const RIDER_LABEL: Record<string, string> = {
  Life: "Life",
  AccidentalDeath: "Accidental Death",
  Disability: "Disability",
  PayContinuation: "Pay Continuation",
  FeeContinuation: "Fee Continuation",
};

export interface GroupMember {
  id: string;
  customer_id: string;
  name: string;
  cnic?: string | null;
  certificate_number?: string | null;
  certificate_status?: string | null;
  benefit_class?: string | null;
  employee_id?: string | null;
  designation?: string | null;
  grade?: string | null;
  coverage_amount: number;
  status: string;
  annual_premium?: number | null;
  cover_note?: string | null;
  underwriting_basis?: string | null;
  dependents: number;
  nominations: number;
}

export interface GroupQuote {
  id: string;
  version: number;
  status: "Open" | "Accepted" | "Declined" | "Superseded" | "Expired" | string;
  business_type: string;
  valid_until: string;
  member_count: number;
  dependent_count: number;
  total_sum_assured: number;
  rate_per_mille: number;
  risk_premium: number;
  policy_fee: number;
  stamp_duty: number;
  total_premium: number;
  wakala_fee_pct?: number | null;
  wakala_fee?: number | null;
  ptf_allocation?: number | null;
  retakaful_share_pct?: number | null;
  retakaful_contribution?: number | null;
  renewal_id?: string | null;
  breakdown: any;
  decided_at?: string | null;
  decided_by?: string | null;
  created_at: string;
}

export interface PanelProps {
  tenantId: string;
  orgId: string;
  mp: GroupMasterPolicy;
  /** Re-read the organization page (master policy status, roster counts) after a change. */
  reload: () => Promise<void> | void;
}

export const pkr = (n: number | null | undefined): string =>
  n == null ? "—" : `PKR ${Math.round(n).toLocaleString()}`;

/** "contribution" for Takaful, "premium" otherwise. */
export const premiumWord = (businessType?: string | null): string =>
  businessType === "Takaful" ? "contribution" : "premium";

export const mpBase = (tenantId: string, orgId: string, mpId: string): string =>
  `/tenants/${tenantId}/organizations/${orgId}/master-policies/${mpId}`;

/**
 * A readable sentence from a failed call. The shared api client flattens an
 * object `detail` into JSON text, so the structured cases (members awaiting an
 * underwriting decision, a rejected census) are parsed back out here.
 */
export function errMsg(err: any, fallback: string): string {
  const raw: string = err?.message ?? fallback;
  try {
    const d = JSON.parse(raw);
    if (d && typeof d === "object" && !Array.isArray(d)) {
      if (Array.isArray(d.pending_members)) {
        return `${d.message ?? "Members are awaiting an underwriting decision."} (${d.pending_members.join(", ")})`;
      }
      if (d.errors || d.missing_fields) return [...(d.missing_fields ?? []), ...(d.errors ?? [])].join("; ");
      if (d.message) return String(d.message);
    }
  } catch { /* plain text */ }
  return raw;
}

/** Save a binary API response (a generated PDF) as a file. */
export async function downloadPdf(url: string, filename: string): Promise<void> {
  const res = await api.get(url, { responseType: "blob" });
  const href = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

export function basisText(c: BenefitClass): string {
  let text: string;
  if (c.basis === "Flat") text = `Flat ${pkr(c.flat_amount)}`;
  else if (c.basis === "SalaryMultiple") text = `${c.salary_multiple}× basic monthly salary`;
  else if (c.basis === "LoanBalance") text = "Outstanding loan balance";
  else text = "By service: " + (c.service_bands ?? []).map((b) => `${b.min_years}+ yrs ${pkr(b.amount)}`).join(", ");
  const caps = [c.min_cover != null ? `min ${pkr(c.min_cover)}` : "", c.max_cover != null ? `max ${pkr(c.max_cover)}` : ""].filter(Boolean);
  return caps.length ? `${text} (${caps.join(", ")})` : text;
}

// Same restrained palette as the rest of the portal: neutral by default, colour only for meaning.
export const STATUS_TONE: Record<string, string> = {
  Active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Guaranteed: "bg-slate-50 text-slate-600 border-slate-200",
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Loaded: "bg-amber-50 text-amber-700 border-amber-200",
  Restricted: "bg-amber-50 text-amber-700 border-amber-200",
  Pending: "bg-amber-50 text-amber-700 border-amber-200",
  PendingPayment: "bg-amber-50 text-amber-700 border-amber-200",
  Open: "bg-blue-50 text-blue-700 border-blue-200",
  Quoted: "bg-blue-50 text-blue-700 border-blue-200",
  Proposed: "bg-slate-100 text-slate-700 border-slate-200",
  Declined: "bg-red-50 text-red-700 border-red-200",
  Superseded: "bg-slate-50 text-slate-500 border-slate-200",
  Expired: "bg-slate-50 text-slate-500 border-slate-200",
};

export const tone = (s: string): string => STATUS_TONE[s] ?? "bg-slate-100 text-slate-700 border-slate-200";

export const Chip = ({ children, status }: { children: React.ReactNode; status: string }) => (
  <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold border ${tone(status)}`}>{children}</span>
);

export interface EndorsementLine {
  action: "ADD" | "DELETE" | "CHANGE";
  member_id?: string | null;
  name: string;
  cnic?: string | null;
  certificate_number?: string | null;
  status: "Applied" | "PendingUnderwriting" | "Declined" | string;
  before?: { cover?: number | null; class?: string | null } | null;
  after?: { cover?: number | null; class?: string | null } | null;
  risk_delta: number;
  note?: string | null;
}

export interface Endorsement {
  id: string;
  number: string;
  endorsement_type: "ADD" | "DELETE" | "CHANGE";
  status: "Applied" | "PendingUnderwriting" | "Cancelled" | string;
  effective_date: string;
  reason?: string | null;
  lines: EndorsementLine[];
  days_remaining: number;
  period_days: number;
  pro_rata_factor: number;
  member_count_delta: number;
  sum_assured_delta: number;
  risk_delta: number;
  stamp_duty_delta: number;
  premium_delta: number;
  wakala_fee_delta?: number | null;
  ptf_delta?: number | null;
  settlement_status: "NotDue" | "Due" | "Settled" | string;
  settlement_reference?: string | null;
  created_at: string;
}

/** A signed PKR amount: "+PKR 1,200" / "−PKR 800". */
export const signedPkr = (n: number): string => `${n >= 0 ? "+" : "−"}${pkr(Math.abs(n))}`;

export interface GroupRenewal {
  id: string;
  period_no: number;
  status: "Open" | "Quoted" | "Accepted" | "Declined" | "Renewed" | "Lapsed" | "Cancelled" | string;
  source: string;
  current_period_start: string;
  current_period_end: string;
  new_period_start: string;
  new_period_end: string;
  experience: {
    premium_earned?: number;
    claims_incurred?: number;
    claim_count?: number;
    claims_paid?: number;
    open_reserve?: number;
    claims_ratio?: number;
    target_loss_ratio?: number;
    credibility?: number;
    raw_factor?: number;
    factor?: number;
    member_count?: number;
  };
  experience_factor: number;
  census_refresh?: any;
  decided_by?: string | null;
  decided_at?: string | null;
  notes?: string | null;
  payment_reference?: string | null;
  amount_paid?: number | null;
  created_at: string;
  quotes?: GroupQuote[];
}

export interface GroupClaim {
  id: string;
  claim_number: string;
  claim_type: string;
  coverage_type?: string | null;
  status: string;
  submitted_amount: number;
  approved_amount?: number | null;
  settlement_amount?: number | null;
  incident_date?: string | null;
  member?: string | null;
  dependent?: string | null;
  certificate_number?: string | null;
  required_documents?: string[];
  missing_documents?: string[];
  documents_on_file?: string[];
}

export interface PayoutShare {
  payee_name: string;
  relationship?: string | null;
  cnic?: string | null;
  share_pct: number;
  amount: number;
  is_minor: boolean;
  guardian_name?: string | null;
  notes: string[];
}

export interface PayoutSplit {
  amount: number;
  source: "nominees" | "override" | "claimant" | string;
  shares: PayoutShare[];
  warnings: string[];
  override_reason?: string | null;
}
