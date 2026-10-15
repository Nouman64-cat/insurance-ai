import api from './api';

export interface Earning {
  id: string; receipt_id: string; policy_id: string; source_id: string;
  basis_amount: string; gross_amount: string; rate_pct: string; split_pct: string;
  policy_year: number; created_at: string;
  snapshot: { payee_name: string; payee_code: string; policy_number: string; customer_name: string; receipt_no: string; agreement_code: string; agreement_version: number; basis_description: string };
}
export interface Agreement {
  id: string; code: string; version: number; name: string; first_year_pct: string;
  renewal_pct: string; status: string; effective_from: string; effective_to: string | null;
  created_by?: string;
}
export interface SetupPolicy {
  id: string; policy_number: string | null; customer_id: string; customer_name: string;
  product_name: string; status: string; recommended_source_id: string | null;
  assignments: Producer[]; frozen: boolean; ready: boolean; blocking_reasons: string[];
}
export interface Setup {
  actor_id: string;
  customer: {id: string; name: string; assigned_agent_name: string | null; acquisition_source_name: string | null} | null;
  policies: SetupPolicy[]; has_more: boolean; approved_agreement_count: number;
}
export interface Payee { id: string; name: string; code: string; active: boolean }
export interface AccrualException { id: string; policy_id: string; receipt_id: string; reason: string; status: string }
export interface Producer { source_id: string; agreement_id: string; split_pct: string }
export interface Summary { entries: number; accrued_gross: string; currency: string; settlement_enabled: boolean }
function base() {
  const tenant = localStorage.getItem('tenant_id');
  if (!tenant) throw new Error('Select a tenant to view commission earnings.');
  return `/tenants/${tenant}/commissions`;
}
function auth() { return { headers: { Authorization: `Bearer ${localStorage.getItem('jwt_token') || ''}` } }; }
export const loadEarnings = async (offset = 0) => (await api.get<{items: Earning[]; total: number}>(`${base()}/earnings`, { ...auth(), params: {offset, limit: 50} })).data;
export const loadSummary = async () => (await api.get<Summary>(`${base()}/summary`, auth())).data;
export const loadPayees = async () => (await api.get<Payee[]>(`${base()}/payees`, auth())).data;
export const loadAgreements = async () => (await api.get<Agreement[]>(`${base()}/agreements`, auth())).data;
export const loadExceptions = async () => (await api.get<AccrualException[]>(`${base()}/exceptions`, auth())).data;
export const loadSetup = async (search = '', customer_id?: string) => (await api.get<Setup>(`${base()}/setup`, {...auth(), params: {search, customer_id}})).data;
export const createAgreement = async (body: Omit<Agreement, 'id' | 'status'>) => (await api.post(`${base()}/agreements`, body, auth())).data;
export const approveAgreement = async (id: string) => (await api.post(`${base()}/agreements/${id}/approve`, {}, auth())).data;
export const loadAssignments = async (policy: string) => (await api.get<Producer[]>(`${base()}/policies/${encodeURIComponent(policy)}/assignments`, auth())).data;
export const saveAssignments = async (policy: string, producers: Producer[]) => (await api.put(`${base()}/policies/${encodeURIComponent(policy)}/assignments`, {producers}, auth())).data;
export const reconcileReceipts = async (receipt_ids: string[]) => (await api.post<AccrualException[]>(`${base()}/reconcile`, {receipt_ids}, auth())).data;
