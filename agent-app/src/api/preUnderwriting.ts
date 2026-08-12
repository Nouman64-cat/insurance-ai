import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { agentScopeParams } from './agentScope';

/** One of the 6 pre-underwriting gate statuses, as returned by tenant-service. */
export interface PreUnderwritingCase {
  id: string;
  case_number: string;
  customer_name: string;
  customer_cnic?: string;
  case_status: string;
  e_application_status: string;
  acr_status: string;
  compliance_status: string;
  ipp_status: string;
  insurance_history_status: string;
  medical_exam_status: string;
  policy_id?: string;
  /** Set once the risk engine has actually run for this case — null/undefined
   * means the 6 gates may be clear but underwriting hasn't looked at it yet.
   * This is what actually separates "ready for Risk Engine" from
   * "Post-Underwriting" — the portal gates its own Post-Underwriting board on
   * the policy having moved past a bare Quoted/gates-only state, which in
   * practice never happens before a decision exists. */
  latest_ai_decision?: string | null;
  latest_composite_score?: number | null;
}

const GATE_DONE: Record<string, string[]> = {
  e_application_status: ['Verified'],
  acr_status: ['Submitted'],
  compliance_status: ['Passed', 'Cleared'],
  ipp_status: ['Realized'],
  insurance_history_status: ['Clear', 'Cleared'],
  medical_exam_status: ['Completed', 'Waived', 'NotRequired'],
};

export const isGateDone = (field: keyof typeof GATE_DONE, value: string) =>
  GATE_DONE[field].includes(value);

export const isPreUnderwritingComplete = (item: PreUnderwritingCase) =>
  (Object.keys(GATE_DONE) as (keyof typeof GATE_DONE)[]).every((field) =>
    isGateDone(field, item[field as keyof PreUnderwritingCase] as string)
  );

/** Cases still moving through the 6 pre-underwriting gates — the ones this
 * agent should be actively working, scoped to their own book. A case doesn't
 * get a policy_id until it's been submitted to underwriting with one
 * attached, so this must NOT require policy_id — doing so hid every
 * freshly-created case from the mobile queue while the portal (which has no
 * such requirement) still showed it. Only `fetchPostUnderwritingCases` below
 * needs a policy_id, since it checks pre-issuance readiness for one. */
export const fetchPreUnderwritingCases = async (): Promise<PreUnderwritingCase[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const scope = await agentScopeParams('assigned_user');

  const res = await api.get(`/tenants/${tenantId}/cases`, { params: scope });
  const cases = res.data || [];

  return cases.map((c: any) => ({
    id: c.caseld || c.id,
    case_number: c.caseNumber || c.case_number || `CASE-${(c.id ?? '').slice(0, 6)}`,
    customer_name: c.customer_name || c.applicant_name || 'Applicant',
    customer_cnic: c.customer_cnic,
    case_status: c.caseStatus || c.case_status || 'New',
    e_application_status: c.e_application_status || 'NotSent',
    acr_status: c.acr_status || 'NotStarted',
    compliance_status: c.compliance_status || 'NotStarted',
    ipp_status: c.ipp_status || 'NotStarted',
    insurance_history_status: c.insurance_history_status || 'NotStarted',
    medical_exam_status: c.medical_exam_status || 'NotAssessed',
    policy_id: c.policy_id,
    latest_ai_decision: c.latest_ai_decision ?? null,
    latest_composite_score: c.latest_composite_score ?? null,
  }));
};

/** Cases that have cleared all 6 pre-underwriting gates but have no risk
 * decision yet — these are what the Risk Engine tab should show as pending,
 * rather than nothing, once a case leaves Pre-Underwriting. */
export const fetchAwaitingRiskAssessment = async (): Promise<PreUnderwritingCase[]> => {
  const cases = await fetchPreUnderwritingCases();
  return cases.filter((c) => isPreUnderwritingComplete(c) && !c.latest_ai_decision);
};

export interface ReadinessStep {
  status: string;
}

export interface PolicyReadiness {
  policy_id: string;
  status: string;
  steps: {
    revised_terms: ReadinessStep;
    requirements: ReadinessStep & { total: number; cleared: number };
    premium: ReadinessStep & { total: number; paid: number };
    compliance: ReadinessStep;
  };
}

/** Stage A / "Post-Underwriting" readiness for a single policy — the same
 * data the web portal's Post-Underwriting queue reads. */
export const fetchReadiness = async (policyId: string): Promise<PolicyReadiness | null> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  try {
    const res = await api.get(`/tenants/${tenantId}/policies/${policyId}/pre-issuance`);
    return res.data;
  } catch {
    return null;
  }
};

/** Post-Underwriting cases (Stage A readiness) for this agent's own cases
 * that have moved past the 6 gates, been through the risk engine, and have a
 * policy to verify. `GET .../pre-issuance` has no status guard of its own —
 * it'll compute *something* for any policy_id, gates-cleared or not — so
 * requiring a risk decision here is what actually keeps a case out of this
 * queue until underwriting has looked at it, matching the portal's own
 * Post-Underwriting board (which only lists policies that have moved past a
 * bare Quoted state). Without this a case could appear here the moment its
 * 6 gates cleared, before Risk Engine ever ran. */
