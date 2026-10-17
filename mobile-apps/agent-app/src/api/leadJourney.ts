import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { agentScopeParams } from './agentScope';
import { EntityType, ProfileStatus } from './leads';

/**
 * The lead lifecycle as the agent sees it. The backend models this across three
 * tables — `Customer.profile_status`, `Policy.status`, and `Case.caseStatus` —
 * so this module collapses them into the one linear journey an agent tracks:
 *
 *   Lead  →  Proposal  →  Underwriting  →  Policy Issued
 *
 * Agents have read-only visibility. Nothing here writes.
 */

export type JourneyStageKey = 'LEAD' | 'PROPOSAL' | 'UNDERWRITING' | 'ISSUANCE';

export type StageState =
  | 'complete'
  /** The stage the lead is sitting in right now. */
  | 'current'
  | 'pending'
  /** Stopped here — declined, lapsed, cancelled, or not taken up. */
  | 'blocked';

export interface JourneyStage {
  key: JourneyStageKey;
  title: string;
  /** What this stage means, in the agent's language. */
  description: string;
  state: StageState;
  /** The backend status that produced this state, for the detail line. */
  statusLabel?: string;
  /** ISO timestamp when the stage was reached, when the API reports one. */
  at?: string | null;
}

export interface JourneyPolicy {
  id: string;
  policyNumber?: string | null;
  productName: string;
  coverageAmount: number;
  termYears: number;
  status: string;
  caseNumber?: string | null;
  caseStatus?: string | null;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  createdAt: string;
}

export interface LeadJourney {
  stages: JourneyStage[];
  policies: JourneyPolicy[];
  /** Furthest stage reached — drives the summary headline. */
  currentStage: JourneyStageKey;
  /** True when the journey ended badly (declined/lapsed/cancelled/not interested). */
  isBlocked: boolean;
  blockedReason?: string;
}

// ── Status → stage mapping ───────────────────────────────────────────────────
// Mirrors PolicyStatusEnum in shared/models/core.py. Keep in step with it.

const PROPOSAL_STATUSES = ['Quoted', 'Proposed'];

const UNDERWRITING_STATUSES = [
  'UnderReview',
  'InformationRequested',
  'CounterOffer',
  'ReinsurerReferred',
  'Postponed',
];

/** Underwriting has finished and said yes; the policy is awaiting issuance. */
const APPROVED_STATUSES = ['Approved', 'AcceptedWithLoadings', 'PendingPayment'];

const ISSUED_STATUSES = ['Issued', 'Active', 'GracePeriod'];

const TERMINAL_STATUSES: Record<string, string> = {
  Declined: 'The application was declined by underwriting.',
  NotTakenUp: 'The customer did not take up the policy.',
  Lapsed: 'The policy lapsed — premium was not paid past the grace period.',
  Cancelled: 'The policy was cancelled.',
};

/** Rank a policy status so the furthest-progressed policy wins. */
const rankOf = (status: string): number => {
  if (ISSUED_STATUSES.includes(status)) return 4;
  if (APPROVED_STATUSES.includes(status)) return 3;
  if (UNDERWRITING_STATUSES.includes(status)) return 2;
  if (PROPOSAL_STATUSES.includes(status)) return 1;
  return 0;
};

const STAGE_META: Record<JourneyStageKey, { title: string; description: string }> = {
  LEAD: {
    title: 'Lead captured',
    description: 'Contact details recorded and the lead assigned to an agent.',
  },
  PROPOSAL: {
    title: 'Proposal',
    description: 'A quotation has been prepared and presented to the customer.',
  },
  UNDERWRITING: {
    title: 'Underwriting',
    description: 'Risk assessment, medical and financial checks are under way.',
  },
  ISSUANCE: {
    title: 'Policy issued',
    description: 'Premium settled and cover is live.',
  },
};

const ORDER: JourneyStageKey[] = ['LEAD', 'PROPOSAL', 'UNDERWRITING', 'ISSUANCE'];

// ── Fetching ─────────────────────────────────────────────────────────────────

interface RawPolicy {
  id: string;
  policy_number?: string | null;
  customer_id?: string;
  family_group_id?: string | null;
  product_name?: string;
  coverage_amount?: number;
  term_years?: number;
  status?: string;
  segment?: string;
  case_number?: string | null;
  case_status?: string | null;
  effective_date?: string | null;
  expiry_date?: string | null;
  created_at?: string;
}

const toJourneyPolicy = (p: RawPolicy): JourneyPolicy => ({
  id: p.id,
  policyNumber: p.policy_number ?? null,
  productName: p.product_name || 'Policy',
  coverageAmount: Number(p.coverage_amount) || 0,
  termYears: Number(p.term_years) || 0,
  status: p.status || 'Quoted',
  caseNumber: p.case_number ?? null,
  caseStatus: p.case_status ?? null,
  effectiveDate: p.effective_date ?? null,
  expiryDate: p.expiry_date ?? null,
  createdAt: p.created_at || new Date().toISOString(),
});

