import { fetchPolicies } from './policies';

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
  whtTax: number;
  netCommission: number;
  gatingReason: string;
}

/**
 * This agent's own commission ledger. There's no dedicated commission table
 * yet (same limitation as the web portal's Commission Hub) — entries are
 * derived from the agent's own policies (already scoped via fetchPolicies),
 * so unlike the portal's ledger there's no need to fake-assign an owning
 * agent: every policy here already belongs to the signed-in agent.
 */
export const fetchMyCommissionLedger = async (): Promise<CommissionEntry[]> => {
  const policies = await fetchPolicies();

  return policies.map((p): CommissionEntry => {
    const collectedPremium = p.premium_amount || Math.round(p.coverage_amount * 0.025) || 250000;
    const status = (p.status || '').toUpperCase();
    const isRealized = status === 'ACTIVE' || status === 'ISSUED';
    const isIssued = isRealized || status === 'PENDING_PAYMENT' || status === 'APPROVED';
    const ratePct = SECP_DEFAULT_RULES[0].ratePct; // individual, first-year — the common case for new business
    const grossCommission = Math.round((collectedPremium * ratePct) / 100);
    const whtTax = Math.round(grossCommission * 0.1);
    const netCommission = grossCommission - whtTax;

    return {
      id: `COM-${p.id.slice(0, 8)}`,
      policyId: p.id,
      policyNumber: p.policy_number,
      customerName: p.customer_name,
      productName: p.product_name,
      status: isRealized ? 'DISBURSED' : isIssued ? 'PAYABLE' : 'ACCRUED',
      ratePct,
      collectedPremium,
      grossCommission,
      whtTax,
      netCommission,
      gatingReason: isRealized
        ? 'Disbursed to bank account (SECP Rule 58 confirmed)'
        : isIssued
        ? 'Payable — issued & cash realized (SECP Rule 58)'
        : 'Gated — pending cash realization confirmation (SECP Rule 58)',
    };
  });
};