export const fetchPostUnderwritingCases = async (): Promise<
  Array<PreUnderwritingCase & { readiness: PolicyReadiness | null }>
> => {
  const cases = await fetchPreUnderwritingCases();
  const eligible = cases.filter((c) => isPreUnderwritingComplete(c) && !!c.policy_id && !!c.latest_ai_decision);
  const readiness = await Promise.all(eligible.map((c) => fetchReadiness(c.policy_id!)));
  return eligible.map((c, i) => ({ ...c, readiness: readiness[i] }));
};

// ── Gate 3 · Compliance ──────────────────────────────────────────────────────

export interface ComplianceCheckResult {
  id: string;
  check_type: string;
  status: 'Pending' | 'Passed' | 'Flagged' | 'Failed';
}

export interface ComplianceRunResult {
  overall_status: 'Passed' | 'Flagged' | 'Failed';
  checks: ComplianceCheckResult[];
}

/** Runs PEP, Sanctions, AML and SECP screening for the case — the same check
 * the portal's "Run Compliance" button triggers. Under manual-clearance mode
 * (the default) even a clean engine pass comes back Flagged until an officer
 * explicitly clears it with `clearComplianceCheck` below — a pass here is not
 * the same as the gate being done. */
export const runComplianceScreening = async (caseId: string): Promise<ComplianceRunResult> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/compliance/run`);
  return res.data;
};

/** Manual officer override for a Flagged/Failed check — the step that
 * actually clears Gate 3 in the common case, since a fresh screen almost
 * always comes back Flagged pending this. */
export const clearComplianceCheck = async (checkId: string, note?: string): Promise<void> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  await api.post(`/tenants/${tenantId}/compliance/${checkId}/clear`, { note });
};

// ── Gate 4 · Initial Premium Payment ─────────────────────────────────────────

export type PaymentMethod = 'JazzCash' | 'Easypaisa' | 'Card' | 'BankTransfer';

export const PAYMENT_METHODS: { code: PaymentMethod; label: string }[] = [
  { code: 'JazzCash', label: 'JazzCash' },
  { code: 'Easypaisa', label: 'Easypaisa' },
  { code: 'Card', label: 'Debit / Credit Card' },
  { code: 'BankTransfer', label: 'Bank Transfer (IBFT / Raast)' },
];

/**
 * Collects the first premium on the spot: initiates a payment intent on the
 * chosen channel, then immediately confirms it realized. There's no live PSP
 * behind this (services/tenant-service/services/payment_gateway.py is a mock
 * that settles synchronously), so unlike a real checkout this is a single
 * agent action rather than a wait-for-webhook flow.
 */
export const collectInitialPremium = async (
  caseId: string,
  method: PaymentMethod
): Promise<{ amount: number; status: string }> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const initiated = await api.post(`/tenants/${tenantId}/cases/${caseId}/ipp/initiate`, { method });
  const confirmed = await api.post(`/tenants/${tenantId}/cases/${caseId}/ipp/confirm`, {
    method,
    realize: true,
  });
  return { amount: initiated.data?.amount, status: confirmed.data?.status };
};

// ── Gate 5 · Insurance History ───────────────────────────────────────────────

export interface InsuranceHistoryResult {
  status: string;
}

/** (Re-)runs the internal + declared-external cover screen for the case. */
export const runInsuranceHistoryCheck = async (caseId: string): Promise<InsuranceHistoryResult> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/insurance-history/run`);
  return res.data;
};

// ── Gate 6 · Medical Examination ─────────────────────────────────────────────

export interface MedicalInvite {
  token: string;
  link_path: string;
  expires_at: string;
  status: string;
}

export interface MedicalAssessment {
  status: 'Required' | 'NotRequired' | 'Invited' | 'Scheduled' | 'Completed' | 'Waived';
}

/** Reads the non-medical-limit grid (age, sum at risk, smoker status, adverse
 * e-application disclosures) and decides whether this life needs a panel
 * exam at all. Must run before `inviteMedicalExam` — inviting a case that
 * hasn't been assessed yet is a 409 on the backend ("Run the non-medical-limit
 * assessment for this case before inviting the customer"). */
export const assessMedicalExam = async (caseId: string): Promise<MedicalAssessment> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/medical-exam/assess`);
  return res.data;
};

/** Sends the customer a tokenized link to pick their panel clinic and slot.
 * Requires the non-medical-limit assessment to have already run for this
 * case — the backend 409s with a clear message if it hasn't. */
export const inviteMedicalExam = async (caseId: string): Promise<MedicalInvite> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  const res = await api.post(`/tenants/${tenantId}/cases/${caseId}/medical-exam/invite`);
  return res.data;
};
