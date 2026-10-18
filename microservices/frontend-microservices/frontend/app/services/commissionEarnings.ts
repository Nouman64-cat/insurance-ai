import api from './api';

export interface Earning {
  disbursement_status?: string;
  id: string; receipt_id: string; policy_id: string; source_id: string;
  basis_amount: string; gross_amount: string; rate_pct: string; split_pct: string;
  policy_year: number; created_at: string;
  rule_code: string | null; rule_version: string | null; disburse_date: string | null;
  snapshot: { payee_name: string; payee_code: string; policy_number: string; customer_name: string; receipt_no: string;
    rule_code?: string; rule_version?: string; is_first_premium?: boolean; commission_recurring?: boolean;
    agreement_code?: string; agreement_version?: number; basis_description: string };
}
export interface SetupPolicy {
  id: string; policy_number: string | null; customer_id: string; customer_name: string;
  product_name: string; status: string; recommended_source_id: string | null;
  assignments: Producer[]; frozen: boolean; ready: boolean; blocking_reasons: string[];
  automatic?: {source_id: string; split_pct: string} | null;
}
export interface Setup {
  actor_id: string;
  customer: {id: string; name: string; assigned_agent_name: string | null; acquisition_source_name: string | null} | null;
  policies: SetupPolicy[]; has_more: boolean; commission_rule_set_code: string;
}
export interface Payee { id: string; name: string; code: string; active: boolean }
export interface AccrualException { id: string; policy_id: string; receipt_id: string; reason: string; status: string }
export interface Producer { source_id: string; split_pct: string }
export interface Summary { entries: number; accrued_gross: string; paid_gross?: string; currency: string; settlement_enabled: boolean }
export interface Disbursement {id: string; status: string; gross_amount: string; created_by: string; approved_by: string | null; payment_reference: string | null; created_at: string}
export interface DisbursementDetail {batch: Disbursement; earnings: Earning[]; events: {id: string; actor_id: string; action: string; detail: string | null; created_at: string}[]}
export interface DisbursementCandidates {items: {earning: Earning; hold_reason: string | null}[]; has_more: boolean; offset: number}
function base() {
  const tenant = localStorage.getItem('tenant_id');
  if (!tenant) throw new Error('Select a tenant to view commission earnings.');
  return `/tenants/${tenant}/commissions`;
}
function auth() { return { headers: { Authorization: `Bearer ${localStorage.getItem('jwt_token') || ''}` } }; }
export const loadEarnings = async (offset = 0) => (await api.get<{items: Earning[]; total: number}>(`${base()}/earnings`, { ...auth(), params: {offset, limit: 50} })).data;
export const loadSummary = async () => (await api.get<Summary>(`${base()}/summary`, auth())).data;
export const loadPayees = async () => (await api.get<Payee[]>(`${base()}/payees`, auth())).data;
export const loadExceptions = async () => (await api.get<AccrualException[]>(`${base()}/exceptions`, auth())).data;
export const loadSetup = async (search = '', customer_id?: string) => (await api.get<Setup>(`${base()}/setup`, {...auth(), params: {search, customer_id}})).data;
export const loadAssignments = async (policy: string) => (await api.get<Producer[]>(`${base()}/policies/${encodeURIComponent(policy)}/assignments`, auth())).data;
export const saveAssignments = async (policy: string, producers: Producer[]) => (await api.put(`${base()}/policies/${encodeURIComponent(policy)}/assignments`, {producers}, auth())).data;
export const reconcileReceipts = async (receipt_ids: string[]) => (await api.post<AccrualException[]>(`${base()}/reconcile`, {receipt_ids}, auth())).data;
export const loadDisbursementCandidates = async (offset = 0) => (await api.get<DisbursementCandidates>(`${base()}/disbursements/eligible`, {...auth(), params: {offset}})).data;
export const loadDisbursements = async (offset = 0) => (await api.get<Disbursement[]>(`${base()}/disbursements`, {...auth(), params: {offset}})).data;
export const loadDisbursement = async (id: string) => (await api.get<DisbursementDetail>(`${base()}/disbursements/${id}`, auth())).data;
export const createDisbursement = async (earning_ids: string[]) => (await api.post<Disbursement>(`${base()}/disbursements`, {earning_ids}, auth())).data;
export const submitDisbursement = async (id: string) => (await api.post(`${base()}/disbursements/${id}/submit`, {}, auth())).data;
export const approveDisbursement = async (id: string) => (await api.post(`${base()}/disbursements/${id}/approve`, {}, auth())).data;
export const rejectDisbursement = async (id: string, reason: string) => (await api.post(`${base()}/disbursements/${id}/reject`, {reason}, auth())).data;
export const recordDisbursementPayment = async (id: string, payment_reference: string, confirmed: boolean) => (await api.post(`${base()}/disbursements/${id}/record-payment`, {payment_reference, confirmed}, auth())).data;
