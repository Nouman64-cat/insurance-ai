import api from "./api";

export type PremiumType = "FIRST_YEAR" | "RENEWAL" | "SINGLE_PREMIUM";
export type PolicySegment = "individual" | "group" | "family";
export type CommissionStatus = "ACCRUED" | "PAYABLE" | "DISBURSED" | "CLAWED_BACK" | "HELD";

export interface CommissionRule {
  id: string;
  segment: PolicySegment;
  premiumType: PremiumType;
  policyYear: number;
  ratePct: number; // e.g., 35.0 for FYP, 5.0 for Renewal, 2.5 for Single
  description: string;
  secpRef: string;
}

export interface CommissionLedgerEntry {
  id: string;
  leadId: string;
  agentId: string;
  agentName: string;
  agentCode: string;
  policyId: string;
  policyNumber: string;
  customerName: string;
  segment: PolicySegment;
  productName: string;
  premiumType: PremiumType;
  policyYear: number;
  collectedPremium: number;
  ratePct: number;
  grossCommission: number;
  whtTax: number; // Withholding Tax 10%
  netCommission: number;
  status: CommissionStatus;
  gatingReason: string; // e.g., "Gated: Pending Cash Realization (Rule 58)" or "Payable (Issued & Realized)"
  clawbackAmount?: number;
  isClawback?: boolean;
  clawbackReason?: string;
  accruedAt: string;
  disbursedAt?: string;
}

export interface CommissionSummaryStats {
  totalGrossCommission: number;
  totalAccruedLiability: number; // SECP Form LA Payable
  totalDisbursed: number;
  totalClawbacks: number;
  firstYearCommissionTotal: number;
  renewalCommissionTotal: number;
  singlePremiumCommissionTotal: number;
  activeAgentsCount: number;
}

// ── SECP Statutory Default Commission Matrix ─────────────────────────────────
export const SECP_DEFAULT_RULES: CommissionRule[] = [
  { id: "R1", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 35.0, description: "Individual Life First Year Acquisition Commission", secpRef: "SECP Rules 2017 Rule 24" },
  { id: "R2", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 7.5, description: "Individual Life Year 2 Renewal Persistency Commission", secpRef: "SECP Rules 2017 Form LG" },
  { id: "R3", segment: "individual", premiumType: "RENEWAL", policyYear: 3, ratePct: 5.0, description: "Individual Life Year 3+ Renewal Persistency Commission", secpRef: "SECP Rules 2017 Form LG" },
  { id: "R4", segment: "individual", premiumType: "SINGLE_PREMIUM", policyYear: 1, ratePct: 2.5, description: "Single Premium Upfront Acquisition Commission", secpRef: "Adamjee Life 2024 Report" },
  { id: "R5", segment: "group", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 15.0, description: "Group Corporate Life First Year Commission", secpRef: "SECP Rules 2017 Form LG" },
  { id: "R6", segment: "group", premiumType: "RENEWAL", policyYear: 2, ratePct: 3.0, description: "Group Corporate Life Renewal Trail Commission", secpRef: "SECP Rules 2017 Form LG" },
  { id: "R7", segment: "family", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 30.0, description: "Family Takaful First Year Acquisition Commission", secpRef: "SECP Takaful Rules 2012" },
];

// In-memory cache for generated commission entries (since there's no true commission backend table yet)
let ledgerCache: CommissionLedgerEntry[] | null = null;

export function resetLedgerCache() {
  ledgerCache = null;
}

import { listPolicies } from "./policies";
import { getUserDirectory, listAgents } from "./agents";

// Backend segment values (routers/cases.py, policies.py) are individual |
// family | organization; the SECP rate card's rule conditions speak in
// Individual | Group | Family. "organization" is this platform's group/
// employer-sponsored segment, so it maps to "Group" here — this is the one
// translation point that has to agree with rules.py's COM-GRP-* conditions.
function segmentToCategory(segment: string | undefined): "Individual" | "Group" | "Family" {
  if (segment === "organization" || segment === "group") return "Group";
  if (segment === "family") return "Family";
  return "Individual";
}

function segmentToRuleSegment(category: "Individual" | "Group" | "Family"): PolicySegment {
  return category === "Group" ? "group" : category === "Family" ? "family" : "individual";
}

/**
 * Calls the tenant-service rule engine (commission.secp_rate_card) instead of
 * re-deriving the rate locally. Falls back to the local SECP_DEFAULT_RULES
 * table — still the correct statutory default — if the rule engine is
 * unreachable, so a network hiccup degrades to a known-correct static table
 * instead of failing the ledger/calculator outright.
 */
