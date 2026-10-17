import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './api';

export type PremiumType = 'FIRST_YEAR' | 'RENEWAL' | 'SINGLE_PREMIUM';
export type CommissionStatus = 'ACCRUED' | 'PAYABLE' | 'DISBURSED';

export interface CommissionRule {
  id: string;
  segment: 'individual' | 'group' | 'family';
  premiumType: PremiumType;
  policyYear: number;
  ratePct: number;
  description: string;
  secpRef: string;
}

// ── SECP Statutory Default Commission Matrix (SECP Insurance Rules 2017) ────
// Mirrors frontend/app/services/commissions.ts — same statutory rate table,
// same source of truth, so the mobile Rate Card and the portal never disagree.
export const SECP_DEFAULT_RULES: CommissionRule[] = [
  { id: 'R1', segment: 'individual', premiumType: 'FIRST_YEAR', policyYear: 1, ratePct: 35.0, description: 'Individual Life First Year Acquisition Commission', secpRef: 'SECP Rules 2017 Rule 24' },
  { id: 'R2', segment: 'individual', premiumType: 'RENEWAL', policyYear: 2, ratePct: 7.5, description: 'Individual Life Year 2 Renewal Persistency Commission', secpRef: 'SECP Rules 2017 Form LG' },
  { id: 'R3', segment: 'individual', premiumType: 'RENEWAL', policyYear: 3, ratePct: 5.0, description: 'Individual Life Year 3+ Renewal Persistency Commission', secpRef: 'SECP Rules 2017 Form LG' },
  { id: 'R4', segment: 'individual', premiumType: 'SINGLE_PREMIUM', policyYear: 1, ratePct: 2.5, description: 'Single Premium Upfront Acquisition Commission', secpRef: 'Adamjee Life 2024 Report' },
  { id: 'R5', segment: 'group', premiumType: 'FIRST_YEAR', policyYear: 1, ratePct: 15.0, description: 'Group Corporate Life First Year Commission', secpRef: 'SECP Rules 2017 Form LG' },
  { id: 'R6', segment: 'group', premiumType: 'RENEWAL', policyYear: 2, ratePct: 3.0, description: 'Group Corporate Life Renewal Trail Commission', secpRef: 'SECP Rules 2017 Form LG' },
  { id: 'R7', segment: 'family', premiumType: 'FIRST_YEAR', policyYear: 1, ratePct: 30.0, description: 'Family Takaful First Year Acquisition Commission', secpRef: 'SECP Takaful Rules 2012' },
];

// Backend segment values (routers/cases.py, policies.py) are individual |
// family | organization; the SECP rate card's rule conditions speak in
// Individual | Group | Family. "organization" is this platform's group/
// employer-sponsored segment, so it maps to "Group" here.
function segmentToCategory(segment: string | undefined): 'Individual' | 'Group' | 'Family' {
  if (segment === 'organization') return 'Group';
  if (segment === 'family') return 'Family';
  return 'Individual';
}

/**
 * Calls the tenant-service rule engine (commission.secp_rate_card) instead of
 * a hardcoded rate. Falls back to the local SECP_DEFAULT_RULES table (still
 * the correct statutory default) if the rule engine is unreachable, so a
 * network hiccup degrades to the known-correct static table rather than
 * failing the ledger screen outright.
 */
async function evaluateCommissionRule(params: {
  segment: string | undefined;
  policyYear: number;
  premiumType: PremiumType;
}): Promise<{ ratePct: number; reason: string }> {
  const category = segmentToCategory(params.segment);
  const fallback = SECP_DEFAULT_RULES.find(
    (r) => r.segment === (category === 'Group' ? 'group' : category === 'Family' ? 'family' : 'individual')
      && r.premiumType === params.premiumType
      && r.policyYear === Math.min(params.policyYear, 3)
  ) || SECP_DEFAULT_RULES[0];

  try {
    const tenantId = await AsyncStorage.getItem('tenant_id');
    if (!tenantId) throw new Error('No tenant ID found');
    const res = await api.post(`/tenants/${tenantId}/rules/evaluate`, {
      rule_set_code: 'commission.secp_rate_card',
      context: {
        category,
        policy_year: params.policyYear,
        premium_type: params.premiumType,
      },
      actor: 'Agent App',
    });
    const payload = res.data?.outcome_payload;
    if (res.data?.status === 'SUCCESS' && typeof payload?.commission_pct === 'number') {
      return { ratePct: payload.commission_pct, reason: payload.reason || fallback.description };
    }
  } catch (e) {
    // Rule engine unreachable — fall through to the static SECP default below.
  }
  return { ratePct: fallback.ratePct, reason: fallback.description };
}

export interface CommissionEntry {
  id: string;
  policyId: string;
  policyNumber?: string;
  customerName: string;
  productName: string;
  status: CommissionStatus;
  ratePct: number;
  collectedPremium: number;
  grossCommission: number;
  splitPct: number;
  gatingReason: string;
}

/** Read only persisted earnings; never infer collection or disbursement from a policy status. */
export const fetchMyCommissionLedger = async (): Promise<CommissionEntry[]> => {
  const tenant = await AsyncStorage.getItem('tenant_id');
  if (!tenant) throw new Error('No tenant session');
  const entries: CommissionEntry[] = [];
  let offset = 0;
  while (true) {
    const {data} = await api.get(`/tenants/${tenant}/commissions/earnings`, {params: {offset, limit: 500}});
    entries.push(...data.items.map((e: any): CommissionEntry => ({
      id: e.id, policyId: e.policy_id, policyNumber: e.snapshot.policy_number,
      customerName: e.snapshot.customer_name || 'Customer', productName: e.snapshot.product_name || '',
      status: 'ACCRUED', ratePct: Number(e.rate_pct), splitPct: Number(e.split_pct),
      collectedPremium: Number(e.basis_amount), grossCommission: Number(e.gross_amount),
      gatingReason: `Receipt ${e.snapshot.receipt_no} · ${e.snapshot.agreement_code} v${e.snapshot.agreement_version}. Tax and settlement are not enabled.`,
    })));
    offset += data.items.length;
    if (!data.items.length || offset >= data.total) break;
  }
  return entries;
};
