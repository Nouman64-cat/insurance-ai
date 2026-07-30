import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CounterOffer {
  id: string;
  offer_type: "Loading" | "Exclusion" | "ReducedSumAssured" | "PlanSubstitution";
  status: "Pending" | "Accepted" | "Declined" | "Expired";
  original_coverage_amount: number | null;
  original_premium: number | null;
  original_product_name: string | null;
  revised_loading_pct: number | null;
  revised_coverage_amount: number | null;
  revised_premium: number | null;
  revised_product_name: string | null;
  exclusions: string[] | null;
  reason: string | null;
  valid_until: string;
  responded_at: string | null;
  response_note: string | null;
  created_at: string;
}

export interface RequirementItem {
  id: string;
  requirement_type: string;
  label: string;
  description: string | null;
  status: "Pending" | "Submitted" | "Verified" | "Waived";
  artifact_id: string | null;
  submitted_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  note: string | null;
}

export interface ComplianceCheck {
  id: string;
  check_type: "AML" | "Sanctions" | "SECP";
  status: "Pending" | "Passed" | "Flagged" | "Failed";
  score: number | null;
  details: Record<string, unknown> | null;
  screened_at: string | null;
  cleared_by: string | null;
  cleared_at: string | null;
  clearance_note: string | null;
}

export interface Beneficiary {
  id?: string;
  name: string;
  cnic?: string | null;
  relationship: string;
  share_pct: number;
  date_of_birth?: string | null;
  is_minor?: boolean;
  guardian_name?: string | null;
}

export type DemoBypassFlag =
  | "NotFlagged"
  | "ComplianceBypassed"
  | "BeneficiaryBypassed"
  | "BothBypassed";

export interface BeneficiaryVersion {
  version_sequence: number;
  total_share: number;
  beneficiaries: Beneficiary[];
  changed_by: string | null;
  change_reason: string | null;
  created_at: string;
}

export interface Readiness {
  policy_id: string;
  status: string;
  demo_bypass_flags: DemoBypassFlag;
  steps: {
    revised_terms: { status: string; offer: { id: string; offer_type: string; valid_until: string } | null };
    requirements: { status: string; total: number; cleared: number; outstanding: string[] };
    premium: { status: string; total: number; paid: number };
    compliance: { status: string; checks: { id: string; check_type: string; status: string; score: number | null }[] };
    beneficiaries: { status: string; total_share: number; count: number };
    documents: { status: string; total: number; generated: number };
  };
  ready_to_issue: boolean;
  blockers: string[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

export async function getReadiness(policyId: string): Promise<Readiness> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/pre-issuance`);
  return res.data;
}

// ── Counter-offer ──────────────────────────────────────────────────────────
export async function getCounterOffer(policyId: string): Promise<CounterOffer | null> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/counter-offer`);
  return res.data;
}

export interface CounterOfferCreate {
  offer_type: string;
  revised_loading_pct?: number;
  revised_coverage_amount?: number;
  revised_product_name?: string;
  exclusions?: string[];
  reason?: string;
  valid_days?: number;
  created_by?: string;
}

export async function createCounterOffer(policyId: string, body: CounterOfferCreate): Promise<CounterOffer> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/counter-offer`, body);
  return res.data;
}

export async function acceptCounterOffer(policyId: string, note?: string) {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/counter-offer/accept`, { note });
  return res.data;
}

export async function declineCounterOffer(policyId: string, note?: string) {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/counter-offer/decline`, { note });
  return res.data;
}

// ── Requirements ───────────────────────────────────────────────────────────
export async function getRequirements(policyId: string): Promise<RequirementItem[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/requirements`);
  return res.data;
}

export async function seedRequirements(policyId: string): Promise<RequirementItem[]> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/requirements`, []);
  return res.data;
}

export async function actOnRequirement(
  reqId: string,
  action: "submit" | "verify" | "waive",
  actor?: string,
  note?: string,
): Promise<RequirementItem> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/requirements/${reqId}/${action}`, { actor, note });
  return res.data;
}

// ── Compliance ─────────────────────────────────────────────────────────────
export async function getCompliance(policyId: string): Promise<ComplianceCheck[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/compliance`);
  return res.data;
}

export async function runCompliance(policyId: string): Promise<ComplianceCheck[]> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/compliance/run`);
  return res.data;
}

export async function clearCompliance(checkId: string, note?: string, clearedBy?: string): Promise<ComplianceCheck> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/compliance/${checkId}/clear`, { note, cleared_by: clearedBy });
  return res.data;
}

// ── Beneficiaries ──────────────────────────────────────────────────────────
export async function getBeneficiaries(policyId: string): Promise<{ beneficiaries: Beneficiary[]; total_share: number }> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/beneficiaries`);
  return res.data;
}

export async function replaceBeneficiaries(
  policyId: string,
  beneficiaries: Beneficiary[],
  meta?: { changed_by?: string; change_reason?: string },
) {
  const tid = tenantId();
  const res = await api.put(`/tenants/${tid}/policies/${policyId}/beneficiaries`, {
    beneficiaries,
    changed_by: meta?.changed_by,
    change_reason: meta?.change_reason,
  });
  return res.data;
}

export async function getBeneficiaryHistory(policyId: string): Promise<BeneficiaryVersion[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/beneficiaries/history`);
  return res.data;
}

// ── Documents ──────────────────────────────────────────────────────────────
export async function generateDocuments(policyId: string) {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/documents/generate`);
  return res.data;
}

export function documentDownloadUrl(policyId: string, docId: string): string {
  const tid = tenantId();
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";
  return `${base}/tenants/${tid}/policies/${policyId}/documents/${docId}/download`;
}