export async function evaluateCommissionRule(params: {
  segment: string | undefined;
  policyYear: number;
  premiumType: PremiumType;
}): Promise<{ ratePct: number; reason: string }> {
  const category = segmentToCategory(params.segment);
  const ruleSegment = segmentToRuleSegment(category);
  const fallback =
    SECP_DEFAULT_RULES.find(
      (r) =>
        r.segment === ruleSegment &&
        r.premiumType === params.premiumType &&
        r.policyYear === Math.min(params.policyYear, 3)
    ) || { ratePct: params.premiumType === "FIRST_YEAR" ? 35.0 : params.premiumType === "SINGLE_PREMIUM" ? 2.5 : 5.0, description: "Fallback default" };

  try {
    const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    if (!tenantId) throw new Error("No tenant ID found");
    const res = await api.post(`/tenants/${tenantId}/rules/evaluate`, {
      rule_set_code: "commission.secp_rate_card",
      context: {
        category,
        policy_year: params.policyYear,
        premium_type: params.premiumType,
      },
      actor: "Portal",
    });
    const payload = res.data?.outcome_payload;
    if (res.data?.status === "SUCCESS" && typeof payload?.commission_pct === "number") {
      return { ratePct: payload.commission_pct, reason: payload.reason || fallback.description };
    }
  } catch (err) {
    // Rule engine unreachable — fall through to the static SECP default below.
  }
  return { ratePct: fallback.ratePct, reason: fallback.description };
}

export async function listCommissionLedger(): Promise<CommissionLedgerEntry[]> {
  if (ledgerCache !== null) {
    return ledgerCache;
  }
  
  try {
    const tid = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    const [realPolicies, agentUsers] = await Promise.all([
      listPolicies().catch(() => []),
      listAgents(tid).catch(() => []),
    ]);

    const availableAgents = agentUsers.length > 0
      ? agentUsers.map((a, i) => ({ name: a.full_name || a.email, code: `AGT-${7820 + i}`, id: a.id }))
      : [
          { name: "Unassigned Agent", code: "AGT-UNASSIGNED", id: "AGENT-000" }
        ];

    if (realPolicies && realPolicies.length > 0) {
      const realLedgerEntries: CommissionLedgerEntry[] = await Promise.all(
        realPolicies.map(async (p, idx) => {
          const estPremium = Math.round(p.coverage_amount * 0.025) || 250000;
          const isIssued = p.status === "Active" || p.status === "PendingPayment";
          const isRealized = p.status === "Active";
          const category = segmentToCategory(p.segment);
          const { ratePct } = await evaluateCommissionRule({
            segment: p.segment,
            policyYear: 1,
            premiumType: "FIRST_YEAR",
          });
          const gross = Math.round((estPremium * ratePct) / 100);
          const wht = Math.round(gross * 0.10);
          const net = gross - wht;

          const assignedAgent = availableAgents[idx % availableAgents.length];

          return {
            id: `COM-2026-00${idx + 1}`,
            leadId: `LEAD-${9080 + idx + 1}`,
            agentId: assignedAgent.id,
            agentName: assignedAgent.name,
            agentCode: assignedAgent.code,
            policyId: p.id,
            policyNumber: p.policy_number || `PL-ADAM-${98210 + idx}`,
            customerName: p.customer_name || "Valued Policyholder",
            segment: segmentToRuleSegment(category),
            productName: p.product_name || "Adamjee Life Protection Plan",
            premiumType: "FIRST_YEAR" as PremiumType,
            policyYear: 1,
            collectedPremium: estPremium,
            ratePct: ratePct,
            grossCommission: gross,
            whtTax: wht,
            netCommission: net,
            status: isRealized ? "DISBURSED" : isIssued ? "PAYABLE" : "ACCRUED" as CommissionStatus,
            gatingReason: isRealized
              ? "Disbursed to Agent Bank Account (SECP Rule 58 Confirmed)"
              : isIssued
              ? "Payable (Policy Issued & Premium Collected - SECP Rule 58)"
              : "Gated: Pending Premium Collection (SECP Rule 58)",
            accruedAt: p.created_at || new Date().toISOString().replace("T", " ").slice(0, 19),
          };
        })
      );

      ledgerCache = realLedgerEntries;
      return ledgerCache;
    }
  } catch (err) {
    console.warn("Could not fetch backend policies for commissions", err);
  }
  
  ledgerCache = [];
  return ledgerCache;
}