export interface FetchJourneyInput {
  leadId: string;
  type: EntityType;
  profileStatus: ProfileStatus;
  createdAt: string;
  /**
   * For family and corporate leads the list endpoints already compute a
   * roll-up status ("Active" | "Pending" | null); individual policies are not
   * enumerated per member, so this stands in for them.
   */
  groupPolicyStatus?: string | null;
}

/**
 * Reads the lead's policies and derives the journey. Individual leads own their
 * policies directly; family and corporate leads roll up through the group
 * policy status the list endpoints already compute.
 */
export const fetchLeadJourney = async (input: FetchJourneyInput): Promise<LeadJourney> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('You are signed out. Please sign in again.');

  let policies: JourneyPolicy[] = [];

  if (input.type === 'INDIVIDUAL') {
    const res = await api.get(`/tenants/${tenantId}/policies`, {
      params: { customer_id: input.leadId },
    });
    policies = (Array.isArray(res.data) ? res.data : []).map(toJourneyPolicy);
  } else if (input.type === 'FAMILY') {
    // Family policies are held against member customers, tagged with the
    // group. The backend's own `family_group_id` filter doesn't match this
    // field (see policies.ts list_policies), so this still filters
    // client-side — but scoped to the agent's own book first, rather than
    // pulling every other agent's policies down to the device to do it.
    const scope = await agentScopeParams('assigned_agent_id');
    const res = await api.get(`/tenants/${tenantId}/policies`, { params: scope });
    policies = (Array.isArray(res.data) ? res.data : [])
      .filter((p: RawPolicy) => p.family_group_id === input.leadId)
      .map(toJourneyPolicy);
  }
  // Corporate master policies are not exposed on the flat policies list, so the
  // journey falls back to `groupPolicyStatus` below.

  return deriveJourney(input, policies);
};

// ── Derivation ───────────────────────────────────────────────────────────────

export const deriveJourney = (
  input: FetchJourneyInput,
  policies: JourneyPolicy[]
): LeadJourney => {
  // The furthest-progressed policy defines the journey. A customer can hold an
  // old declined quote alongside a live one; the live one is what matters.
  const ranked = [...policies].sort((a, b) => rankOf(b.status) - rankOf(a.status));
  const leading = ranked[0];

  const terminal = policies.find((p) => TERMINAL_STATUSES[p.status]);
  const notInterested = input.profileStatus === 'NOT_INTERESTED';

  // Roll-up status stands in for family/corporate, which have no flat policy row.
  const group = (input.groupPolicyStatus ?? '').toLowerCase();
  const groupIssued = group === 'active';
  const groupPending = group === 'pending';

  let reached = 0; // index into ORDER
  if (leading) {
    reached = Math.min(rankOf(leading.status), 3);
    // "Approved / PendingPayment" means underwriting is done but cover is not
    // yet live — the lead sits at the issuance step, not past it.
    if (APPROVED_STATUSES.includes(leading.status)) reached = 3;
    if (ISSUED_STATUSES.includes(leading.status)) reached = 3;
  } else if (groupIssued) {
    reached = 3;
  } else if (groupPending) {
    reached = 1;
  } else if (input.profileStatus === 'UNDERWRITING_READY') {
    reached = 2;
  } else if (input.profileStatus === 'PROSPECT') {
    reached = 1;
  }

  const fullyIssued =
    groupIssued || (leading ? ISSUED_STATUSES.includes(leading.status) : false);

  const isBlocked = notInterested || !!terminal;
  const blockedReason = notInterested
    ? 'The lead was marked as not interested.'
    : terminal
    ? TERMINAL_STATUSES[terminal.status]
    : undefined;

  const stages: JourneyStage[] = ORDER.map((key, index) => {
    let state: StageState;

    if (index < reached) {
      // Everything before the current stage has been passed through.
      state = 'complete';
    } else if (index === reached) {
      // The stage the lead is sitting in. Only the last one can also be
      // "complete", and only once cover is actually live — "Approved" and
      // "PendingPayment" both still sit *at* issuance, not past it.
      state = fullyIssued ? 'complete' : 'current';
    } else {
      // Ahead of the lead: normally pending, but greyed out as unreachable
      // once the journey has terminated.
      state = isBlocked ? 'blocked' : 'pending';
    }

    return {
      key,
      ...STAGE_META[key],
      state,
      statusLabel:
        index === reached && leading
          ? leading.status
          : index === 0
          ? input.profileStatus.replace(/_/g, ' ')
          : undefined,
      at: index === 0 ? input.createdAt : index === reached ? leading?.createdAt ?? null : null,
    };
  });

  return {
    stages,
    policies: ranked,
    currentStage: ORDER[Math.min(reached, ORDER.length - 1)],
    isBlocked,
    blockedReason,
  };
};
