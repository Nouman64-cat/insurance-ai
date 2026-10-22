import api, { keyedPost } from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { agentScopeParams } from './agentScope';
import { fetchProposals } from './proposals';

export interface CaseItem {
  id: string;
  case_number: string;
  applicant_name: string;
  customer_cnic?: string;
  case_type: string;
  priority: string;
  status: string;
  created_at: string;
  customer_id?: string;
  policy_id?: string;
  /** NotStarted | Requested | Draft | Submitted */
  acr_status?: string;
  /** NotSent | Sent | InProgress | Submitted | Verified */
  e_application_status?: string;
  /**
   * A submitted proposal that has no underwriting case yet. The portal shows its
   * folder from submission, so the app does too — but there is no case id to
   * file an ACR or e-application against until underwriting opens one.
   */
  pending?: boolean;
}

export const fetchCases = async (): Promise<CaseItem[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const scope = await agentScopeParams('assigned_user');
  const res = await api.get(`/tenants/${tenantId}/cases`, { params: scope });
  const data = res.data || [];

  return data.map((c: any) => ({
    id: c.caseld || c.id,
    case_number: c.caseNumber || c.case_number || `CASE-${c.id?.slice(0, 6)}`,
    applicant_name: c.applicant_name || c.customer_name || 'Applicant',
    customer_cnic: c.customer_cnic || c.cnic,
    case_type: c.caseType || c.case_type || 'Underwriting',
    priority: c.priorityLevel || c.priority || 'Normal',
    status: c.caseStatus || c.status || 'New',
    created_at: c.createdAt || c.created_at || new Date().toISOString(),
    customer_id: c.customer_id,
    policy_id: c.policy_id ?? undefined,
    acr_status: c.acr_status ?? undefined,
    e_application_status: c.e_application_status ?? undefined,
  }));
};

/** Proposal statuses past Draft — submitted, so the portal already shows a case folder. */
const SUBMITTED_PROPOSAL_STATUSES = new Set([
  'Proposed',
  'UnderReview',
  'InformationRequested',
  'Approved',
  'AcceptedWithLoadings',
]);

/**
 * Cases plus a placeholder folder for every submitted proposal that underwriting
 * has not opened a case for yet — matching the portal, where the folder appears
 * on submission rather than when underwriting starts.
 */
export const fetchCaseFolders = async (): Promise<CaseItem[]> => {
  const [cases, proposals] = await Promise.all([fetchCases(), fetchProposals()]);
  const casePolicies = new Set(cases.map((c) => c.policy_id).filter(Boolean));
  const caseCustomers = new Set(cases.map((c) => c.customer_id).filter(Boolean));

  const pending: CaseItem[] = proposals
    .filter(
      (p) =>
        SUBMITTED_PROPOSAL_STATUSES.has(p.status) &&
        !casePolicies.has(p.policy_id) &&
        !caseCustomers.has(p.customer_id)
    )
    .map((p) => ({
      id: `proposal-${p.id}`,
      case_number: 'Awaiting underwriting',
      applicant_name: p.customer_name || 'Applicant',
      customer_cnic: p.customer_cnic,
      case_type: p.product_name,
      priority: 'Normal',
      status: 'SUBMITTED',
      created_at: p.created_at,
      customer_id: p.customer_id,
      policy_id: p.policy_id,
      pending: true,
    }));

  return [...cases, ...pending].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
};

export const createCase = async (data: {
  applicant_name: string;
  customer_cnic?: string;
  case_type?: string;
  priority?: string;
  /** Set when the case is for an existing lead picked from the list — skips
   * creating a second, duplicate customer record for the same person. */
  customer_id?: string;
}) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');

  let customerId = data.customer_id;

  if (!customerId) {
    // No existing lead was selected — create a new customer record.
    const nameParts = data.applicant_name.trim().split(' ');
    const firstName = nameParts[0] || 'Applicant';
    const lastName = nameParts.slice(1).join(' ');

    const customerRes = await keyedPost('agent-create-customer', `/tenants/${tenantId}/customers`, {
      first_name: firstName,
      last_name: lastName,
      cnic: data.customer_cnic || undefined,
      assigned_agent_id: agentId || undefined,
    });

    customerId = customerRes.data.id;
  }

  // 2. Create the case referencing the new customer
  // Map frontend case types to valid backend enums (Underwriting, Claim, Inquiry)
  let mappedCaseType = 'Underwriting';
  if (data.case_type === 'Claim' || data.case_type === 'Inquiry') {
    mappedCaseType = data.case_type;
  }

  return keyedPost(`agent-create-case:${customerId}`, `/tenants/${tenantId}/cases`, {
    customer_id: customerId,
    caseType: mappedCaseType,
    priorityLevel: data.priority || 'Normal',
    sourceChannel: 'Agent',
    assignedAgentId: agentId || null,
  });
};