export async function getCommissionStats(): Promise<CommissionSummaryStats> {
  const currentLedger = await listCommissionLedger();
  const totalGrossCommission = currentLedger.reduce((sum, l) => sum + (l.isClawback ? 0 : l.grossCommission), 0);
  const totalAccruedLiability = currentLedger
    .filter((l) => l.status === "ACCRUED" || l.status === "PAYABLE")
    .reduce((sum, l) => sum + l.netCommission, 0);
  const totalDisbursed = currentLedger
    .filter((l) => l.status === "DISBURSED")
    .reduce((sum, l) => sum + l.netCommission, 0);
  const totalClawbacks = currentLedger
    .filter((l) => l.isClawback || l.status === "CLAWED_BACK")
    .reduce((sum, l) => sum + (l.clawbackAmount || l.netCommission), 0);

  const firstYearCommissionTotal = currentLedger
    .filter((l) => l.premiumType === "FIRST_YEAR" && !l.isClawback)
    .reduce((sum, l) => sum + l.netCommission, 0);

  const renewalCommissionTotal = currentLedger
    .filter((l) => l.premiumType === "RENEWAL" && !l.isClawback)
    .reduce((sum, l) => sum + l.netCommission, 0);

  const singlePremiumCommissionTotal = currentLedger
    .filter((l) => l.premiumType === "SINGLE_PREMIUM" && !l.isClawback)
    .reduce((sum, l) => sum + l.netCommission, 0);

  const activeAgentsCount = new Set(currentLedger.map((l) => l.agentId)).size;

  return {
    totalGrossCommission,
    totalAccruedLiability,
    totalDisbursed,
    totalClawbacks,
    firstYearCommissionTotal,
    renewalCommissionTotal,
    singlePremiumCommissionTotal,
    activeAgentsCount,
  };
}

export async function disburseCommission(ledgerId: string): Promise<CommissionLedgerEntry> {
  const entry = (ledgerCache || []).find((l) => l.id === ledgerId);
  if (!entry) throw new Error("Commission entry not found");
  entry.status = "DISBURSED";
  entry.disbursedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  entry.gatingReason = `Disbursed to Bank Account (${entry.agentName})`;
  return { ...entry };
}

export async function triggerClawback(ledgerId: string, reason: string): Promise<CommissionLedgerEntry> {
  const entry = (ledgerCache || []).find((l) => l.id === ledgerId);
  if (!entry) throw new Error("Commission entry not found");
  entry.status = "CLAWED_BACK";
  entry.isClawback = true;
  entry.clawbackAmount = entry.netCommission;
  entry.clawbackReason = reason;
  entry.gatingReason = `Clawed Back / Reversed: ${reason}`;
  return { ...entry };
}

export async function calculateCommissionForPolicy(params: {
  leadId: string;
  agentId: string;
  agentName: string;
  policyId: string;
  policyNumber: string;
  customerName: string;
  segment: PolicySegment;
  productName: string;
  premiumType: PremiumType;
  policyYear: number;
  collectedPremium: number;
  isRealized: boolean;
  isIssued: boolean;
}): Promise<CommissionLedgerEntry> {
  const { ratePct } = await evaluateCommissionRule({
    segment: params.segment,
    policyYear: params.policyYear,
    premiumType: params.premiumType,
  });

  const gross = Math.round((params.collectedPremium * ratePct) / 100);
  const wht = Math.round(gross * 0.10); // 10% withholding tax
  const net = gross - wht;

  let status: CommissionStatus = "ACCRUED";
  let gatingReason = "Gated: Pending Premium Collection (SECP Rule 58)";

  if (params.isRealized && params.isIssued) {
    status = "PAYABLE";
    gatingReason = "Payable (Policy Issued & Premium Collected - SECP Rule 58)";
  }

  const newEntry: CommissionLedgerEntry = {
    id: `COM-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`,
    leadId: params.leadId,
    agentId: params.agentId,
    agentName: params.agentName,
    agentCode: `AGT-${Math.floor(1000 + Math.random() * 9000)}`,
    policyId: params.policyId,
    policyNumber: params.policyNumber,
    customerName: params.customerName,
    segment: params.segment,
    productName: params.productName,
    premiumType: params.premiumType,
    policyYear: params.policyYear,
    collectedPremium: params.collectedPremium,
    ratePct,
    grossCommission: gross,
    whtTax: wht,
    netCommission: net,
    status: status,
    gatingReason: gatingReason,
    accruedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
  };

  if (!ledgerCache) ledgerCache = [];
  ledgerCache.unshift(newEntry);
  return newEntry;
}
