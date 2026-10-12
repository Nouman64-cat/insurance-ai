import { listPolicies } from "./policies";
import { listAgents } from "./agents";
import api from "./api";

/**
 * Commission engine.
 *
 * A policy does not pay one person. Every premium collection fans out to the
 * whole distribution stack that produced it: the writing producer (or several,
 * on a split case), the managers above them (hierarchy overrides), the corporate
 * channel that owns the relationship (bank, corporate agent, broker), that
 * channel's own front-line staff, and any introducer entitled to a referral fee.
 * `computeCommissionWaterfall` is the single place where that fan-out happens —
 * everything else (ledger, payout runs, statements) consumes its output.
 *
 * There is still no commission table in the backend, so entries are derived
 * from real policies and held in memory for the session (same limitation the
 * ledger has always had) — but the shape of what's derived is the real thing:
 * payee registry, versioned rate card, split/override basis, per-payee tax
 * profile, gating checks, maker–checker payout runs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Domain vocabulary
// ─────────────────────────────────────────────────────────────────────────────

export type PremiumType = "FIRST_YEAR" | "RENEWAL" | "SINGLE_PREMIUM";
export type PolicySegment = "individual" | "group" | "family";

export type CommissionStatus =
  | "ACCRUED"              // earned, but no tranche has fallen due yet
  | "PAYABLE"              // at least one tranche is due and releasable
  | "IN_RUN"               // due tranches locked into a payout run
  | "PARTIALLY_RELEASED"   // some tranches paid, later ones still to vest
  | "DISBURSED"            // every tranche released
  | "CLAWED_BACK"
  | "HELD";                // withheld (licence, suspension, ceiling breach, dispute)

/** How the business reached the insurer. Drives which rate-card rows apply. */
export type DistributionChannel =
  | "DIRECT_AGENCY"    // insurer's own tied agency force
  | "BANCASSURANCE"    // partner bank distributes
  | "BROKER"           // SECP-licensed insurance broker
  | "CORPORATE_AGENT"  // corporate insurance agent (non-bank)
  | "DIGITAL_DIRECT"   // own website / app / telesales — no external payee
  | "REFERRAL";        // introducer refers, insurer's own staff closes

/** Everyone who can be owed money on a policy. */
export type PayeeType =
  | "AGENT"              // individual licensed producer
  | "SALES_MANAGER"      // unit/sales manager — override on downline production
  | "BRANCH_MANAGER"     // branch/regional override
  | "AGENCY"             // corporate insurance agent
  | "BROKER"             // licensed insurance broker (brokerage, not commission)
  | "BANK_PARTNER"       // bancassurance partner bank
  | "BANK_SALES_OFFICER" // bank's insurance sales officer / relationship manager
  | "REFERRAL_PARTNER"   // introducer, not licensed to sell
  | "HOUSE";             // retained by the insurer (direct/digital business)

/** What the rate is applied to. Overrides are a cut of someone else's earning. */
export type CommissionBasis =
  | "PREMIUM"              // % of the collected premium
  | "PRODUCER_COMMISSION"  // % of the writing producer's gross commission
  | "PARTNER_COMMISSION";  // % of the channel partner's gross commission

export type CommissionEntryKind = "COMMISSION" | "OVERRIDE" | "PARTNER_FEE" | "REFERRAL_FEE" | "BONUS" | "CLAWBACK";

export type TaxFilerStatus = "FILER" | "NON_FILER";

export const PAYEE_TYPE_LABELS: Record<PayeeType, string> = {
  AGENT: "Agent",
  SALES_MANAGER: "Sales Manager",
  BRANCH_MANAGER: "Branch Manager",
  AGENCY: "Corporate Agent",
  BROKER: "Insurance Broker",
  BANK_PARTNER: "Bank Partner",
  BANK_SALES_OFFICER: "Bank Sales Officer",
  REFERRAL_PARTNER: "Referral Partner",
  HOUSE: "Direct Business / House",
};

export const CHANNEL_LABELS: Record<DistributionChannel, string> = {
  DIRECT_AGENCY: "Direct Agency",
  BANCASSURANCE: "Bancassurance",
  BROKER: "Broker",
  CORPORATE_AGENT: "Corporate Agent",
  DIGITAL_DIRECT: "Digital / Direct",
  REFERRAL: "Referral",
};

export const BASIS_LABELS: Record<CommissionBasis, string> = {
  PREMIUM: "Collected Premium",
  PRODUCER_COMMISSION: "Agent's Commission",
  PARTNER_COMMISSION: "Partner's Commission",
};

/** Payee types that may not be paid without a valid licence on file. */
const LICENCE_REQUIRED: PayeeType[] = ["AGENT", "AGENCY", "BROKER", "BANK_PARTNER"];

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
//
// Statutory numbers live here rather than scattered through the engine so a
// tenant can be re-pointed at its own approved schedule. The tax bands follow
// s.233 of the Income Tax Ordinance 2001 (brokerage & commission): life agents
// earning under Rs 500k/yr are withheld at 8% (filer) / 16% (non-filer),
// everyone else at 12% / 24%.
// ─────────────────────────────────────────────────────────────────────────────

export interface CommissionConfig {
  /** Cooling-off window; commission is not releasable until it elapses. */
  freeLookDays: number;
  /** Net below this is carried forward instead of paid (bank charge floor). */
  minPayoutThreshold: number;
  /** s.233 withholding bands, percent. */
  whtLifeAgentLowBandFiler: number;
  whtLifeAgentLowBandNonFiler: number;
  whtStandardFiler: number;
  whtStandardNonFiler: number;
  /** Annual commission below which a life agent falls in the low band. */
  lifeAgentLowBandAnnualLimit: number;
  /** Provincial sales tax on services, withheld from corporate payees. */
  salesTaxOnServicesPct: number;
  /** Ceiling on total commission across every payee, % of premium. */
  payoutCeilingPct: Record<PolicySegment, Record<PremiumType, number>>;
  currency: string;
}

export const COMMISSION_CONFIG: CommissionConfig = {
  freeLookDays: 14,
  minPayoutThreshold: 500,
  whtLifeAgentLowBandFiler: 8,
  whtLifeAgentLowBandNonFiler: 16,
  whtStandardFiler: 12,
  whtStandardNonFiler: 24,
  lifeAgentLowBandAnnualLimit: 500_000,
  salesTaxOnServicesPct: 15,
  payoutCeilingPct: {
    individual: { FIRST_YEAR: 55, RENEWAL: 15, SINGLE_PREMIUM: 6 },
    group: { FIRST_YEAR: 20, RENEWAL: 6, SINGLE_PREMIUM: 5 },
    family: { FIRST_YEAR: 45, RENEWAL: 14, SINGLE_PREMIUM: 6 },
  },
  currency: "PKR",
};

export function updateCommissionConfig(patch: Partial<CommissionConfig>) {
  Object.assign(COMMISSION_CONFIG, patch);
  resetLedgerCache();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate card
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a row's rate comes from regulation or from a negotiated agreement.
 * The distinction matters: a statutory row may not be edited upward by a
 * tenant, a contractual one is the tenant's own commercial decision.
 */
export type RateRefStatus = "STATUTORY" | "CONTRACTUAL";

export interface CommissionRule {
  id: string;
  name?: string;
  channel: DistributionChannel;
  payeeType: PayeeType;
  segment: PolicySegment;
  premiumType: PremiumType;
  policyYear: number;
  ratePct: number;
  basis: CommissionBasis;
  description: string;
  secpRef: string;
  refStatus: RateRefStatus;
  /** Rate-card rows are versioned; only rows in force on the event date apply. */
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

/**
 * The commission schedule. Rows R1–R7 are the original agent-only statutory
 * matrix; everything else is the rest of the distribution stack.
 *
 * NOTE: the SECP rule/form citations on R1–R7 were inherited and have not been
 * checked line-by-line against the published Insurance Rules 2017 — they need
 * compliance sign-off before this schedule is presented as statutory fact.
 */
export const COMMISSION_RATE_CARD: CommissionRule[] = [
  // ── Tied agency force: the writing producer ───────────────────────────────
  { id: "R1", name: "Individual Life FYP Acquisition", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 35.0, basis: "PREMIUM", description: "Individual Life First Year Acquisition Commission", secpRef: "SECP Rules 2017 Rule 24", refStatus: "STATUTORY", effectiveFrom: "2017-02-09", effectiveTo: null, active: true },
  { id: "R2", name: "Individual Life Y2 Persistency", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 7.5, basis: "PREMIUM", description: "Individual Life Year 2 Renewal Persistency Commission", secpRef: "SECP Rules 2017 Form LG", refStatus: "STATUTORY", effectiveFrom: "2017-02-09", effectiveTo: null, active: true },
  { id: "R3", name: "Individual Life Y3+ Renewal Trail", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "individual", premiumType: "RENEWAL", policyYear: 3, ratePct: 5.0, basis: "PREMIUM", description: "Individual Life Year 3+ Renewal Persistency Commission", secpRef: "SECP Rules 2017 Form LG", refStatus: "STATUTORY", effectiveFrom: "2017-02-09", effectiveTo: null, active: true },
  { id: "R4", name: "Single Premium Acquisition", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "individual", premiumType: "SINGLE_PREMIUM", policyYear: 1, ratePct: 2.5, basis: "PREMIUM", description: "Single Premium Upfront Acquisition Commission", secpRef: "Adamjee Life 2024 Report", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "R5", name: "Group Corporate FYP", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "group", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 15.0, basis: "PREMIUM", description: "Group Corporate Life First Year Commission", secpRef: "SECP Rules 2017 Form LG", refStatus: "STATUTORY", effectiveFrom: "2017-02-09", effectiveTo: null, active: true },
  { id: "R6", name: "Group Corporate Renewal Trail", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "group", premiumType: "RENEWAL", policyYear: 2, ratePct: 3.0, basis: "PREMIUM", description: "Group Corporate Life Renewal Trail Commission", secpRef: "SECP Rules 2017 Form LG", refStatus: "STATUTORY", effectiveFrom: "2017-02-09", effectiveTo: null, active: true },
  { id: "R7", name: "Family Takaful FYP", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "family", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 30.0, basis: "PREMIUM", description: "Family Takaful First Year Acquisition Commission", secpRef: "SECP Takaful Rules 2012", refStatus: "STATUTORY", effectiveFrom: "2012-01-01", effectiveTo: null, active: true },
  { id: "R8", name: "Family Takaful Y2 Renewal", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "family", premiumType: "RENEWAL", policyYear: 2, ratePct: 6.0, basis: "PREMIUM", description: "Family Takaful Year 2 Renewal Commission", secpRef: "Takaful distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "R9", name: "Family Takaful Y3+ Renewal", channel: "DIRECT_AGENCY", payeeType: "AGENT", segment: "family", premiumType: "RENEWAL", policyYear: 3, ratePct: 4.0, basis: "PREMIUM", description: "Family Takaful Year 3+ Renewal Commission", secpRef: "Takaful distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },

  // ── Hierarchy overrides: a cut of what the downline producer earns ─────────
  { id: "SM1", name: "Sales Manager Unit FYP Override", channel: "DIRECT_AGENCY", payeeType: "SALES_MANAGER", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 10.0, basis: "PRODUCER_COMMISSION", description: "Sales Manager First Year Override on Unit Production", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "SM2", name: "Sales Manager Unit Y2 Override", channel: "DIRECT_AGENCY", payeeType: "SALES_MANAGER", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 5.0, basis: "PRODUCER_COMMISSION", description: "Sales Manager Renewal Override (Year 2)", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "SM3", name: "Sales Manager Unit Y3+ Override", channel: "DIRECT_AGENCY", payeeType: "SALES_MANAGER", segment: "individual", premiumType: "RENEWAL", policyYear: 3, ratePct: 4.0, basis: "PRODUCER_COMMISSION", description: "Sales Manager Renewal Override (Year 3+)", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "SM4", name: "Sales Manager Group Life Override", channel: "DIRECT_AGENCY", payeeType: "SALES_MANAGER", segment: "group", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 8.0, basis: "PRODUCER_COMMISSION", description: "Sales Manager Group Life Override", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "SM5", name: "Sales Manager Takaful Override", channel: "DIRECT_AGENCY", payeeType: "SALES_MANAGER", segment: "family", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 10.0, basis: "PRODUCER_COMMISSION", description: "Sales Manager Family Takaful Override", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BM1", name: "Branch Manager FYP Override", channel: "DIRECT_AGENCY", payeeType: "BRANCH_MANAGER", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 5.0, basis: "PRODUCER_COMMISSION", description: "Branch Manager First Year Override on Branch Production", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BM2", name: "Branch Manager Y2 Override", channel: "DIRECT_AGENCY", payeeType: "BRANCH_MANAGER", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 2.5, basis: "PRODUCER_COMMISSION", description: "Branch Manager Renewal Override (Year 2)", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BM3", name: "Branch Manager Group Override", channel: "DIRECT_AGENCY", payeeType: "BRANCH_MANAGER", segment: "group", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 4.0, basis: "PRODUCER_COMMISSION", description: "Branch Manager Group Life Override", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BM4", name: "Branch Manager Takaful Override", channel: "DIRECT_AGENCY", payeeType: "BRANCH_MANAGER", segment: "family", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 5.0, basis: "PRODUCER_COMMISSION", description: "Branch Manager Family Takaful Override", secpRef: "Agency compensation policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },

  // ── Corporate insurance agent ─────────────────────────────────────────────
  { id: "CA1", name: "Corporate Agency FYP", channel: "CORPORATE_AGENT", payeeType: "AGENCY", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 30.0, basis: "PREMIUM", description: "Corporate Agent First Year Commission", secpRef: "Corporate agency agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "CA2", name: "Corporate Agency Y2 Renewal", channel: "CORPORATE_AGENT", payeeType: "AGENCY", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 6.0, basis: "PREMIUM", description: "Corporate Agent Renewal Commission (Year 2)", secpRef: "Corporate agency agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "CA3", name: "Corporate Agency Y3+ Renewal", channel: "CORPORATE_AGENT", payeeType: "AGENCY", segment: "individual", premiumType: "RENEWAL", policyYear: 3, ratePct: 4.0, basis: "PREMIUM", description: "Corporate Agent Renewal Commission (Year 3+)", secpRef: "Corporate agency agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "CA4", name: "Corporate Agency Group Life", channel: "CORPORATE_AGENT", payeeType: "AGENCY", segment: "group", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 12.0, basis: "PREMIUM", description: "Corporate Agent Group Life Commission", secpRef: "Corporate agency agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "CA5", name: "Corporate Specified Person Share", channel: "CORPORATE_AGENT", payeeType: "AGENT", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 20.0, basis: "PARTNER_COMMISSION", description: "Corporate Agent's Specified Person Share of First Year Commission", secpRef: "Corporate agency agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },

  // ── Broker ────────────────────────────────────────────────────────────────
  { id: "BR1", name: "Brokerage FYP Commission", channel: "BROKER", payeeType: "BROKER", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 25.0, basis: "PREMIUM", description: "Brokerage — Individual Life First Year", secpRef: "Broker terms of business", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BR2", name: "Brokerage Renewal Commission", channel: "BROKER", payeeType: "BROKER", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 5.0, basis: "PREMIUM", description: "Brokerage — Individual Life Renewal", secpRef: "Broker terms of business", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BR3", name: "Brokerage Single Premium", channel: "BROKER", payeeType: "BROKER", segment: "individual", premiumType: "SINGLE_PREMIUM", policyYear: 1, ratePct: 2.0, basis: "PREMIUM", description: "Brokerage — Single Premium", secpRef: "Broker terms of business", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BR4", name: "Brokerage Group Life FYP", channel: "BROKER", payeeType: "BROKER", segment: "group", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 12.5, basis: "PREMIUM", description: "Brokerage — Group Life First Year", secpRef: "Broker terms of business", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BR5", name: "Brokerage Group Life Renewal", channel: "BROKER", payeeType: "BROKER", segment: "group", premiumType: "RENEWAL", policyYear: 2, ratePct: 3.0, basis: "PREMIUM", description: "Brokerage — Group Life Renewal", secpRef: "Broker terms of business", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },

  // ── Bancassurance ─────────────────────────────────────────────────────────
  { id: "BA1", name: "Bancassurance FYP Fee", channel: "BANCASSURANCE", payeeType: "BANK_PARTNER", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 32.0, basis: "PREMIUM", description: "Bank Partner First Year Distribution Fee", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BA2", name: "Bancassurance Y2 Renewal Fee", channel: "BANCASSURANCE", payeeType: "BANK_PARTNER", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 6.0, basis: "PREMIUM", description: "Bank Partner Renewal Distribution Fee (Year 2)", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BA3", name: "Bancassurance Y3+ Renewal Fee", channel: "BANCASSURANCE", payeeType: "BANK_PARTNER", segment: "individual", premiumType: "RENEWAL", policyYear: 3, ratePct: 4.0, basis: "PREMIUM", description: "Bank Partner Renewal Distribution Fee (Year 3+)", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BA4", name: "Bancassurance Single Premium Fee", channel: "BANCASSURANCE", payeeType: "BANK_PARTNER", segment: "individual", premiumType: "SINGLE_PREMIUM", policyYear: 1, ratePct: 2.0, basis: "PREMIUM", description: "Bank Partner Single Premium Distribution Fee", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BA5", name: "Bancassurance Takaful Fee", channel: "BANCASSURANCE", payeeType: "BANK_PARTNER", segment: "family", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 28.0, basis: "PREMIUM", description: "Bank Partner Family Takaful First Year Fee", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BO1", name: "Bank Officer FYP Share", channel: "BANCASSURANCE", payeeType: "BANK_SALES_OFFICER", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 15.0, basis: "PARTNER_COMMISSION", description: "Bank Insurance Sales Officer Share of First Year Fee", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BO2", name: "Bank Officer Renewal Share", channel: "BANCASSURANCE", payeeType: "BANK_SALES_OFFICER", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 10.0, basis: "PARTNER_COMMISSION", description: "Bank Insurance Sales Officer Share of Renewal Fee", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "BO3", name: "Bank Officer Takaful Share", channel: "BANCASSURANCE", payeeType: "BANK_SALES_OFFICER", segment: "family", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 15.0, basis: "PARTNER_COMMISSION", description: "Bank Insurance Sales Officer Share of Takaful Fee", secpRef: "Bancassurance distribution agreement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },

  // ── Referral ──────────────────────────────────────────────────────────────
  { id: "RF1", name: "Referral Fee (Individual)", channel: "REFERRAL", payeeType: "REFERRAL_PARTNER", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 5.0, basis: "PREMIUM", description: "Referral Fee — Individual Life Introduction", secpRef: "Referral arrangement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "RF2", name: "Referral Fee (Group)", channel: "REFERRAL", payeeType: "REFERRAL_PARTNER", segment: "group", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 3.0, basis: "PREMIUM", description: "Referral Fee — Group Life Introduction", secpRef: "Referral arrangement", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },

  // ── Digital / direct: no external payee, credited to the house account ────
  { id: "HS1", name: "Direct/Digital Retained FYP", channel: "DIGITAL_DIRECT", payeeType: "HOUSE", segment: "individual", premiumType: "FIRST_YEAR", policyYear: 1, ratePct: 0.0, basis: "PREMIUM", description: "Direct/Digital Business — Retained by Insurer (No Commission)", secpRef: "Internal accounting policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
  { id: "HS2", name: "Direct/Digital Retained Renewal", channel: "DIGITAL_DIRECT", payeeType: "HOUSE", segment: "individual", premiumType: "RENEWAL", policyYear: 2, ratePct: 0.0, basis: "PREMIUM", description: "Direct/Digital Renewal — Retained by Insurer", secpRef: "Internal accounting policy", refStatus: "CONTRACTUAL", effectiveFrom: "2024-01-01", effectiveTo: null, active: true },
];

/** The agent-only statutory rows, kept as a named export for existing callers. */
export const SECP_DEFAULT_RULES: CommissionRule[] = COMMISSION_RATE_CARD.filter(
  (r) => r.channel === "DIRECT_AGENCY" && r.payeeType === "AGENT",
);

/**
 * Resolve the rate-card row in force for one payee on one premium event.
 * Renewal years beyond the last banded year fall back to that band (a Year 7
 * renewal is paid at the Year 3+ trail rate).
 */
export function findRule(args: {
  channel: DistributionChannel;
  payeeType: PayeeType;
  segment: PolicySegment;
  premiumType: PremiumType;
  policyYear: number;
  onDate?: string;
}): CommissionRule | null {
  const { channel, payeeType, segment, premiumType, policyYear } = args;
  const onDate = args.onDate ?? new Date().toISOString().slice(0, 10);

  const candidates = COMMISSION_RATE_CARD.filter(
    (r) =>
      r.active &&
      r.channel === channel &&
      r.payeeType === payeeType &&
      r.segment === segment &&
      r.premiumType === premiumType &&
      r.effectiveFrom <= onDate &&
      (r.effectiveTo === null || r.effectiveTo >= onDate),
  );
  if (candidates.length === 0) return null;

  const exact = candidates.find((r) => r.policyYear === policyYear);
  if (exact) return exact;

  // Highest banded year at or below the policy year, else the earliest band.
  const below = candidates.filter((r) => r.policyYear <= policyYear).sort((a, b) => b.policyYear - a.policyYear);
  return below[0] ?? candidates.sort((a, b) => a.policyYear - b.policyYear)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate card CRUD functions
// ─────────────────────────────────────────────────────────────────────────────

export async function listCommissionRules(): Promise<CommissionRule[]> {
  return [...COMMISSION_RATE_CARD];
}

export async function createCommissionRule(
  input: Omit<CommissionRule, "id"> & { id?: string },
): Promise<CommissionRule> {
  const id = input.id && input.id.trim() ? input.id.trim() : `COM-${Date.now().toString(36).toUpperCase()}`;
  if (COMMISSION_RATE_CARD.some((r) => r.id === id)) {
    throw new Error(`Commission rule with ID '${id}' already exists.`);
  }
  const newRule: CommissionRule = {
    ...input,
    id,
    active: input.active ?? true,
    effectiveFrom: input.effectiveFrom || new Date().toISOString().slice(0, 10),
    effectiveTo: input.effectiveTo || null,
  };
  COMMISSION_RATE_CARD.push(newRule);
  resetLedgerCache();
  return newRule;
}

export async function updateCommissionRule(
  id: string,
  patch: Partial<CommissionRule>,
): Promise<CommissionRule> {
  const index = COMMISSION_RATE_CARD.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new Error(`Commission rule '${id}' not found.`);
  }
  const updated = { ...COMMISSION_RATE_CARD[index], ...patch };
  COMMISSION_RATE_CARD[index] = updated;
  resetLedgerCache();
  return updated;
}

export async function deleteCommissionRule(id: string): Promise<boolean> {
  const index = COMMISSION_RATE_CARD.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new Error(`Commission rule '${id}' not found.`);
  }
  COMMISSION_RATE_CARD.splice(index, 1);
  resetLedgerCache();
  return true;
}

export async function toggleCommissionRuleActive(id: string): Promise<CommissionRule> {
  const rule = COMMISSION_RATE_CARD.find((r) => r.id === id);
  if (!rule) {
    throw new Error(`Commission rule '${id}' not found.`);
  }
  return updateCommissionRule(id, { active: !rule.active });
}


// ─────────────────────────────────────────────────────────────────────────────
// Payee registry
// ─────────────────────────────────────────────────────────────────────────────

export interface CommissionPayee {
  id: string;
  code: string;
  name: string;
  type: PayeeType;
  channel: DistributionChannel;
  /** Who takes the override on this payee's production. */
  parentPayeeId: string | null;
  status: "ACTIVE" | "SUSPENDED" | "TERMINATED";
  branch: string;
  /** Licence details — payout is blocked when a required licence has expired. */
  licenceNo: string | null;
  licenceExpiry: string | null;
  /** Corporate payees are withheld at the standard band and charged provincial
   *  sales tax on services; individuals may qualify for the life-agent band. */
  isCorporate: boolean;
  taxFilerStatus: TaxFilerStatus;
  taxId: string | null;
  bankName: string | null;
  bankAccount: string | null;
  /** Commission credited this tax year — decides the s.233 band. */
  ytdCommission: number;
  /** Unrecovered clawback / advance, netted off future payouts. */
  recoveryBalance: number;
  /** 13th-month persistency, percent — drives persistency bonuses. */
  persistency13m: number | null;
}

/** Insurer's own account for direct/digital business — never actually paid out. */
const HOUSE_PAYEE: CommissionPayee = {
  id: "PAYEE-HOUSE", code: "HOUSE", name: "House Account (Direct & Digital)", type: "HOUSE",
  channel: "DIGITAL_DIRECT", parentPayeeId: null, status: "ACTIVE", branch: "Head Office",
  licenceNo: null, licenceExpiry: null, isCorporate: true, taxFilerStatus: "FILER", taxId: null,
  bankName: null, bankAccount: null, ytdCommission: 0, recoveryBalance: 0, persistency13m: null,
};

/**
 * The non-agent side of the distribution stack. Individual agents are pulled
 * from the tenant's real user directory and grafted underneath these managers;
 * everything that isn't a person in the RBAC directory (banks, brokers,
 * corporate agents, referral partners) lives here.
 */
const STATIC_PAYEES: CommissionPayee[] = [
  {
    id: "PAYEE-SM-01", code: "SM-1104", name: "Faisal Nadeem", type: "SALES_MANAGER",
    channel: "DIRECT_AGENCY", parentPayeeId: "PAYEE-BM-01", status: "ACTIVE", branch: "Karachi Head Office",
    licenceNo: null, licenceExpiry: null, isCorporate: false, taxFilerStatus: "FILER", taxId: "42101-8845120-3",
    bankName: "Meezan Bank", bankAccount: "PK36MEZN0000201045551", ytdCommission: 1_840_000, recoveryBalance: 0, persistency13m: 88,
  },
  {
    id: "PAYEE-SM-02", code: "SM-1108", name: "Sadia Bashir", type: "SALES_MANAGER",
    channel: "DIRECT_AGENCY", parentPayeeId: "PAYEE-BM-01", status: "ACTIVE", branch: "Lahore Regional Office",
    licenceNo: null, licenceExpiry: null, isCorporate: false, taxFilerStatus: "FILER", taxId: "35202-1194780-6",
    bankName: "HBL", bankAccount: "PK24HABB0000271900112", ytdCommission: 1_260_000, recoveryBalance: 45_000, persistency13m: 81,
  },
  {
    id: "PAYEE-BM-01", code: "BM-2201", name: "Imran Sheikh", type: "BRANCH_MANAGER",
    channel: "DIRECT_AGENCY", parentPayeeId: null, status: "ACTIVE", branch: "Karachi Head Office",
    licenceNo: null, licenceExpiry: null, isCorporate: false, taxFilerStatus: "FILER", taxId: "42201-6650913-1",
    bankName: "UBL", bankAccount: "PK80UNIL0109000234871", ytdCommission: 2_970_000, recoveryBalance: 0, persistency13m: 86,
  },
  {
    id: "PAYEE-BANK-01", code: "BNC-HBL", name: "Habib Bank Limited — Bancassurance", type: "BANK_PARTNER",
    channel: "BANCASSURANCE", parentPayeeId: null, status: "ACTIVE", branch: "Karachi Head Office",
    licenceNo: "SECP-CIA-2021-0114", licenceExpiry: "2027-03-31", isCorporate: true, taxFilerStatus: "FILER", taxId: "0710106-2",
    bankName: "HBL", bankAccount: "PK24HABB0000100200300", ytdCommission: 41_500_000, recoveryBalance: 0, persistency13m: 79,
  },
  {
    id: "PAYEE-BSO-01", code: "ISO-4471", name: "Hina Qureshi (HBL Clifton)", type: "BANK_SALES_OFFICER",
    channel: "BANCASSURANCE", parentPayeeId: "PAYEE-BANK-01", status: "ACTIVE", branch: "Karachi Head Office",
    licenceNo: null, licenceExpiry: null, isCorporate: false, taxFilerStatus: "FILER", taxId: "42301-7781204-8",
    bankName: "HBL", bankAccount: "PK24HABB0000271455093", ytdCommission: 480_000, recoveryBalance: 0, persistency13m: 83,
  },
  {
    id: "PAYEE-BROKER-01", code: "BRK-0092", name: "Trident Insurance Brokers (Pvt) Ltd", type: "BROKER",
    channel: "BROKER", parentPayeeId: null, status: "ACTIVE", branch: "Karachi Head Office",
    licenceNo: "SECP-IB-2019-0092", licenceExpiry: "2026-06-30", isCorporate: true, taxFilerStatus: "FILER", taxId: "3811902-5",
    bankName: "Bank Alfalah", bankAccount: "PK11ALFH0021001784500", ytdCommission: 18_200_000, recoveryBalance: 0, persistency13m: null,
  },
  {
    id: "PAYEE-AGENCY-01", code: "CIA-0311", name: "Meridian Corporate Agency", type: "AGENCY",
    channel: "CORPORATE_AGENT", parentPayeeId: null, status: "ACTIVE", branch: "Islamabad Regional Office",
    licenceNo: "SECP-CIA-2020-0311", licenceExpiry: "2026-01-31", isCorporate: true, taxFilerStatus: "NON_FILER", taxId: "4420117-9",
    bankName: "Askari Bank", bankAccount: "PK67ASCM0000110045522", ytdCommission: 9_650_000, recoveryBalance: 120_000, persistency13m: 74,
  },
  {
    id: "PAYEE-REF-01", code: "REF-0507", name: "AutoLease Motors — Referral Desk", type: "REFERRAL_PARTNER",
    channel: "REFERRAL", parentPayeeId: null, status: "ACTIVE", branch: "Karachi Head Office",
    licenceNo: null, licenceExpiry: null, isCorporate: true, taxFilerStatus: "FILER", taxId: "5510338-1",
    bankName: "Faysal Bank", bankAccount: "PK55FAYS0031000988112", ytdCommission: 1_120_000, recoveryBalance: 0, persistency13m: null,
  },
  HOUSE_PAYEE,
];

let payeeCache: CommissionPayee[] | null = null;

/**
 * The payee registry: real tenant agents from the RBAC directory, plus the
 * managers, partners and intermediaries they sit alongside. Agents are
 * alternated between the two sales managers so the override hierarchy has
 * more than one branch in it.
 */
export async function listPayees(): Promise<CommissionPayee[]> {
  if (payeeCache) return payeeCache;

  const tid = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
  const agentUsers = await listAgents(tid).catch(() => []);

  const managers = ["PAYEE-SM-01", "PAYEE-SM-02"];
  const sampleBranches = [
    "Karachi Head Office",
    "Lahore Regional Office",
    "Islamabad Regional Office",
    "Peshawar Regional Office",
    "Quetta Branch",
  ];
  const agentPayees: CommissionPayee[] = agentUsers.map((a, i) => ({
    id: a.id,
    code: `AGT-${7820 + i}`,
    name: a.full_name || a.email,
    type: "AGENT" as PayeeType,
    channel: "DIRECT_AGENCY" as DistributionChannel,
    parentPayeeId: managers[i % managers.length],
    status: "ACTIVE" as const,
    branch: sampleBranches[i % sampleBranches.length],
    // Licences are staggered so the directory shows both valid and expired
    // producers — an expired licence must visibly block its payout.
    licenceNo: `SECP-IA-${2024 + (i % 2)}-${4100 + i}`,
    licenceExpiry: i % 5 === 4 ? "2026-05-31" : "2027-08-31",
    isCorporate: false,
    taxFilerStatus: (i % 4 === 3 ? "NON_FILER" : "FILER") as TaxFilerStatus,
    taxId: null,
    bankName: "HBL",
    bankAccount: `PK24HABB00002719${String(10000 + i).slice(-5)}`,
    ytdCommission: i % 3 === 0 ? 320_000 : 1_450_000,
    recoveryBalance: 0,
    persistency13m: 90 - ((i * 7) % 25),
  }));

  if (agentPayees.length === 0) {
    agentPayees.push({
      id: "AGENT-000", code: "AGT-UNASSIGNED", name: "Unassigned Agent", type: "AGENT",
      channel: "DIRECT_AGENCY", parentPayeeId: "PAYEE-SM-01", status: "ACTIVE", branch: "Head Office",
      // Carries a licence so the placeholder behaves like a real producer: an
      // agent with no licence on file fails the licence gate and can never be
      // paid, which would look like a broken ledger rather than a house account.
      licenceNo: "SECP-IA-2024-0000", licenceExpiry: "2027-12-31",
      isCorporate: false, taxFilerStatus: "FILER", taxId: null,
      bankName: null, bankAccount: null, ytdCommission: 0, recoveryBalance: 0, persistency13m: 85,
    });
  }

  payeeCache = [...agentPayees, ...STATIC_PAYEES];
  return payeeCache;
}

export function resetPayeeCache() {
  payeeCache = null;
}

/** Adds an externally-managed payee (bank, broker, referral partner, manager). */
export async function createPayee(
  input: Omit<CommissionPayee, "id" | "ytdCommission" | "recoveryBalance"> & Partial<Pick<CommissionPayee, "ytdCommission" | "recoveryBalance">>,
): Promise<CommissionPayee> {
  const payees = await listPayees();
  const payee: CommissionPayee = {
    ...input,
    id: `PAYEE-${Date.now().toString(36).toUpperCase()}`,
    ytdCommission: input.ytdCommission ?? 0,
    recoveryBalance: input.recoveryBalance ?? 0,
  };
  payees.push(payee);
  return payee;
}

export async function updatePayee(id: string, patch: Partial<CommissionPayee>): Promise<CommissionPayee> {
  const payees = await listPayees();
  const payee = payees.find((p) => p.id === id);
  if (!payee) throw new Error(`Payee ${id} not found`);
  Object.assign(payee, patch);
  return payee;
}

/** The override chain above a payee, nearest manager first. Cycle-safe. */
export function resolveUplineChain(payeeId: string, payees: CommissionPayee[]): CommissionPayee[] {
  const byId = new Map(payees.map((p) => [p.id, p]));
  const chain: CommissionPayee[] = [];
  const seen = new Set<string>([payeeId]);
  let cursor = byId.get(payeeId)?.parentPayeeId ?? null;
  while (cursor && !seen.has(cursor)) {
    const next = byId.get(cursor);
    if (!next) break;
    chain.push(next);
    seen.add(cursor);
    cursor = next.parentPayeeId;
  }
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tax & deductions
// ─────────────────────────────────────────────────────────────────────────────

export interface StatutoryDeduction {
  code: string;
  label: string;
  pct: number;
  amount: number;
}

/** s.233 withholding rate for this payee, given the band they fall in. */
export function resolveWhtPct(payee: Pick<CommissionPayee, "type" | "isCorporate" | "taxFilerStatus" | "ytdCommission">): number {
  const c = COMMISSION_CONFIG;
  const inLifeAgentLowBand =
    !payee.isCorporate &&
    (payee.type === "AGENT" || payee.type === "SALES_MANAGER" || payee.type === "BRANCH_MANAGER" || payee.type === "BANK_SALES_OFFICER") &&
    payee.ytdCommission < c.lifeAgentLowBandAnnualLimit;

  if (inLifeAgentLowBand) {
    return payee.taxFilerStatus === "FILER" ? c.whtLifeAgentLowBandFiler : c.whtLifeAgentLowBandNonFiler;
  }
  return payee.taxFilerStatus === "FILER" ? c.whtStandardFiler : c.whtStandardNonFiler;
}

function computeDeductions(gross: number, payee: CommissionPayee): StatutoryDeduction[] {
  const deductions: StatutoryDeduction[] = [];

  const whtPct = resolveWhtPct(payee);
  deductions.push({
    code: "WHT_233",
    label: `Income tax withheld — s.233 (${payee.taxFilerStatus === "FILER" ? "filer" : "non-filer"})`,
    pct: whtPct,
    amount: Math.round((gross * whtPct) / 100),
  });

  // Provincial sales tax on services applies to intermediary services billed by
  // a corporate payee; individual producers are outside its scope.
  if (payee.isCorporate && payee.type !== "HOUSE" && COMMISSION_CONFIG.salesTaxOnServicesPct > 0) {
    deductions.push({
      code: "PST_SERVICES",
      label: "Provincial sales tax on services (withheld)",
      pct: COMMISSION_CONFIG.salesTaxOnServicesPct,
      amount: Math.round((gross * COMMISSION_CONFIG.salesTaxOnServicesPct) / 100),
    });
  }

  return deductions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gating
// ─────────────────────────────────────────────────────────────────────────────

export type GatingCheckCode =
  | "POLICY_ISSUED"
  | "PREMIUM_COLLECTED"
  | "FREE_LOOK_ELAPSED"
  | "PAYEE_ACTIVE"
  | "LICENCE_VALID"
  | "WITHIN_PAYOUT_CEILING"
  | "MIN_PAYOUT_THRESHOLD";

export interface GatingCheck {
  code: GatingCheckCode;
  label: string;
  passed: boolean;
  detail: string;
}

/**
 * Stamps are written as UTC in "YYYY-MM-DD HH:MM:SS" form. Without an explicit
 * designator `Date` reads them as local time, which east of Greenwich puts a
 * just-created entry in the future and leaves the free-look gate permanently
 * one day short — so the offset is pinned here rather than assumed.
 */
function daysSince(stamp: string): number {
  const iso = stamp.replace(" ", "T");
  let normalized: string;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    normalized = iso;
  } else if (iso.length === 10) {
    normalized = `${iso}T00:00:00Z`;
  } else {
    normalized = `${iso}Z`;
  }
  const then = new Date(normalized).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

// ─────────────────────────────────────────────────────────────────────────────
// Release schedules — commission falls due in tranches, not in one lump
//
// A first-year commission is earned once but released against a series of
// events: part when the policy is issued, part when the premium is banked, part
// once the free-look window closes, the tail once the policy proves persistent.
// Each entry therefore carries its own schedule of stages, and it is the stage —
// not the entry — that becomes due, gets batched into a payout run, and is paid.
// ─────────────────────────────────────────────────────────────────────────────

export type ReleaseStageCode =
  | "LEAD_GENERATION"
  | "POLICY_ISSUANCE"
  | "PREMIUM_COLLECTION"
  | "FREE_LOOK_EXPIRY"
  | "PERSISTENCY_13M"
  | "RENEWAL_COLLECTION";

export const RELEASE_STAGE_LABELS: Record<ReleaseStageCode, string> = {
  LEAD_GENERATION: "Lead generated",
  POLICY_ISSUANCE: "Policy issued",
  PREMIUM_COLLECTION: "Premium collected",
  FREE_LOOK_EXPIRY: "Free-look window closed",
  PERSISTENCY_13M: "13th-month persistency",
  RENEWAL_COLLECTION: "Renewal premium collected",
};

export const RELEASE_STAGE_SHORT: Record<ReleaseStageCode, string> = {
  LEAD_GENERATION: "LG",
  POLICY_ISSUANCE: "PLI",
  PREMIUM_COLLECTION: "PC",
  FREE_LOOK_EXPIRY: "FLE",
  PERSISTENCY_13M: "P13",
  RENEWAL_COLLECTION: "PRC",
};

export type StageStatus =
  | "PENDING"   // the triggering event has not happened yet
  | "BLOCKED"   // event met, but a payee-level check stops the release
  | "DUE"       // releasable now
  | "IN_RUN"    // locked into a payout run
  | "RELEASED"  // paid
  | "REVERSED"; // cancelled by a clawback before it was ever paid

export interface ReleaseStage {
  code: ReleaseStageCode;
  label: string;
  /** Share of the entry's commission released at this stage. */
  sharePct: number;
  grossAmount: number;
  deductionAmount: number;
  recoveryAmount: number;
  netAmount: number;
  status: StageStatus;
  /** Why the stage is where it is — shown verbatim in the timeline. */
  reason: string;
  /** When the triggering event was recorded. */
  triggeredAt: string | null;
  releasedAt?: string;
  payoutRunId?: string;
}

export interface ReleaseScheduleTemplate {
  id: string;
  channel: DistributionChannel | "ANY";
  payeeType: PayeeType | "ANY";
  segment: PolicySegment | "ANY";
  premiumType: PremiumType;
  description: string;
  stages: { code: ReleaseStageCode; sharePct: number }[];
}

/**
 * Release schedules by channel, payee type and premium type. The most specific
 * template wins; overrides and partner-staff shares do not match here at all —
 * they inherit the schedule of the row they are computed from, because a manager
 * cannot vest faster than the production the override is earned on.
 */
export const RELEASE_SCHEDULES: ReleaseScheduleTemplate[] = [
  {
    id: "SCH-FY-DEFAULT", channel: "ANY", payeeType: "ANY", segment: "ANY", premiumType: "FIRST_YEAR",
    description: "First-year commission vests across issuance, collection, free-look and 13-month persistency",
    stages: [
      { code: "POLICY_ISSUANCE", sharePct: 40 },
      { code: "PREMIUM_COLLECTION", sharePct: 30 },
      { code: "FREE_LOOK_EXPIRY", sharePct: 20 },
      { code: "PERSISTENCY_13M", sharePct: 10 },
    ],
  },
  {
    id: "SCH-FY-GROUP", channel: "ANY", payeeType: "ANY", segment: "group", premiumType: "FIRST_YEAR",
    description: "Group business pays a lead-generation tranche up front and settles on collection",
    stages: [
      { code: "LEAD_GENERATION", sharePct: 20 },
      { code: "POLICY_ISSUANCE", sharePct: 40 },
      { code: "PREMIUM_COLLECTION", sharePct: 40 },
    ],
  },
  {
    id: "SCH-FY-BROKER", channel: "BROKER", payeeType: "BROKER", segment: "ANY", premiumType: "FIRST_YEAR",
    description: "Brokerage settles once against the collected premium",
    stages: [{ code: "PREMIUM_COLLECTION", sharePct: 100 }],
  },
  {
    id: "SCH-FY-BANK", channel: "BANCASSURANCE", payeeType: "BANK_PARTNER", segment: "ANY", premiumType: "FIRST_YEAR",
    description: "Bank distribution fee splits evenly between issuance and collection",
    stages: [
      { code: "POLICY_ISSUANCE", sharePct: 50 },
      { code: "PREMIUM_COLLECTION", sharePct: 50 },
    ],
  },
  {
    id: "SCH-FY-REFERRAL", channel: "REFERRAL", payeeType: "REFERRAL_PARTNER", segment: "ANY", premiumType: "FIRST_YEAR",
    description: "Referral fee falls due once the introduced premium is banked",
    stages: [{ code: "PREMIUM_COLLECTION", sharePct: 100 }],
  },
  {
    id: "SCH-RENEWAL", channel: "ANY", payeeType: "ANY", segment: "ANY", premiumType: "RENEWAL",
    description: "Renewal commission falls due in full on collection of the renewal premium",
    stages: [{ code: "RENEWAL_COLLECTION", sharePct: 100 }],
  },
  {
    id: "SCH-SINGLE", channel: "ANY", payeeType: "ANY", segment: "ANY", premiumType: "SINGLE_PREMIUM",
    description: "Single premium releases on collection, with the tail held to the end of the free-look window",
    stages: [
      { code: "PREMIUM_COLLECTION", sharePct: 70 },
      { code: "FREE_LOOK_EXPIRY", sharePct: 30 },
    ],
  },
];

export function resolveReleaseSchedule(args: {
  channel: DistributionChannel;
  payeeType: PayeeType;
  segment: PolicySegment;
  premiumType: PremiumType;
}): ReleaseScheduleTemplate {
  const matches = RELEASE_SCHEDULES.filter(
    (s) =>
      s.premiumType === args.premiumType &&
      (s.channel === "ANY" || s.channel === args.channel) &&
      (s.payeeType === "ANY" || s.payeeType === args.payeeType) &&
      (s.segment === "ANY" || s.segment === args.segment),
  );
  if (matches.length === 0) {
    return {
      id: "SCH-IMMEDIATE", channel: "ANY", payeeType: "ANY", segment: "ANY", premiumType: args.premiumType,
      description: "No schedule matched — released in full on premium collection",
      stages: [{ code: "PREMIUM_COLLECTION", sharePct: 100 }],
    };
  }
  // Most specific wins: each non-wildcard dimension counts for one point.
  const score = (s: ReleaseScheduleTemplate) =>
    (s.channel === "ANY" ? 0 : 1) + (s.payeeType === "ANY" ? 0 : 1) + (s.segment === "ANY" ? 0 : 1);
  return matches.sort((a, b) => score(b) - score(a))[0];
}

/**
 * What has actually happened on a policy. Stages are driven off this rather than
 * off the entry's own flags, so recording one event on a policy re-evaluates the
 * whole payout stack raised against it at once.
 */
export type PolicyLifecycleEvent =
  | "LEAD_GENERATED"
  | "ISSUED"
  | "PREMIUM_COLLECTED"
  | "PERSISTENCY_13M"
  | "RENEWAL_COLLECTED";

export const POLICY_EVENT_LABELS: Record<PolicyLifecycleEvent, string> = {
  LEAD_GENERATED: "Lead generated",
  ISSUED: "Issue policy",
  PREMIUM_COLLECTED: "Collect premium",
  PERSISTENCY_13M: "Confirm 13-month persistency",
  RENEWAL_COLLECTED: "Collect renewal premium",
};

export interface PolicyEventState {
  policyId: string;
  leadGeneratedAt: string | null;
  issuedAt: string | null;
  premiumCollectedAt: string | null;
  persistency13mAt: string | null;
  renewalCollectedAt: string | null;
}

const policyEvents = new Map<string, PolicyEventState>();

export function getPolicyEvents(policyId: string): PolicyEventState {
  const existing = policyEvents.get(policyId);
  if (existing) return existing;
  const fresh: PolicyEventState = {
    policyId,
    leadGeneratedAt: null,
    issuedAt: null,
    premiumCollectedAt: null,
    persistency13mAt: null,
    renewalCollectedAt: null,
  };
  policyEvents.set(policyId, fresh);
  return fresh;
}

export function resetPolicyEvents() {
  policyEvents.clear();
}

/** Days a policy must be in force before the 13th-month persistency tranche vests. */
const PERSISTENCY_13M_DAYS = 395;

/**
 * Has the event behind this stage happened? Free-look and persistency are
 * derived from the issue date rather than recorded by hand — they are the
 * passage of time, not an operator action.
 */
function isStageTriggered(code: ReleaseStageCode, events: PolicyEventState): { triggered: boolean; at: string | null; detail: string } {
  switch (code) {
    case "LEAD_GENERATION":
      return events.leadGeneratedAt
        ? { triggered: true, at: events.leadGeneratedAt, detail: `Lead generated ${events.leadGeneratedAt}` }
        : { triggered: false, at: null, detail: "Awaiting lead generation" };
    case "POLICY_ISSUANCE":
      return events.issuedAt
        ? { triggered: true, at: events.issuedAt, detail: `Policy issued ${events.issuedAt}` }
        : { triggered: false, at: null, detail: "Awaiting policy issuance" };
    case "PREMIUM_COLLECTION":
      return events.premiumCollectedAt
        ? { triggered: true, at: events.premiumCollectedAt, detail: `Premium collected ${events.premiumCollectedAt}` }
        : { triggered: false, at: null, detail: "Awaiting premium collection" };
    case "FREE_LOOK_EXPIRY": {
      if (!events.issuedAt) return { triggered: false, at: null, detail: "Free-look window starts at issuance" };
      const elapsed = daysSince(events.issuedAt);
      const remaining = COMMISSION_CONFIG.freeLookDays - elapsed;
      return remaining <= 0
        ? { triggered: true, at: events.issuedAt, detail: `Cooling-off closed after ${COMMISSION_CONFIG.freeLookDays} days` }
        : { triggered: false, at: null, detail: `${remaining} day(s) of cooling-off remaining` };
    }
    case "PERSISTENCY_13M": {
      if (events.persistency13mAt) {
        return { triggered: true, at: events.persistency13mAt, detail: `Persistency confirmed ${events.persistency13mAt}` };
      }
      if (!events.issuedAt) return { triggered: false, at: null, detail: "Measured 13 months after issuance" };
      const elapsed = daysSince(events.issuedAt);
      return elapsed >= PERSISTENCY_13M_DAYS
        ? { triggered: true, at: events.issuedAt, detail: "Policy in force past month 13" }
        : { triggered: false, at: null, detail: `${PERSISTENCY_13M_DAYS - elapsed} day(s) to the 13-month measurement` };
    }
    case "RENEWAL_COLLECTION": {
      const at = events.renewalCollectedAt ?? events.premiumCollectedAt;
      return at
        ? { triggered: true, at, detail: `Renewal premium collected ${at}` }
        : { triggered: false, at: null, detail: "Awaiting renewal premium collection" };
    }
    default:
      return { triggered: false, at: null, detail: "Unknown stage" };
  }
}

/**
 * Split an entry's money across its stages. Rounding remainders land on the last
 * stage so the tranches always add back to the entry exactly — a ledger that
 * loses a rupee to rounding is a ledger that fails reconciliation.
 */
function buildStages(
  entry: CommissionLedgerEntry,
  template: { code: ReleaseStageCode; sharePct: number }[],
): ReleaseStage[] {
  const deductionTotal = entry.deductions.reduce((s, d) => s + d.amount, 0);
  const stages: ReleaseStage[] = [];
  let grossLeft = entry.grossCommission;
  let deductionLeft = deductionTotal;
  let recoveryLeft = entry.recoveryApplied;

  template.forEach((slice, idx) => {
    const isLast = idx === template.length - 1;
    const gross = isLast ? grossLeft : Math.round((entry.grossCommission * slice.sharePct) / 100);
    const deduction = isLast ? deductionLeft : Math.round((deductionTotal * slice.sharePct) / 100);
    // Recovery is taken from the earliest tranches rather than spread evenly:
    // money owed back is collected as soon as there is something to collect from.
    const recovery = Math.min(recoveryLeft, Math.max(0, gross - deduction));

    grossLeft -= gross;
    deductionLeft -= deduction;
    recoveryLeft -= recovery;

    stages.push({
      code: slice.code,
      label: RELEASE_STAGE_LABELS[slice.code],
      sharePct: slice.sharePct,
      grossAmount: gross,
      deductionAmount: deduction,
      recoveryAmount: recovery,
      netAmount: gross - deduction - recovery,
      status: "PENDING",
      reason: "Awaiting the triggering event",
      triggeredAt: null,
    });
  });

  return stages;
}

/**
 * Re-evaluate an entry's stages against the current policy events and roll the
 * result up into the entry. Stages that have already been batched, paid or
 * reversed are left alone; only PENDING/BLOCKED/DUE move.
 */
export function evaluateEntryStages(entry: CommissionLedgerEntry, events: PolicyEventState): CommissionLedgerEntry {
  if (entry.entryKind === "CLAWBACK") return entry;

  const blockers = entry.gatingChecks.filter(
    (c) => !c.passed && (c.code === "PAYEE_ACTIVE" || c.code === "LICENCE_VALID" || c.code === "WITHIN_PAYOUT_CEILING"),
  );

  for (const stage of entry.stages) {
    if (stage.status === "IN_RUN" || stage.status === "RELEASED" || stage.status === "REVERSED") continue;

    const trigger = isStageTriggered(stage.code, events);
    stage.triggeredAt = trigger.at;

    if (!trigger.triggered) {
      stage.status = "PENDING";
      stage.reason = trigger.detail;
    } else if (blockers.length > 0) {
      stage.status = "BLOCKED";
      stage.reason = `${trigger.detail}, but ${blockers.map((b) => b.detail).join("; ")}`;
    } else if (entry.payeeType === "HOUSE") {
      stage.status = "BLOCKED";
      stage.reason = "Retained by the insurer — direct business is not paid out";
    } else {
      stage.status = "DUE";
      stage.reason = trigger.detail;
    }
  }

  const sum = (predicate: (s: ReleaseStage) => boolean) =>
    entry.stages.filter(predicate).reduce((total, s) => total + s.netAmount, 0);

  entry.dueNet = sum((s) => s.status === "DUE");
  entry.inRunNet = sum((s) => s.status === "IN_RUN");
  entry.pendingNet = sum((s) => s.status === "PENDING" || s.status === "BLOCKED");
  entry.releasedNet = sum((s) => s.status === "RELEASED");

  if (entry.status !== "CLAWED_BACK" && entry.status !== "HELD") {
    const released = entry.stages.filter((s) => s.status === "RELEASED").length;
    if (released === entry.stages.length && released > 0) {
      entry.status = "DISBURSED";
      entry.gatingReason = "Fully released across every stage";
    } else if (released > 0) {
      entry.status = "PARTIALLY_RELEASED";
      entry.gatingReason = `${released} of ${entry.stages.length} stages released — ${fmtStageSummary(entry)}`;
    } else if (entry.stages.some((s) => s.status === "IN_RUN")) {
      entry.status = "IN_RUN";
    } else if (entry.dueNet > 0) {
      entry.status = "PAYABLE";
      entry.gatingReason = `Due now: ${fmtStageSummary(entry)}`;
    } else if (blockers.length > 0 || entry.payeeType === "HOUSE") {
      entry.status = "HELD";
      entry.gatingReason =
        entry.payeeType === "HOUSE"
          ? "Retained by the insurer — direct business is not paid out"
          : `Held: ${blockers.map((b) => b.detail).join("; ")}`;
    } else {
      entry.status = "ACCRUED";
      entry.gatingReason = `Not yet due: ${entry.stages.find((s) => s.status === "PENDING")?.reason ?? "awaiting events"}`;
    }
  }

  return entry;
}

function fmtStageSummary(entry: CommissionLedgerEntry): string {
  const due = entry.stages.filter((s) => s.status === "DUE").map((s) => `${RELEASE_STAGE_SHORT[s.code]} ${s.sharePct}%`);
  const pending = entry.stages.filter((s) => s.status === "PENDING").map((s) => RELEASE_STAGE_SHORT[s.code]);
  const parts: string[] = [];
  if (due.length > 0) parts.push(`due ${due.join(", ")}`);
  if (pending.length > 0) parts.push(`awaiting ${pending.join(", ")}`);
  return parts.join("; ") || "nothing outstanding";
}

/**
 * Record a lifecycle event against a policy and re-evaluate every commission
 * entry raised on it. This is the hook a real premium-collection or issuance
 * service would call; the portal exposes it so a stage can be walked forward.
 */
export async function recordPolicyEvent(
  policyId: string,
  event: PolicyLifecycleEvent,
  at?: string,
): Promise<{ events: PolicyEventState; affected: number }> {
  const events = getPolicyEvents(policyId);
  const stamp = at ?? nowStamp();

  switch (event) {
    case "LEAD_GENERATED": events.leadGeneratedAt = stamp; break;
    case "ISSUED": events.issuedAt = stamp; break;
    case "PREMIUM_COLLECTED": events.premiumCollectedAt = stamp; break;
    case "PERSISTENCY_13M": events.persistency13mAt = stamp; break;
    case "RENEWAL_COLLECTED": events.renewalCollectedAt = stamp; break;
  }

  const ledger = await listCommissionLedger();
  const affected = ledger.filter((e) => e.policyId === policyId);
  for (const entry of affected) evaluateEntryStages(entry, events);
  return { events, affected: affected.length };
}

/** Re-run stage evaluation across the whole ledger (after a config change). */
export async function reevaluateLedgerStages(): Promise<void> {
  const ledger = await listCommissionLedger();
  for (const entry of ledger) evaluateEntryStages(entry, getPolicyEvents(entry.policyId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

export interface CommissionLedgerEntry {
  id: string;
  entryKind: CommissionEntryKind;
  leadId: string;

  payeeId: string;
  payeeCode: string;
  payeeName: string;
  payeeType: PayeeType;
  channel: DistributionChannel;

  policyId: string;
  policyNumber: string;
  customerName: string;
  segment: PolicySegment;
  productName: string;

  premiumType: PremiumType;
  policyYear: number;
  collectedPremium: number;

  /** What the rate was applied to, and how much of it. */
  basis: CommissionBasis;
  basisAmount: number;
  /** Producer's share of a split case, percent. 100 when not split. */
  splitPct: number;
  ratePct: number;
  grossCommission: number;

  deductions: StatutoryDeduction[];
  /** Income tax withheld — broken out because every statement reports it. */
  whtTax: number;
  whtPct: number;
  /** Clawback/advance netted off this payment. */
  recoveryApplied: number;
  netCommission: number;

  /**
   * The tranches this commission is released in, and where each one has got to.
   * Aggregates below are derived from them — never set independently.
   */
  releaseScheduleId: string;
  stages: ReleaseStage[];
  /** Net releasable right now. */
  dueNet: number;
  /** Net locked into an unpaid payout run. */
  inRunNet: number;
  /** Net not yet vested — waiting on a later event. */
  pendingNet: number;
  /** Net already paid out. */
  releasedNet: number;

  status: CommissionStatus;
  gatingReason: string;
  gatingChecks: GatingCheck[];

  ruleId: string | null;
  secpRef: string;
  /** Set on overrides and partner-share rows: the entry they are computed from. */
  parentEntryId: string | null;
  bonusSchemeCode?: string;
  payoutRunId?: string;

  clawbackAmount?: number;
  isClawback?: boolean;
  clawbackReason?: string;
  reversalOfEntryId?: string;

  accruedAt: string;
  disbursedAt?: string;
}

export interface CommissionSummaryStats {
  totalGrossCommission: number;
  totalAccruedLiability: number;
  /** Vested and releasable right now. */
  totalDueNow: number;
  /** Vested and locked into an unpaid payout run. */
  totalInRun: number;
  /** Earned but not yet vested — waiting on a later release event. */
  totalNotYetDue: number;
  totalDisbursed: number;
  totalClawbacks: number;
  totalWithheldTax: number;
  firstYearCommissionTotal: number;
  renewalCommissionTotal: number;
  singlePremiumCommissionTotal: number;
  firstYearPremiumTotal: number;
  renewalPremiumTotal: number;
  singlePremiumTotal: number;
  overrideTotal: number;
  bonusTotal: number;
  activePayeesCount: number;
  gatedCount: number;
  byChannel: { channel: DistributionChannel; gross: number; net: number; entries: number }[];
  byPayeeType: { payeeType: PayeeType; gross: number; net: number; entries: number }[];
  /** The release pipeline: what is due now and what each later stage still owes. */
  byStage: { code: ReleaseStageCode; dueNet: number; pendingNet: number; releasedNet: number; stages: number }[];
}

let ledgerCache: CommissionLedgerEntry[] | null = null;
let entrySeq = 0;

export function resetLedgerCache() {
  ledgerCache = null;
  entrySeq = 0;
}

// Backend segment values (routers/cases.py, policies.py) are individual |
// family | organization; the SECP rate card's rule conditions speak in
// Individual | Group | Family. "organization" is this platform's group/
// employer-sponsored segment, so it maps to "Group" here — this is the one
// translation point that has to agree with rules.py's COM-GRP-* conditions.
export function segmentToCategory(segment: string | undefined): "Individual" | "Group" | "Family" {
  if (segment === "organization" || segment === "group") return "Group";
  if (segment === "family") return "Family";
  return "Individual";
}

export function segmentToRuleSegment(category: "Individual" | "Group" | "Family"): PolicySegment {
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

function nowStamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ─────────────────────────────────────────────────────────────────────────────
// The waterfall
// ─────────────────────────────────────────────────────────────────────────────

export interface ProducerSplit {
  payeeId: string;
  /** Share of the producer commission, percent. Splits should total 100. */
  splitPct: number;
}

export interface WaterfallInput {
  leadId: string;
  policyId: string;
  policyNumber: string;
  customerName: string;
  productName: string;
  segment: PolicySegment;
  premiumType: PremiumType;
  policyYear: number;
  collectedPremium: number;
  channel: DistributionChannel;
  /** Writing producer(s). More than one row = a split case. */
  producers: ProducerSplit[];
  /** Channel partner (bank / broker / corporate agent) owning the relationship. */
  partnerPayeeId?: string | null;
  /** The partner's own front-line staff who sold it (bank ISO, specified person). */
  partnerStaffPayeeId?: string | null;
  referralPayeeId?: string | null;
  isIssued: boolean;
  isPremiumCollected: boolean;
  /** Issue/collection date — drives the free-look gate and rate-card version. */
  eventDate?: string;
  /** Overrides stop here; used by the calculator to preview a shallower stack. */
  includeOverrides?: boolean;
}

export interface WaterfallResult {
  entries: CommissionLedgerEntry[];
  totalGross: number;
  totalNet: number;
  /** Total commission as a % of premium, and the ceiling it was checked against. */
  effectiveRatePct: number;
  ceilingPct: number;
  ceilingBreached: boolean;
  warnings: string[];
}

/**
 * Fan one premium event out to every party entitled to a share.
 *
 * Order matters: producers first (their gross is the basis for manager
 * overrides), then the channel partner (whose gross is the basis for its own
 * staff's share), then referral fees. Deductions and gating are applied
 * per entry, because tax band and licence validity are properties of the
 * individual payee, not of the policy.
 */
export function computeCommissionWaterfall(input: WaterfallInput, payees: CommissionPayee[]): WaterfallResult {
  const byId = new Map(payees.map((p) => [p.id, p]));
  const eventDate = (input.eventDate ?? new Date().toISOString()).slice(0, 10);
  const entries: CommissionLedgerEntry[] = [];
  const warnings: string[] = [];

  const splitTotal = input.producers.reduce((s, p) => s + p.splitPct, 0);
  if (input.producers.length > 0 && Math.abs(splitTotal - 100) > 0.01) {
    warnings.push(`Producer splits total ${splitTotal}% — they must sum to 100%.`);
  }

  const makeEntry = (args: {
    payee: CommissionPayee;
    entryKind: CommissionEntryKind;
    rule: CommissionRule | null;
    basis: CommissionBasis;
    basisAmount: number;
    splitPct: number;
    ratePct: number;
    parentEntryId?: string | null;
    bonusSchemeCode?: string;
  }): CommissionLedgerEntry => {
    const gross = Math.round((args.basisAmount * args.ratePct) / 100);
    const deductions = computeDeductions(gross, args.payee);
    const wht = deductions.find((d) => d.code === "WHT_233");
    const deductionTotal = deductions.reduce((s, d) => s + d.amount, 0);
    const afterDeductions = gross - deductionTotal;
    const recoveryApplied = Math.max(0, Math.min(args.payee.recoveryBalance, afterDeductions));

    entrySeq += 1;
    const id = `COM-${new Date().getFullYear()}-${String(entrySeq).padStart(5, "0")}`;

    const entry: CommissionLedgerEntry = {
      id,
      entryKind: args.entryKind,
      leadId: input.leadId,
      payeeId: args.payee.id,
      payeeCode: args.payee.code,
      payeeName: args.payee.name,
      payeeType: args.payee.type,
      channel: input.channel,
      policyId: input.policyId,
      policyNumber: input.policyNumber,
      customerName: input.customerName,
      segment: input.segment,
      productName: input.productName,
      premiumType: input.premiumType,
      policyYear: input.policyYear,
      collectedPremium: input.collectedPremium,
      basis: args.basis,
      basisAmount: args.basisAmount,
      splitPct: args.splitPct,
      ratePct: args.ratePct,
      grossCommission: gross,
      deductions,
      whtTax: wht?.amount ?? 0,
      whtPct: wht?.pct ?? 0,
      recoveryApplied,
      netCommission: afterDeductions - recoveryApplied,
      releaseScheduleId: "",
      stages: [],
      dueNet: 0,
      inRunNet: 0,
      pendingNet: 0,
      releasedNet: 0,
      status: "ACCRUED",
      gatingReason: "",
      gatingChecks: [],
      ruleId: args.rule?.id ?? null,
      secpRef: args.rule?.secpRef ?? "No rate-card row matched",
      parentEntryId: args.parentEntryId ?? null,
      bonusSchemeCode: args.bonusSchemeCode,
      accruedAt: input.eventDate ? input.eventDate.replace("T", " ").slice(0, 19) : nowStamp(),
    };
    entries.push(entry);
    return entry;
  };

  // ── 1. Writing producers (split-aware) ──────────────────────────────────
  const producerEntries: CommissionLedgerEntry[] = [];
  for (const split of input.producers) {
    const payee = byId.get(split.payeeId);
    if (!payee) {
      warnings.push(`Producer ${split.payeeId} is not in the payee registry — skipped.`);
      continue;
    }
    const rule = findRule({
      channel: input.channel, payeeType: payee.type, segment: input.segment,
      premiumType: input.premiumType, policyYear: input.policyYear, onDate: eventDate,
    });
    if (!rule) {
      warnings.push(`No rate-card row for ${PAYEE_TYPE_LABELS[payee.type]} on ${CHANNEL_LABELS[input.channel]} / ${input.segment} / ${input.premiumType}.`);
      continue;
    }
    producerEntries.push(
      makeEntry({
        payee,
        entryKind: "COMMISSION",
        rule,
        basis: "PREMIUM",
        basisAmount: Math.round((input.collectedPremium * split.splitPct) / 100),
        splitPct: split.splitPct,
        ratePct: rule.ratePct,
      }),
    );
  }

  // ── 2. Hierarchy overrides on each producer's earning ────────────────────
  if (input.includeOverrides !== false) {
    for (const producerEntry of producerEntries) {
      for (const manager of resolveUplineChain(producerEntry.payeeId, payees)) {
        const rule = findRule({
          channel: input.channel, payeeType: manager.type, segment: input.segment,
          premiumType: input.premiumType, policyYear: input.policyYear, onDate: eventDate,
        });
        if (!rule || rule.basis !== "PRODUCER_COMMISSION") continue;
        makeEntry({
          payee: manager,
          entryKind: "OVERRIDE",
          rule,
          basis: "PRODUCER_COMMISSION",
          basisAmount: producerEntry.grossCommission,
          splitPct: producerEntry.splitPct,
          ratePct: rule.ratePct,
          parentEntryId: producerEntry.id,
        });
      }
    }
  }

  // ── 3. Channel partner, then that partner's own front-line staff ─────────
  let partnerEntry: CommissionLedgerEntry | null = null;
  if (input.partnerPayeeId) {
    const partner = byId.get(input.partnerPayeeId);
    const rule = partner
      ? findRule({
        channel: input.channel, payeeType: partner.type, segment: input.segment,
        premiumType: input.premiumType, policyYear: input.policyYear, onDate: eventDate,
      })
      : null;
    if (!partner) {
      warnings.push(`Channel partner ${input.partnerPayeeId} is not in the payee registry — skipped.`);
    } else if (!rule) {
      warnings.push(`No rate-card row for ${PAYEE_TYPE_LABELS[partner.type]} on ${CHANNEL_LABELS[input.channel]} / ${input.segment} / ${input.premiumType}.`);
    } else {
      partnerEntry = makeEntry({
        payee: partner,
        entryKind: partner.type === "HOUSE" ? "COMMISSION" : "PARTNER_FEE",
        rule,
        basis: "PREMIUM",
        basisAmount: input.collectedPremium,
        splitPct: 100,
        ratePct: rule.ratePct,
      });
    }
  }

  if (input.partnerStaffPayeeId && partnerEntry) {
    const staff = byId.get(input.partnerStaffPayeeId);
    const rule = staff
      ? findRule({
        channel: input.channel, payeeType: staff.type, segment: input.segment,
        premiumType: input.premiumType, policyYear: input.policyYear, onDate: eventDate,
      })
      : null;
    if (staff && rule && rule.basis === "PARTNER_COMMISSION") {
      makeEntry({
        payee: staff,
        entryKind: "COMMISSION",
        rule,
        basis: "PARTNER_COMMISSION",
        basisAmount: partnerEntry.grossCommission,
        splitPct: 100,
        ratePct: rule.ratePct,
        parentEntryId: partnerEntry.id,
      });
    }
  }

  // ── 4. Referral fee ─────────────────────────────────────────────────────
  if (input.referralPayeeId) {
    const referrer = byId.get(input.referralPayeeId);
    const rule = referrer
      ? findRule({
        channel: "REFERRAL", payeeType: referrer.type, segment: input.segment,
        premiumType: input.premiumType, policyYear: input.policyYear, onDate: eventDate,
      })
      : null;
    if (referrer && rule) {
      makeEntry({
        payee: referrer,
        entryKind: "REFERRAL_FEE",
        rule,
        basis: "PREMIUM",
        basisAmount: input.collectedPremium,
        splitPct: 100,
        ratePct: rule.ratePct,
      });
    }
  }

  // ── 5. Aggregate ceiling check across the whole stack ────────────────────
  const totalGross = entries.reduce((s, e) => s + e.grossCommission, 0);
  const ceilingPct = COMMISSION_CONFIG.payoutCeilingPct[input.segment][input.premiumType];
  const effectiveRatePct = input.collectedPremium > 0 ? (totalGross / input.collectedPremium) * 100 : 0;
  const ceilingBreached = effectiveRatePct > ceilingPct + 0.001;
  if (ceilingBreached) {
    warnings.push(
      `Total commission is ${effectiveRatePct.toFixed(2)}% of premium against a ${ceilingPct}% ceiling for ${input.segment}/${input.premiumType}. Payout is blocked pending review.`,
    );
  }

  // ── 6. Release schedule and gating, per entry ───────────────────────────
  //
  // The event checks below are informational: issuance, collection and the
  // free-look window no longer decide whether the whole entry is releasable,
  // they decide which tranche of it has vested. Only the payee-level checks
  // (suspension, licence, ceiling) can block a stage that has otherwise fallen
  // due, so they are the ones `evaluateEntryStages` treats as blockers.
  const eventStamp = input.eventDate ? input.eventDate.replace("T", " ").slice(0, 19) : nowStamp();
  const events = getPolicyEvents(input.policyId);
  if (input.isIssued && !events.issuedAt) events.issuedAt = eventStamp;
  if (input.isPremiumCollected && !events.premiumCollectedAt) events.premiumCollectedAt = eventStamp;
  if (!events.leadGeneratedAt) events.leadGeneratedAt = eventStamp;

  for (const entry of entries) {
    const payee = byId.get(entry.payeeId)!;
    const checks: GatingCheck[] = [
      {
        code: "POLICY_ISSUED", label: "Policy issued", passed: !!events.issuedAt,
        detail: events.issuedAt ? `Policy issued ${events.issuedAt}` : "Awaiting policy issuance",
      },
      {
        code: "PREMIUM_COLLECTED", label: "Premium collected", passed: !!events.premiumCollectedAt,
        detail: events.premiumCollectedAt ? "Premium collected and realised" : "Premium not yet collected",
      },
      {
        code: "FREE_LOOK_ELAPSED",
        label: `Free-look elapsed (${COMMISSION_CONFIG.freeLookDays}d)`,
        passed: isStageTriggered("FREE_LOOK_EXPIRY", events).triggered,
        detail: isStageTriggered("FREE_LOOK_EXPIRY", events).detail,
      },
      {
        code: "PAYEE_ACTIVE", label: "Payee active", passed: payee.status === "ACTIVE",
        detail: payee.status === "ACTIVE" ? "Payee is active" : `Payee is ${payee.status.toLowerCase()}`,
      },
      {
        code: "LICENCE_VALID",
        label: "Licence valid",
        passed: !LICENCE_REQUIRED.includes(payee.type) || (!!payee.licenceExpiry && payee.licenceExpiry >= eventDate),
        detail: !LICENCE_REQUIRED.includes(payee.type)
          ? "No licence required for this payee type"
          : !payee.licenceExpiry
            ? "No licence on file"
            : payee.licenceExpiry >= eventDate
              ? `Licence ${payee.licenceNo} valid to ${payee.licenceExpiry}`
              : `Licence ${payee.licenceNo} expired ${payee.licenceExpiry}`,
      },
      {
        code: "WITHIN_PAYOUT_CEILING", label: "Within payout ceiling", passed: !ceilingBreached,
        detail: ceilingBreached
          ? `Stack at ${effectiveRatePct.toFixed(2)}% exceeds the ${ceilingPct}% ceiling`
          : `Stack at ${effectiveRatePct.toFixed(2)}% of a ${ceilingPct}% ceiling`,
      },
      {
        code: "MIN_PAYOUT_THRESHOLD",
        label: "Above minimum payout",
        passed: entry.netCommission >= COMMISSION_CONFIG.minPayoutThreshold,
        detail:
          entry.netCommission >= COMMISSION_CONFIG.minPayoutThreshold
            ? "Net exceeds the minimum payout threshold"
            : `Net below the ${COMMISSION_CONFIG.minPayoutThreshold} threshold — carried forward`,
      },
    ];

    entry.gatingChecks = checks;

    // Overrides and partner-staff shares vest with the row they are computed
    // from: a manager's cut of a tranche cannot fall due before the tranche does.
    const parent = entry.parentEntryId ? entries.find((e) => e.id === entry.parentEntryId) : null;
    if (parent && parent.stages.length > 0) {
      entry.releaseScheduleId = parent.releaseScheduleId;
      entry.stages = buildStages(entry, parent.stages.map((s) => ({ code: s.code, sharePct: s.sharePct })));
    } else {
      const schedule = resolveReleaseSchedule({
        channel: entry.channel, payeeType: entry.payeeType, segment: entry.segment, premiumType: entry.premiumType,
      });
      entry.releaseScheduleId = schedule.id;
      entry.stages = buildStages(entry, schedule.stages);
    }

    evaluateEntryStages(entry, events);
  }

  return {
    entries,
    totalGross,
    totalNet: entries.reduce((s, e) => s + e.netCommission, 0),
    effectiveRatePct,
    ceilingPct,
    ceilingBreached,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Incentive schemes
// ─────────────────────────────────────────────────────────────────────────────

export interface IncentiveScheme {
  id: string;
  code: string;
  name: string;
  kind: "PERSISTENCY_BONUS" | "PRODUCTION_BONUS" | "CLUB_QUALIFICATION";
  payeeTypes: PayeeType[];
  description: string;
  /** Qualifying metric and the threshold that must be met. */
  metric: string;
  thresholdLabel: string;
  threshold: number;
  /** Reward as a % of qualifying first-year commission, or a flat amount. */
  rewardPct: number | null;
  rewardAmount: number | null;
  measuredAt: string;
  active: boolean;
}

export const INCENTIVE_SCHEMES: IncentiveScheme[] = [
  {
    id: "INC-1", code: "BONUS-RET-13M", name: "1-Year Policy Retention Bonus", kind: "PERSISTENCY_BONUS",
    payeeTypes: ["AGENT", "SALES_MANAGER", "BANK_SALES_OFFICER"],
    description: "Extra bonus earned when 85%+ of your sold policies stay active for 1 full year.",
    metric: "1-Year Policy Retention", thresholdLabel: "≥ 85% Active", threshold: 85,
    rewardPct: 5, rewardAmount: null, measuredAt: "After 13 Months", active: true,
  },
  {
    id: "INC-2", code: "BONUS-RET-25M", name: "2-Year Policy Retention Bonus", kind: "PERSISTENCY_BONUS",
    payeeTypes: ["AGENT", "SALES_MANAGER"],
    description: "Bonus reward when 75%+ of sold policies stay active into their second year.",
    metric: "2-Year Policy Retention", thresholdLabel: "≥ 75% Active", threshold: 75,
    rewardPct: 3, rewardAmount: null, measuredAt: "After 25 Months", active: true,
  },
  {
    id: "INC-3", code: "BONUS-QTR-SALES", name: "Quarterly Sales Goal Bonus", kind: "PRODUCTION_BONUS",
    payeeTypes: ["AGENT", "AGENCY", "BANK_SALES_OFFICER"],
    description: "Cash bonus earned when total new sales written in a 3-month period reach PKR 5 Million.",
    metric: "Quarterly Sales Target", thresholdLabel: "≥ PKR 5,000,000", threshold: 5_000_000,
    rewardPct: 2, rewardAmount: null, measuredAt: "End of Quarter", active: true,
  },
  {
    id: "INC-4", code: "BONUS-ANN-TOP", name: "Annual Top Sales Performer Award", kind: "CLUB_QUALIFICATION",
    payeeTypes: ["AGENT", "SALES_MANAGER", "BANK_SALES_OFFICER"],
    description: "Flat PKR 250,000 cash prize for agents writing PKR 20 Million or more in annual sales.",
    metric: "Annual Sales Target", thresholdLabel: "≥ PKR 20,000,000", threshold: 20_000_000,
    rewardPct: null, rewardAmount: 250_000, measuredAt: "End of Year", active: true,
  },
];

export async function listIncentiveSchemes(): Promise<IncentiveScheme[]> {
  return [...INCENTIVE_SCHEMES];
}

export async function createIncentiveScheme(
  input: Omit<IncentiveScheme, "id"> & { id?: string },
): Promise<IncentiveScheme> {
  const id = input.id && input.id.trim() ? input.id.trim() : `INC-${Date.now().toString(36).toUpperCase()}`;
  if (INCENTIVE_SCHEMES.some((s) => s.id === id)) {
    throw new Error(`Incentive scheme with ID '${id}' already exists.`);
  }
  const newScheme: IncentiveScheme = {
    ...input,
    id,
    active: input.active ?? true,
  };
  INCENTIVE_SCHEMES.push(newScheme);
  return newScheme;
}

export async function updateIncentiveScheme(
  id: string,
  patch: Partial<IncentiveScheme>,
): Promise<IncentiveScheme> {
  const index = INCENTIVE_SCHEMES.findIndex((s) => s.id === id);
  if (index === -1) {
    throw new Error(`Incentive scheme '${id}' not found.`);
  }
  const updated = { ...INCENTIVE_SCHEMES[index], ...patch };
  INCENTIVE_SCHEMES[index] = updated;
  return updated;
}

export async function deleteIncentiveScheme(id: string): Promise<boolean> {
  const index = INCENTIVE_SCHEMES.findIndex((s) => s.id === id);
  if (index === -1) {
    throw new Error(`Incentive scheme '${id}' not found.`);
  }
  INCENTIVE_SCHEMES.splice(index, 1);
  return true;
}

export async function toggleIncentiveSchemeActive(id: string): Promise<IncentiveScheme> {
  const scheme = INCENTIVE_SCHEMES.find((s) => s.id === id);
  if (!scheme) {
    throw new Error(`Incentive scheme '${id}' not found.`);
  }
  return updateIncentiveScheme(id, { active: !scheme.active });
}


export interface IncentiveQualification {
  payee: CommissionPayee;
  scheme: IncentiveScheme;
  metricValue: number;
  qualifies: boolean;
  awardAmount: number;
}

/**
 * Evaluate every active scheme against the ledger. Persistency schemes read the
 * payee's persistency figure; production schemes read first-year premium the
 * payee actually produced this period.
 */
export function evaluateIncentives(payees: CommissionPayee[], ledger: CommissionLedgerEntry[]): IncentiveQualification[] {
  const results: IncentiveQualification[] = [];

  for (const payee of payees) {
    if (payee.status !== "ACTIVE" || payee.type === "HOUSE") continue;

    const own = ledger.filter((e) => e.payeeId === payee.id && !e.isClawback);
    const fyPremium = own
      .filter((e) => e.premiumType === "FIRST_YEAR" && e.entryKind === "COMMISSION")
      .reduce((s, e) => s + e.basisAmount, 0);
    const fyCommission = own
      .filter((e) => e.premiumType === "FIRST_YEAR")
      .reduce((s, e) => s + e.grossCommission, 0);

    for (const scheme of INCENTIVE_SCHEMES) {
      if (!scheme.active || !scheme.payeeTypes.includes(payee.type)) continue;

      const metricValue = scheme.kind === "PERSISTENCY_BONUS" ? payee.persistency13m ?? 0 : fyPremium;
      const qualifies = metricValue >= scheme.threshold;
      const awardAmount = !qualifies
        ? 0
        : scheme.rewardAmount ?? Math.round((fyCommission * (scheme.rewardPct ?? 0)) / 100);

      results.push({ payee, scheme, metricValue, qualifies, awardAmount });
    }
  }

  return results;
}

/** Post a qualified incentive to the ledger as a BONUS entry. */
export async function awardIncentive(qualification: IncentiveQualification): Promise<CommissionLedgerEntry> {
  const { payee, scheme, awardAmount } = qualification;
  if (!qualification.qualifies || awardAmount <= 0) {
    throw new Error(`${payee.name} does not qualify for ${scheme.name}`);
  }
  const ledger = await listCommissionLedger();
  const deductions = computeDeductions(awardAmount, payee);
  const wht = deductions.find((d) => d.code === "WHT_233");
  const deductionTotal = deductions.reduce((s, d) => s + d.amount, 0);

  entrySeq += 1;
  const entry: CommissionLedgerEntry = {
    id: `BON-${new Date().getFullYear()}-${String(entrySeq).padStart(5, "0")}`,
    entryKind: "BONUS",
    leadId: "—",
    payeeId: payee.id, payeeCode: payee.code, payeeName: payee.name, payeeType: payee.type, channel: payee.channel,
    policyId: "—", policyNumber: "—", customerName: `${scheme.name} (${scheme.measuredAt})`,
    segment: "individual", productName: scheme.name,
    premiumType: "FIRST_YEAR", policyYear: 1, collectedPremium: 0,
    basis: "PREMIUM", basisAmount: awardAmount, splitPct: 100, ratePct: 0,
    grossCommission: awardAmount,
    deductions, whtTax: wht?.amount ?? 0, whtPct: wht?.pct ?? 0,
    recoveryApplied: 0, netCommission: awardAmount - deductionTotal,
    // A bonus is earned on a measurement that has already happened, so it has a
    // single tranche that is due the moment it is awarded.
    releaseScheduleId: "SCH-BONUS-IMMEDIATE",
    stages: [
      {
        code: "PERSISTENCY_13M",
        label: `${scheme.name} qualified`,
        sharePct: 100,
        grossAmount: awardAmount,
        deductionAmount: deductionTotal,
        recoveryAmount: 0,
        netAmount: awardAmount - deductionTotal,
        status: "DUE",
        reason: `Qualified on ${scheme.metric} at ${scheme.measuredAt}`,
        triggeredAt: nowStamp(),
      },
    ],
    dueNet: awardAmount - deductionTotal,
    inRunNet: 0,
    pendingNet: 0,
    releasedNet: 0,
    status: "PAYABLE",
    gatingReason: `Qualified for ${scheme.name} — ${scheme.metric} ${qualification.metricValue}${scheme.kind === "PERSISTENCY_BONUS" ? "%" : ""} vs ${scheme.thresholdLabel}`,
    gatingChecks: [],
    ruleId: scheme.id, secpRef: scheme.code, parentEntryId: null, bonusSchemeCode: scheme.code,
    accruedAt: nowStamp(),
  };
  ledger.unshift(entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger construction from real policies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Channel assignment is deterministic on the policy index rather than random:
 * the ledger has to show the same numbers on every reload, and every channel
 * needs to appear so the portal exercises the whole payout stack.
 */
const CHANNEL_ROTATION: DistributionChannel[] = [
  "DIRECT_AGENCY", "BANCASSURANCE", "DIRECT_AGENCY", "BROKER",
  "CORPORATE_AGENT", "DIRECT_AGENCY", "REFERRAL", "DIGITAL_DIRECT",
];

export async function listCommissionLedger(): Promise<CommissionLedgerEntry[]> {
  if (ledgerCache !== null) return ledgerCache;

  const entries: CommissionLedgerEntry[] = [];
  try {
    const [policies, payees] = await Promise.all([listPolicies().catch(() => []), listPayees()]);
    const agents = payees.filter((p) => p.type === "AGENT" && p.channel === "DIRECT_AGENCY");

    (policies || []).forEach((p, idx) => {
      const estPremium = Math.round(p.coverage_amount * 0.025) || 250_000;
      const isIssued = p.status === "Active" || p.status === "PendingPayment";
      const isCollected = p.status === "Active";
      const channel = CHANNEL_ROTATION[idx % CHANNEL_ROTATION.length];
      const segment = (p.segment as PolicySegment) || "individual";

      // Seed the policy's event state from its real lifecycle status so the
      // tranches vest against the dates the policy actually has, not the moment
      // the ledger happens to be rebuilt.
      const events = getPolicyEvents(p.id);
      const issuedAt = (p.effective_date || p.created_at || "").replace("T", " ").slice(0, 19) || null;
      events.leadGeneratedAt = events.leadGeneratedAt ?? issuedAt;
      if (isIssued) events.issuedAt = events.issuedAt ?? issuedAt;
      if (isCollected) events.premiumCollectedAt = events.premiumCollectedAt ?? issuedAt;

      // Every third direct-agency case is co-sold, so split handling is visible.
      const primary = agents[idx % Math.max(agents.length, 1)];
      const secondary = agents[(idx + 1) % Math.max(agents.length, 1)];
      const isSplitCase = channel === "DIRECT_AGENCY" && idx % 3 === 2 && secondary && secondary.id !== primary?.id;

      let producers: ProducerSplit[] = [];
      let partnerPayeeId: string | null = null;
      let partnerStaffPayeeId: string | null = null;
      let referralPayeeId: string | null = null;

      switch (channel) {
        case "DIRECT_AGENCY":
          producers = primary
            ? isSplitCase
              ? [{ payeeId: primary.id, splitPct: 60 }, { payeeId: secondary.id, splitPct: 40 }]
              : [{ payeeId: primary.id, splitPct: 100 }]
            : [];
          break;
        case "BANCASSURANCE":
          partnerPayeeId = "PAYEE-BANK-01";
          partnerStaffPayeeId = "PAYEE-BSO-01";
          break;
        case "BROKER":
          partnerPayeeId = "PAYEE-BROKER-01";
          break;
        case "CORPORATE_AGENT":
          partnerPayeeId = "PAYEE-AGENCY-01";
          break;
        case "REFERRAL":
          // An introducer refers; the insurer's own agent still writes the case.
          producers = primary ? [{ payeeId: primary.id, splitPct: 100 }] : [];
          referralPayeeId = "PAYEE-REF-01";
          break;
        case "DIGITAL_DIRECT":
          partnerPayeeId = HOUSE_PAYEE.id;
          break;
      }

      // Referral cases pay the writing agent on the direct-agency card.
      const producerChannel: DistributionChannel = channel === "REFERRAL" ? "DIRECT_AGENCY" : channel;

      const result = computeCommissionWaterfall(
        {
          leadId: `LEAD-${9081 + idx}`,
          policyId: p.id,
          policyNumber: p.policy_number || `PL-ADAM-${98210 + idx}`,
          customerName: p.customer_name || "Valued Policyholder",
          productName: p.product_name || "Adamjee Life Protection Plan",
          segment,
          premiumType: "FIRST_YEAR",
          policyYear: 1,
          collectedPremium: estPremium,
          channel: producerChannel,
          producers,
          isIssued,
          isPremiumCollected: isCollected,
          eventDate: p.created_at || undefined,
        },
        payees,
      );
      entries.push(...result.entries);

      // Partner-side rows are priced on the partner's own channel card, so they
      // are computed as a second pass rather than folded into the producer run.
      if (partnerPayeeId) {
        const partnerResult = computeCommissionWaterfall(
          {
            leadId: `LEAD-${9081 + idx}`,
            policyId: p.id,
            policyNumber: p.policy_number || `PL-ADAM-${98210 + idx}`,
            customerName: p.customer_name || "Valued Policyholder",
            productName: p.product_name || "Adamjee Life Protection Plan",
            segment,
            premiumType: "FIRST_YEAR",
            policyYear: 1,
            collectedPremium: estPremium,
            channel,
            producers: [],
            partnerPayeeId,
            partnerStaffPayeeId,
            isIssued,
            isPremiumCollected: isCollected,
            eventDate: p.created_at || undefined,
          },
          payees,
        );
        entries.push(...partnerResult.entries);
      }

      if (referralPayeeId) {
        const referralResult = computeCommissionWaterfall(
          {
            leadId: `LEAD-${9081 + idx}`,
            policyId: p.id,
            policyNumber: p.policy_number || `PL-ADAM-${98210 + idx}`,
            customerName: p.customer_name || "Valued Policyholder",
            productName: p.product_name || "Adamjee Life Protection Plan",
            segment,
            premiumType: "FIRST_YEAR",
            policyYear: 1,
            collectedPremium: estPremium,
            channel: "REFERRAL",
            producers: [],
            referralPayeeId,
            isIssued,
            isPremiumCollected: isCollected,
            eventDate: p.created_at || undefined,
          },
          payees,
        );
        entries.push(...referralResult.entries);
      }
    });
  } catch (err) {
    console.warn("Could not build the commission ledger from backend policies", err);
  }

  ledgerCache = entries;
  return ledgerCache;
}

/** All entries raised on one policy — the full payout stack for that case. */
export function groupLedgerByPolicy(ledger: CommissionLedgerEntry[]) {
  const groups = new Map<string, CommissionLedgerEntry[]>();
  for (const entry of ledger) {
    const key = entry.policyId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }
  return Array.from(groups.entries()).map(([policyId, entries]) => {
    const premium = entries[0]?.collectedPremium ?? 0;
    const gross = entries.reduce((s, e) => s + (e.isClawback ? 0 : e.grossCommission), 0);
    const segment = entries[0]?.segment ?? "individual";
    const premiumType = entries[0]?.premiumType ?? "FIRST_YEAR";
    const ceilingPct = COMMISSION_CONFIG.payoutCeilingPct[segment][premiumType];
    const effectiveRatePct = premium > 0 ? (gross / premium) * 100 : 0;
    return {
      policyId,
      policyNumber: entries[0]?.policyNumber ?? "—",
      customerName: entries[0]?.customerName ?? "—",
      segment,
      premiumType,
      channel: entries[0]?.channel ?? "DIRECT_AGENCY",
      collectedPremium: premium,
      entries,
      totalGross: gross,
      totalNet: entries.reduce((s, e) => s + (e.isClawback ? 0 : e.netCommission), 0),
      // Where the policy's commission has got to across its release stages.
      dueNet: entries.reduce((s, e) => s + (e.isClawback ? 0 : e.dueNet), 0),
      inRunNet: entries.reduce((s, e) => s + (e.isClawback ? 0 : e.inRunNet), 0),
      pendingNet: entries.reduce((s, e) => s + (e.isClawback ? 0 : e.pendingNet), 0),
      releasedNet: entries.reduce((s, e) => s + (e.isClawback ? 0 : e.releasedNet), 0),
      events: getPolicyEvents(policyId),
      effectiveRatePct,
      ceilingPct,
      ceilingBreached: effectiveRatePct > ceilingPct + 0.001,
    };
  });
}

/** Pure computation — call with any pre-filtered ledger slice. */
export function computeCommissionStats(ledger: CommissionLedgerEntry[]): CommissionSummaryStats {
  const live = ledger.filter((l) => !l.isClawback);

  const sumBy = <K extends string>(keyOf: (e: CommissionLedgerEntry) => K) => {
    const map = new Map<K, { gross: number; net: number; entries: number }>();
    for (const e of live) {
      const key = keyOf(e);
      const cur = map.get(key) ?? { gross: 0, net: 0, entries: 0 };
      cur.gross += e.grossCommission;
      cur.net += e.netCommission;
      cur.entries += 1;
      map.set(key, cur);
    }
    return map;
  };

  const byChannelMap = sumBy((e) => e.channel);
  const byPayeeTypeMap = sumBy((e) => e.payeeType);

  const stageMap = new Map<ReleaseStageCode, { dueNet: number; pendingNet: number; releasedNet: number; stages: number }>();
  for (const entry of live) {
    for (const stage of entry.stages) {
      const cur = stageMap.get(stage.code) ?? { dueNet: 0, pendingNet: 0, releasedNet: 0, stages: 0 };
      if (stage.status === "DUE" || stage.status === "IN_RUN") cur.dueNet += stage.netAmount;
      else if (stage.status === "RELEASED") cur.releasedNet += stage.netAmount;
      else if (stage.status !== "REVERSED") cur.pendingNet += stage.netAmount;
      cur.stages += 1;
      stageMap.set(stage.code, cur);
    }
  }
  const stageOrder: ReleaseStageCode[] = [
    "LEAD_GENERATION", "POLICY_ISSUANCE", "PREMIUM_COLLECTION", "RENEWAL_COLLECTION", "FREE_LOOK_EXPIRY", "PERSISTENCY_13M",
  ];

  return {
    totalGrossCommission: live.reduce((s, l) => s + l.grossCommission, 0),
    totalAccruedLiability: live.reduce((s, l) => s + l.dueNet + l.inRunNet + l.pendingNet, 0),
    totalDueNow: live.reduce((s, l) => s + l.dueNet, 0),
    totalInRun: live.reduce((s, l) => s + l.inRunNet, 0),
    totalNotYetDue: live.reduce((s, l) => s + l.pendingNet, 0),
    totalDisbursed: live.reduce((s, l) => s + l.releasedNet, 0),
    totalClawbacks: ledger
      .filter((l) => l.isClawback || l.status === "CLAWED_BACK")
      .reduce((s, l) => s + Math.abs(l.clawbackAmount ?? l.netCommission), 0),
    totalWithheldTax: live.reduce((s, l) => s + l.deductions.reduce((d, x) => d + x.amount, 0), 0),
    firstYearCommissionTotal: live.filter((l) => l.premiumType === "FIRST_YEAR").reduce((s, l) => s + l.netCommission, 0),
    renewalCommissionTotal: live.filter((l) => l.premiumType === "RENEWAL").reduce((s, l) => s + l.netCommission, 0),
    singlePremiumCommissionTotal: live.filter((l) => l.premiumType === "SINGLE_PREMIUM").reduce((s, l) => s + l.netCommission, 0),
    firstYearPremiumTotal: groupLedgerByPolicy(live).filter((p) => p.premiumType === "FIRST_YEAR").reduce((s, p) => s + p.collectedPremium, 0),
    renewalPremiumTotal: groupLedgerByPolicy(live).filter((p) => p.premiumType === "RENEWAL").reduce((s, p) => s + p.collectedPremium, 0),
    singlePremiumTotal: groupLedgerByPolicy(live).filter((p) => p.premiumType === "SINGLE_PREMIUM").reduce((s, p) => s + p.collectedPremium, 0),
    overrideTotal: live.filter((l) => l.entryKind === "OVERRIDE").reduce((s, l) => s + l.netCommission, 0),
    bonusTotal: live.filter((l) => l.entryKind === "BONUS").reduce((s, l) => s + l.netCommission, 0),
    activePayeesCount: new Set(live.map((l) => l.payeeId)).size,
    gatedCount: ledger.filter((l) => l.status === "ACCRUED" || l.status === "HELD").length,
    byChannel: Array.from(byChannelMap.entries()).map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.gross - a.gross),
    byPayeeType: Array.from(byPayeeTypeMap.entries()).map(([payeeType, v]) => ({ payeeType, ...v })).sort((a, b) => b.gross - a.gross),
    byStage: Array.from(stageMap.entries())
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => stageOrder.indexOf(a.code) - stageOrder.indexOf(b.code)),
  };
}

export async function getCommissionStats(): Promise<CommissionSummaryStats> {
  const ledger = await listCommissionLedger();
  const live = ledger.filter((l) => !l.isClawback);


  const sumBy = <K extends string>(keyOf: (e: CommissionLedgerEntry) => K) => {
    const map = new Map<K, { gross: number; net: number; entries: number }>();
    for (const e of live) {
      const key = keyOf(e);
      const cur = map.get(key) ?? { gross: 0, net: 0, entries: 0 };
      cur.gross += e.grossCommission;
      cur.net += e.netCommission;
      cur.entries += 1;
      map.set(key, cur);
    }
    return map;
  };

  const byChannelMap = sumBy((e) => e.channel);
  const byPayeeTypeMap = sumBy((e) => e.payeeType);

  const stageMap = new Map<ReleaseStageCode, { dueNet: number; pendingNet: number; releasedNet: number; stages: number }>();
  for (const entry of live) {
    for (const stage of entry.stages) {
      const cur = stageMap.get(stage.code) ?? { dueNet: 0, pendingNet: 0, releasedNet: 0, stages: 0 };
      if (stage.status === "DUE" || stage.status === "IN_RUN") cur.dueNet += stage.netAmount;
      else if (stage.status === "RELEASED") cur.releasedNet += stage.netAmount;
      else if (stage.status !== "REVERSED") cur.pendingNet += stage.netAmount;
      cur.stages += 1;
      stageMap.set(stage.code, cur);
    }
  }
  const stageOrder: ReleaseStageCode[] = [
    "LEAD_GENERATION", "POLICY_ISSUANCE", "PREMIUM_COLLECTION", "RENEWAL_COLLECTION", "FREE_LOOK_EXPIRY", "PERSISTENCY_13M",
  ];

  return {
    totalGrossCommission: live.reduce((s, l) => s + l.grossCommission, 0),
    // Liability is what has not been paid yet — due, batched and not-yet-vested
    // tranches alike — so it is summed from the stages rather than from status.
    totalAccruedLiability: live.reduce((s, l) => s + l.dueNet + l.inRunNet + l.pendingNet, 0),
    totalDueNow: live.reduce((s, l) => s + l.dueNet, 0),
    totalInRun: live.reduce((s, l) => s + l.inRunNet, 0),
    totalNotYetDue: live.reduce((s, l) => s + l.pendingNet, 0),
    totalDisbursed: live.reduce((s, l) => s + l.releasedNet, 0),
    totalClawbacks: ledger
      .filter((l) => l.isClawback || l.status === "CLAWED_BACK")
      .reduce((s, l) => s + Math.abs(l.clawbackAmount ?? l.netCommission), 0),
    totalWithheldTax: live.reduce((s, l) => s + l.deductions.reduce((d, x) => d + x.amount, 0), 0),
    firstYearCommissionTotal: live.filter((l) => l.premiumType === "FIRST_YEAR").reduce((s, l) => s + l.netCommission, 0),
    renewalCommissionTotal: live.filter((l) => l.premiumType === "RENEWAL").reduce((s, l) => s + l.netCommission, 0),
    singlePremiumCommissionTotal: live.filter((l) => l.premiumType === "SINGLE_PREMIUM").reduce((s, l) => s + l.netCommission, 0),
    firstYearPremiumTotal: groupLedgerByPolicy(live).filter((p) => p.premiumType === "FIRST_YEAR").reduce((s, p) => s + p.collectedPremium, 0),
    renewalPremiumTotal: groupLedgerByPolicy(live).filter((p) => p.premiumType === "RENEWAL").reduce((s, p) => s + p.collectedPremium, 0),
    singlePremiumTotal: groupLedgerByPolicy(live).filter((p) => p.premiumType === "SINGLE_PREMIUM").reduce((s, p) => s + p.collectedPremium, 0),
    overrideTotal: live.filter((l) => l.entryKind === "OVERRIDE").reduce((s, l) => s + l.netCommission, 0),
    bonusTotal: live.filter((l) => l.entryKind === "BONUS").reduce((s, l) => s + l.netCommission, 0),
    activePayeesCount: new Set(live.map((l) => l.payeeId)).size,
    gatedCount: ledger.filter((l) => l.status === "ACCRUED" || l.status === "HELD").length,
    byChannel: Array.from(byChannelMap.entries()).map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.gross - a.gross),
    byPayeeType: Array.from(byPayeeTypeMap.entries()).map(([payeeType, v]) => ({ payeeType, ...v })).sort((a, b) => b.gross - a.gross),
    byStage: Array.from(stageMap.entries())
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => stageOrder.indexOf(a.code) - stageOrder.indexOf(b.code)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout runs — maker/checker
// ─────────────────────────────────────────────────────────────────────────────

export type PayoutRunStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "PAID" | "REJECTED";

/** One tranche of one entry, pinned into a run. */
export interface PayoutRunLine {
  entryId: string;
  stageCode: ReleaseStageCode;
}

export interface PayoutRun {
  id: string;
  period: string;
  channel: DistributionChannel | "ALL";
  status: PayoutRunStatus;
  /** The individual tranches being paid — a run pays stages, not whole entries. */
  lines: PayoutRunLine[];
  entryIds: string[];
  stageCount: number;
  payeeCount: number;
  grossTotal: number;
  deductionsTotal: number;
  recoveryTotal: number;
  netTotal: number;
  createdBy: string;
  createdAt: string;
  submittedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  paidAt?: string;
  paymentMethod?: string;
  paymentReference?: string;
}

let payoutRuns: PayoutRun[] = [];
let runSeq = 0;

export async function listPayoutRuns(): Promise<PayoutRun[]> {
  return payoutRuns;
}

/** Every tranche that has vested and is not already batched or paid. */
export function collectDueStages(
  ledger: CommissionLedgerEntry[],
  filter: { channel?: DistributionChannel | "ALL"; entryIds?: string[] } = {},
): { entry: CommissionLedgerEntry; stage: ReleaseStage }[] {
  const due: { entry: CommissionLedgerEntry; stage: ReleaseStage }[] = [];
  for (const entry of ledger) {
    if (entry.payeeType === "HOUSE" || entry.entryKind === "CLAWBACK" || entry.status === "CLAWED_BACK") continue;
    if (filter.channel && filter.channel !== "ALL" && entry.channel !== filter.channel) continue;
    if (filter.entryIds && !filter.entryIds.includes(entry.id)) continue;
    for (const stage of entry.stages) {
      if (stage.status === "DUE") due.push({ entry, stage });
    }
  }
  return due;
}

function totalsForStages(lines: { entry: CommissionLedgerEntry; stage: ReleaseStage }[]) {
  return {
    grossTotal: lines.reduce((s, l) => s + l.stage.grossAmount, 0),
    deductionsTotal: lines.reduce((s, l) => s + l.stage.deductionAmount, 0),
    recoveryTotal: lines.reduce((s, l) => s + l.stage.recoveryAmount, 0),
    netTotal: lines.reduce((s, l) => s + l.stage.netAmount, 0),
    payeeCount: new Set(lines.map((l) => l.entry.payeeId)).size,
    stageCount: lines.length,
  };
}

/**
 * Batch the tranches that have fallen due into a run. Only stages in DUE are
 * eligible: a stage whose event has not happened yet, or whose payee failed a
 * licence or suspension check, is left behind by design — so a run can never
 * quietly release money that has not vested.
 */
export async function createPayoutRun(args: {
  period: string;
  channel: DistributionChannel | "ALL";
  createdBy: string;
  entryIds?: string[];
}): Promise<PayoutRun> {
  const ledger = await listCommissionLedger();
  const eligible = collectDueStages(ledger, { channel: args.channel, entryIds: args.entryIds });
  if (eligible.length === 0) throw new Error("No commission tranches have fallen due in this run's scope");

  runSeq += 1;
  const run: PayoutRun = {
    id: `RUN-${new Date().getFullYear()}-${String(runSeq).padStart(3, "0")}`,
    period: args.period,
    channel: args.channel,
    status: "DRAFT",
    lines: eligible.map((l) => ({ entryId: l.entry.id, stageCode: l.stage.code })),
    entryIds: Array.from(new Set(eligible.map((l) => l.entry.id))),
    createdBy: args.createdBy,
    createdAt: nowStamp(),
    ...totalsForStages(eligible),
  };

  for (const { entry, stage } of eligible) {
    stage.status = "IN_RUN";
    stage.payoutRunId = run.id;
    stage.reason = `Locked into payout run ${run.id} (${run.period})`;
    evaluateEntryStages(entry, getPolicyEvents(entry.policyId));
    entry.payoutRunId = run.id;
  }

  payoutRuns = [run, ...payoutRuns];
  return run;
}

export async function submitPayoutRun(runId: string): Promise<PayoutRun> {
  const run = payoutRuns.find((r) => r.id === runId);
  if (!run) throw new Error("Payout run not found");
  if (run.status !== "DRAFT") throw new Error(`Run ${runId} is ${run.status}, not DRAFT`);
  run.status = "PENDING_APPROVAL";
  run.submittedAt = nowStamp();
  return run;
}

/** Checker step — the approver must differ from the maker. */
export async function approvePayoutRun(runId: string, approvedBy: string): Promise<PayoutRun> {
  const run = payoutRuns.find((r) => r.id === runId);
  if (!run) throw new Error("Payout run not found");
  if (run.status !== "PENDING_APPROVAL") throw new Error(`Run ${runId} is ${run.status}, not awaiting approval`);
  if (approvedBy.trim().toLowerCase() === run.createdBy.trim().toLowerCase()) {
    throw new Error("Segregation of duties: a run cannot be approved by the user who created it");
  }
  run.status = "APPROVED";
  run.approvedBy = approvedBy;
  run.approvedAt = nowStamp();
  return run;
}

export async function rejectPayoutRun(runId: string, reason: string): Promise<PayoutRun> {
  const run = payoutRuns.find((r) => r.id === runId);
  if (!run) throw new Error("Payout run not found");
  if (run.status === "PAID") throw new Error("A paid run cannot be rejected");
  const ledger = await listCommissionLedger();
  for (const { entry, stage } of stagesInRun(ledger, runId)) {
    stage.status = "DUE";
    stage.payoutRunId = undefined;
    stage.reason = `Returned to due — run ${runId} rejected`;
    entry.payoutRunId = undefined;
    evaluateEntryStages(entry, getPolicyEvents(entry.policyId));
  }
  run.status = "REJECTED";
  run.rejectedReason = reason;
  return run;
}

/** The (entry, stage) pairs a run is paying. */
function stagesInRun(ledger: CommissionLedgerEntry[], runId: string) {
  const pairs: { entry: CommissionLedgerEntry; stage: ReleaseStage }[] = [];
  for (const entry of ledger) {
    for (const stage of entry.stages) {
      if (stage.payoutRunId === runId) pairs.push({ entry, stage });
    }
  }
  return pairs;
}

/**
 * Release an approved run: pays each tranche in it, clears the recovery that
 * tranche carried, and leaves the entry's later stages untouched — a policy can
 * be half-paid and still owe its persistency tail.
 */
export async function payPayoutRun(runId: string, paymentMethod: string): Promise<PayoutRun> {
  const run = payoutRuns.find((r) => r.id === runId);
  if (!run) throw new Error("Payout run not found");
  if (run.status !== "APPROVED") throw new Error(`Run ${runId} must be approved before payment`);

  const [ledger, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  const byId = new Map(payees.map((p) => [p.id, p]));
  const stamp = nowStamp();

  for (const { entry, stage } of stagesInRun(ledger, runId)) {
    stage.status = "RELEASED";
    stage.releasedAt = stamp;
    stage.reason = `Released via ${paymentMethod} in run ${runId}`;
    entry.disbursedAt = stamp;

    const payee = byId.get(entry.payeeId);
    if (payee) {
      payee.recoveryBalance = Math.max(0, payee.recoveryBalance - stage.recoveryAmount);
      payee.ytdCommission += stage.grossAmount;
    }
    evaluateEntryStages(entry, getPolicyEvents(entry.policyId));
  }

  run.status = "PAID";
  run.paidAt = stamp;
  run.paymentMethod = paymentMethod;
  run.paymentReference = `PMT-${runId}-${Math.floor(1000 + Math.random() * 9000)}`;
  return run;
}

export function resetPayoutRuns() {
  payoutRuns = [];
  runSeq = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Disbursement & clawback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Release outside a run — a one-off correction. Only the tranches that have
 * actually fallen due are paid; stages still waiting on their event stay put,
 * which is why this can leave the entry PARTIALLY_RELEASED rather than paid.
 */
export async function disburseCommission(ledgerId: string, stageCode?: ReleaseStageCode): Promise<CommissionLedgerEntry> {
  const [ledger, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  const entry = ledger.find((l) => l.id === ledgerId);
  if (!entry) throw new Error("Commission entry not found");

  const targets = entry.stages.filter((s) => s.status === "DUE" && (!stageCode || s.code === stageCode));
  if (targets.length === 0) {
    throw new Error(
      stageCode
        ? `Stage ${RELEASE_STAGE_LABELS[stageCode]} on ${ledgerId} has not fallen due`
        : `No tranche of ${ledgerId} has fallen due — ${entry.gatingReason}`,
    );
  }

  const payee = payees.find((p) => p.id === entry.payeeId);
  const stamp = nowStamp();
  for (const stage of targets) {
    stage.status = "RELEASED";
    stage.releasedAt = stamp;
    stage.reason = `Released to ${entry.payeeName} (${entry.payeeCode})`;
    if (payee) {
      payee.recoveryBalance = Math.max(0, payee.recoveryBalance - stage.recoveryAmount);
      payee.ytdCommission += stage.grossAmount;
    }
  }
  entry.disbursedAt = stamp;
  evaluateEntryStages(entry, getPolicyEvents(entry.policyId));
  return entry;
}

/** Withhold an entry: every unreleased tranche stops, including future ones. */
export async function holdCommission(ledgerId: string, reason: string): Promise<CommissionLedgerEntry> {
  const ledger = await listCommissionLedger();
  const entry = ledger.find((l) => l.id === ledgerId);
  if (!entry) throw new Error("Commission entry not found");
  for (const stage of entry.stages) {
    if (stage.status === "DUE" || stage.status === "PENDING") {
      stage.status = "BLOCKED";
      stage.reason = `Held: ${reason}`;
    }
  }
  entry.dueNet = 0;
  entry.pendingNet = entry.stages
    .filter((s) => s.status === "BLOCKED" || s.status === "PENDING")
    .reduce((s, x) => s + x.netAmount, 0);
  entry.status = "HELD";
  entry.gatingReason = `Held: ${reason}`;
  return entry;
}

/** Lift a hold and let the stages re-evaluate against the policy's events. */
export async function releaseHold(ledgerId: string): Promise<CommissionLedgerEntry> {
  const ledger = await listCommissionLedger();
  const entry = ledger.find((l) => l.id === ledgerId);
  if (!entry) throw new Error("Commission entry not found");
  if (entry.status !== "HELD") throw new Error(`Entry ${ledgerId} is ${entry.status}, not held`);
  for (const stage of entry.stages) {
    if (stage.status === "BLOCKED") stage.status = "PENDING";
  }
  entry.status = "ACCRUED";
  evaluateEntryStages(entry, getPolicyEvents(entry.policyId));
  return entry;
}

export interface ClawbackResult {
  original: CommissionLedgerEntry;
  reversal: CommissionLedgerEntry;
  /** Overrides and partner shares reversed along with the producer's entry. */
  cascaded: CommissionLedgerEntry[];
  recoveryRaised: number;
}

/**
 * Reverse a commission. Two things a status flip alone can't do: the reversal is
 * posted as its own negative ledger entry (so the audit trail keeps the original
 * intact), and anything already paid becomes a recovery balance netted off the
 * payee's future payouts. Overrides computed from the reversed entry cascade —
 * a manager cannot keep an override on production that no longer exists.
 */
export async function triggerClawback(ledgerId: string, reason: string, cascade = true): Promise<ClawbackResult> {
  const [ledger, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  const entry = ledger.find((l) => l.id === ledgerId);
  if (!entry) throw new Error("Commission entry not found");
  if (entry.status === "CLAWED_BACK") throw new Error("Entry has already been clawed back");

  const byId = new Map(payees.map((p) => [p.id, p]));
  const stamp = nowStamp();
  let recoveryRaised = 0;

  const reverse = (target: CommissionLedgerEntry): CommissionLedgerEntry => {
    // Only the tranches actually paid have to be chased; unvested and unbatched
    // ones are simply cancelled, which is the whole point of staging the release.
    const paidOut = target.stages.filter((s) => s.status === "RELEASED").reduce((s, x) => s + x.netAmount, 0);
    for (const stage of target.stages) {
      if (stage.status !== "RELEASED") {
        stage.status = "REVERSED";
        stage.reason = `Cancelled before release: ${reason}`;
        stage.payoutRunId = undefined;
      }
    }
    target.status = "CLAWED_BACK";
    target.isClawback = true;
    target.clawbackAmount = paidOut;
    target.clawbackReason = reason;
    target.dueNet = 0;
    target.inRunNet = 0;
    target.pendingNet = 0;
    target.gatingReason =
      paidOut > 0
        ? `Reversed: ${reason} — ${paidOut} already released is recoverable`
        : `Reversed before any tranche was released: ${reason}`;

    // Money already out the door has to be recovered from future earnings;
    // money still accrued just never gets released.
    const payee = byId.get(target.payeeId);
    if (paidOut > 0 && payee) {
      payee.recoveryBalance += paidOut;
      recoveryRaised += paidOut;
    }
    const wasPaid = paidOut > 0;

    entrySeq += 1;
    const reversal: CommissionLedgerEntry = {
      ...target,
      id: `CLB-${new Date().getFullYear()}-${String(entrySeq).padStart(5, "0")}`,
      entryKind: "CLAWBACK",
      grossCommission: -target.grossCommission,
      deductions: target.deductions.map((d) => ({ ...d, amount: -d.amount })),
      whtTax: -target.whtTax,
      recoveryApplied: 0,
      netCommission: -target.netCommission,
      status: "CLAWED_BACK",
      isClawback: true,
      clawbackAmount: paidOut,
      clawbackReason: reason,
      reversalOfEntryId: target.id,
      gatingReason: wasPaid
        ? `Reversal of ${target.id} — ${paidOut} recovered from ${target.payeeName}, the rest cancelled before release`
        : `Reversal of ${target.id} — nothing had been released, nothing to recover`,
      gatingChecks: [],
      stages: [],
      dueNet: 0,
      inRunNet: 0,
      pendingNet: 0,
      releasedNet: 0,
      payoutRunId: undefined,
      disbursedAt: undefined,
      accruedAt: stamp,
    };
    ledger.unshift(reversal);
    return reversal;
  };

  const reversal = reverse(entry);

  const cascaded: CommissionLedgerEntry[] = [];
  if (cascade) {
    const dependents = ledger.filter(
      (l) => l.parentEntryId === entry.id && l.entryKind !== "CLAWBACK" && l.status !== "CLAWED_BACK",
    );
    for (const dependent of dependents) {
      cascaded.push(reverse(dependent));
    }
  }

  return { original: entry, reversal, cascaded, recoveryRaised };
}

// ─────────────────────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────────────────────

export interface PayeeStatement {
  payee: CommissionPayee;
  entries: CommissionLedgerEntry[];
  openingRecovery: number;
  grossCommission: number;
  overrides: number;
  bonuses: number;
  clawbacks: number;
  deductions: StatutoryDeduction[];
  totalDeductions: number;
  recoveryApplied: number;
  netPayable: number;
  disbursed: number;
  pending: number;
  /** Split of what is still owed: vested now, batched, or not yet vested. */
  dueNow: number;
  inRun: number;
  notYetDue: number;
  /** The next tranche waiting on an event, for "what am I owed and when". */
  nextStage: { code: ReleaseStageCode; label: string; netAmount: number; reason: string } | null;
  whtPct: number;
}

/** A payee's own statement — what they earned, what was deducted, what's left. */
export async function buildPayeeStatement(payeeId: string): Promise<PayeeStatement> {
  const [ledger, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  const payee = payees.find((p) => p.id === payeeId);
  if (!payee) throw new Error("Payee not found");

  const entries = ledger.filter((l) => l.payeeId === payeeId);
  const live = entries.filter((e) => e.entryKind !== "CLAWBACK" && !e.isClawback);

  // Roll deductions up by code so the statement shows one line per tax head.
  const byCode = new Map<string, StatutoryDeduction>();
  for (const entry of live) {
    for (const d of entry.deductions) {
      const cur = byCode.get(d.code);
      byCode.set(d.code, cur ? { ...cur, amount: cur.amount + d.amount } : { ...d });
    }
  }

  return {
    payee,
    entries,
    openingRecovery: payee.recoveryBalance,
    grossCommission: live.filter((e) => e.entryKind === "COMMISSION" || e.entryKind === "PARTNER_FEE" || e.entryKind === "REFERRAL_FEE").reduce((s, e) => s + e.grossCommission, 0),
    overrides: live.filter((e) => e.entryKind === "OVERRIDE").reduce((s, e) => s + e.grossCommission, 0),
    bonuses: live.filter((e) => e.entryKind === "BONUS").reduce((s, e) => s + e.grossCommission, 0),
    clawbacks: entries.filter((e) => e.entryKind === "CLAWBACK").reduce((s, e) => s + Math.abs(e.netCommission), 0),
    deductions: Array.from(byCode.values()),
    totalDeductions: live.reduce((s, e) => s + e.deductions.reduce((d, x) => d + x.amount, 0), 0),
    recoveryApplied: live.reduce((s, e) => s + e.recoveryApplied, 0),
    netPayable: live.reduce((s, e) => s + e.netCommission, 0),
    // Paid vs outstanding is read off the stages, not the entry status: a
    // half-released entry contributes to both sides of the statement.
    disbursed: live.reduce((s, e) => s + e.releasedNet, 0),
    pending: live.reduce((s, e) => s + e.dueNet + e.inRunNet + e.pendingNet, 0),
    dueNow: live.reduce((s, e) => s + e.dueNet, 0),
    inRun: live.reduce((s, e) => s + e.inRunNet, 0),
    notYetDue: live.reduce((s, e) => s + e.pendingNet, 0),
    nextStage: (() => {
      const upcoming = live
        .flatMap((e) => e.stages)
        .filter((s) => s.status === "PENDING")
        .sort((a, b) => b.netAmount - a.netAmount)[0];
      return upcoming
        ? { code: upcoming.code, label: upcoming.label, netAmount: upcoming.netAmount, reason: upcoming.reason }
        : null;
    })(),
    whtPct: resolveWhtPct(payee),
  };
}

export async function listPayeeStatements(): Promise<PayeeStatement[]> {
  const [ledger, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  const withEntries = new Set(ledger.map((l) => l.payeeId));
  const statements = await Promise.all(
    payees.filter((p) => withEntries.has(p.id)).map((p) => buildPayeeStatement(p.id)),
  );
  return statements.sort((a, b) => b.netPayable - a.netPayable);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports — bank payment file and GL journal
// ─────────────────────────────────────────────────────────────────────────────

function toCsv(rows: (string | number)[][]): string {
  return rows
    .map((row) => row.map((cell) => (typeof cell === "string" && /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
    .join("\n");
}

/** Bank upload file: one line per payee, net of tax and recovery. */
export async function buildPayoutFile(runId: string): Promise<string> {
  const [ledger, payees, runs] = await Promise.all([listCommissionLedger(), listPayees(), listPayoutRuns()]);
  const run = runs.find((r) => r.id === runId);
  if (!run) throw new Error("Payout run not found");
  const byId = new Map(payees.map((p) => [p.id, p]));

  // One line per payee, summing the tranches of theirs that this run pays.
  const perPayee = new Map<string, number>();
  for (const { entry, stage } of stagesInRun(ledger, runId)) {
    perPayee.set(entry.payeeId, (perPayee.get(entry.payeeId) ?? 0) + stage.netAmount);
  }

  const rows: (string | number)[][] = [
    ["run_id", "period", "payee_code", "payee_name", "payee_type", "bank", "account", "tax_id", "currency", "net_amount"],
  ];
  for (const [payeeId, amount] of Array.from(perPayee.entries())) {
    const p = byId.get(payeeId);
    rows.push([
      run.id, run.period, p?.code ?? payeeId, p?.name ?? "", p?.type ?? "",
      p?.bankName ?? "", p?.bankAccount ?? "", p?.taxId ?? "", COMMISSION_CONFIG.currency, amount,
    ]);
  }
  return toCsv(rows);
}

/**
 * GL journal for a run: commission expense against the payable that clears,
 * with each withheld tax head posted to its own liability account.
 */
export async function buildGlJournal(runId: string): Promise<string> {
  const [ledger, runs] = await Promise.all([listCommissionLedger(), listPayoutRuns()]);
  const run = runs.find((r) => r.id === runId);
  if (!run) throw new Error("Payout run not found");
  // The journal posts the tranches this run releases, not the entries' lifetime
  // totals — the rest of each entry is still an accrual, not an expense to clear.
  const lines = stagesInRun(ledger, runId);

  const gross = lines.reduce((s, l) => s + l.stage.grossAmount, 0);
  const recovery = lines.reduce((s, l) => s + l.stage.recoveryAmount, 0);
  const net = lines.reduce((s, l) => s + l.stage.netAmount, 0);

  // Each stage's single deduction figure is split back out by tax head in the
  // same proportion the entry carries, with the remainder on the last head so
  // the credits still add up to the debit exactly.
  const taxByCode = new Map<string, { label: string; amount: number }>();
  for (const { entry, stage } of lines) {
    const entryDeductions = entry.deductions.reduce((s, d) => s + d.amount, 0);
    let left = stage.deductionAmount;
    entry.deductions.forEach((d, idx) => {
      const isLast = idx === entry.deductions.length - 1;
      const share = isLast || entryDeductions === 0 ? left : Math.round((stage.deductionAmount * d.amount) / entryDeductions);
      left -= share;
      const cur = taxByCode.get(d.code);
      taxByCode.set(d.code, { label: d.label, amount: (cur?.amount ?? 0) + share });
    });
  }

  const rows: (string | number)[][] = [["run_id", "account", "description", "debit", "credit"]];
  rows.push([run.id, "6100 — Commission expense", `Commission expense for ${run.period}`, gross, 0]);
  for (const [code, tax] of Array.from(taxByCode.entries())) {
    rows.push([run.id, `2310 — Tax withheld payable (${code})`, tax.label, 0, tax.amount]);
  }
  if (recovery > 0) {
    rows.push([run.id, "1450 — Commission recoverable", "Clawback / advance recovered from payees", 0, recovery]);
  }
  rows.push([run.id, "2210 — Commission payable", `Net payable to payees for ${run.period}`, 0, net]);
  return toCsv(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ad-hoc accrual (used by the calculator)
// ─────────────────────────────────────────────────────────────────────────────

export interface AccrualInput {
  leadId?: string;
  policyId?: string;
  policyNumber?: string;
  customerName: string;
  productName?: string;
  segment: PolicySegment;
  premiumType: PremiumType;
  policyYear: number;
  collectedPremium: number;
  channel: DistributionChannel;
  producers: ProducerSplit[];
  partnerPayeeId?: string | null;
  partnerStaffPayeeId?: string | null;
  referralPayeeId?: string | null;
  isIssued: boolean;
  isPremiumCollected: boolean;
}

function toWaterfallInput(input: AccrualInput): WaterfallInput {
  // Placeholder ids for an accrual that arrives without a policy attached.
  // Seeded off the stable parts of the input rather than Math.random(), so the
  // same accrual always resolves to the same id — a random one meant the same
  // commission could not be deduplicated or reconciled across two calls.
  const seq = seeded(
    `accrual:${input.leadId ?? ""}:${input.customerName}:${input.productName ?? ""}:${input.collectedPremium}`,
    10_000,
    99_999,
  );
  return {
    leadId: input.leadId ?? `LEAD-${seq}`,
    policyId: input.policyId ?? `PL-${seq}`,
    policyNumber: input.policyNumber ?? `PL-ADAM-${seq}`,
    customerName: input.customerName,
    productName: input.productName ?? "Adamjee Life Custom Protection Plan",
    segment: input.segment,
    premiumType: input.premiumType,
    policyYear: input.policyYear,
    collectedPremium: input.collectedPremium,
    channel: input.channel,
    producers: input.producers,
    partnerPayeeId: input.partnerPayeeId,
    partnerStaffPayeeId: input.partnerStaffPayeeId,
    referralPayeeId: input.referralPayeeId,
    isIssued: input.isIssued,
    isPremiumCollected: input.isPremiumCollected,
  };
}

/** Preview the full stack without writing anything to the ledger. */
export async function previewCommissionWaterfall(input: AccrualInput): Promise<WaterfallResult> {
  const payees = await listPayees();
  return computeCommissionWaterfall(toWaterfallInput(input), payees);
}

/** Compute and post the full stack for one premium event. */
export async function accrueCommissionForPolicy(input: AccrualInput): Promise<WaterfallResult> {
  const [payees, ledger] = await Promise.all([listPayees(), listCommissionLedger()]);
  const result = computeCommissionWaterfall(toWaterfallInput(input), payees);
  ledger.unshift(...result.entries);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension: Disbursement & Treasury + Risk & Regulatory Models & Stores
// ─────────────────────────────────────────────────────────────────────────────

export interface PayoutDispatchBatch {
  batchId: string;
  payoutRunId: string;
  railType: 'RAAST_BULK' | '1LINK_IBFT' | 'MCB_PAYDIRECT' | 'HBL_CORPORATE';
  targetBankCode: string;
  totalRecords: number;
  totalGrossAmount: number;
  totalWhtDeducted: number;
  totalNetDisbursed: number;
  status: 'QUEUED' | 'GENERATED' | 'DISPATCHED' | 'ACKNOWLEDGED' | 'FAILED';
  /** Null until a real payment file is produced and hashed. Never render a
   *  placeholder digest here — a wrong checksum is worse than no checksum. */
  fileChecksumSha256: string | null;
  filePath: string;
  dispatchedAt?: string;
  ackReference?: string;
}

export interface SettlementRecord {
  settlementId: string;
  batchId: string;
  lineItemId: string;
  payeeId: string;
  bankReferenceNumber: string;
  clearingDate: string;
  status: 'CLEARED' | 'BOUNCED' | 'DISPUTED';
  returnReasonCode?: string;
  returnReasonDescription?: string;
  actionTaken: 'NONE' | 'RETURNED_TO_UNPAID' | 'HELD_FOR_REVIEW';
}

export interface CommissionHoldbackLien {
  holdbackId: string;
  payeeId: string;
  category: 'SECP_LICENSE_EXPIRED' | 'FRAUD_SUSPENSION' | 'DEBT_RECOVERY' | 'COURT_LIEN';
  withholdingPercentage: number;
  targetAmount?: number | null;
  accumulatedRecovered: number;
  startDate: string;
  endDate?: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'FULFILLED' | 'CANCELLED';
  authorizedBy: string;
  reasonNotes: string;
}

export interface ClawbackTransaction {
  clawbackId: string;
  policyNumber: string;
  originalTransactionId: string;
  payeeId: string;
  roleInHierarchy: 'PRODUCER' | 'UNIT_MANAGER' | 'BRANCH_MANAGER' | 'AGENCY_DIRECTOR';
  clawbackTrigger: 'FREE_LOOK_CANCELLATION' | 'EARLY_LAPSE' | 'DISHONORED_CHEQUE' | 'FRAUD_REVERSAL';
  grossClawbackAmount: number;
  taxAdjustmentAmount: number;
  netDebitAmount: number;
  recoveryStatus: 'FULLY_RECOVERED' | 'PARTIALLY_RECOVERED' | 'CARRIED_FORWARD_DEBT';
  createdAt: string;
}

export interface PayeeTaxProfile {
  payeeId: string;
  /** Null when the payee has no tax ID on file. Never synthesise one — this
   *  identifies a real person to FBR. Render "Not on file" instead. */
  cnicOrNtn: string | null;
  fbrStatus: 'ACTIVE_FILER' | 'NON_FILER' | 'EXEMPT';
  applicableWhtRate: number;
  /** Null until a real Active Taxpayer List sync has run. */
  lastAtlSyncTimestamp: string | null;
  taxExemptionCertificateRef?: string;
  totalTaxWithheldYtd: number;
}

export interface SecpRegulatoryMetric {
  fiscalYear: string;
  productLine: 'CONVENTIONAL_INDIVIDUAL_LIFE' | 'TAKAFUL_FAMILY' | 'BANCASSURANCE';
  totalGrossPremiumCollected: number;
  totalDistributionExpense: number;
  currentExpenseRatio: number;
  secpStatutoryCapRatio: number;
  variancePercentage: number;
  complianceStatus: 'COMPLIANT' | 'WARNING_85_PERCENT' | 'BREACHED';
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATA — treasury, settlement, holdback, clawback, tax and SECP modules
//
// Everything below this line is SYNTHETIC. There is no backend for banking
// dispatch, settlement reconciliation, holdbacks, clawbacks, FBR tax profiles
// or SECP expense-ratio reporting, so these six generators invent records so
// the screens have something to render.
//
// Three rules apply to anything added here, learned the hard way:
//
//   1. It must be deterministic. These render as financial records; an amount
//      that changes between two page loads is worse than no amount at all.
//      Use `seeded()` below, never Math.random().
//   2. It must not invent identity or regulatory attributes for a REAL person.
//      Payees are real agent users. Attaching an invented CNIC, NTN or filer
//      status to one produces a screen that libels a named individual.
//   3. Every page that renders it must show <DemoDataBanner/>, so nobody
//      mistakes it for a system of record.
//
// Replace a generator with a real API call and delete its banner. Until then
// these are illustrations, not data.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO_DATA_NOTICE =
  "Illustrative data. This module has no backend yet — figures are generated in the browser and are not a system of record.";

/**
 * Small deterministic PRNG (FNV-1a hash → xorshift). Same key always yields
 * the same number, so a given record keeps its amounts across reloads and
 * between users. This is the whole point — see rule 1 above.
 */
function seeded(key: string, min: number, max: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h << 13; h >>>= 0;
  h ^= h >> 17;
  h ^= h << 5;  h >>>= 0;
  return min + (h % (max - min + 1));
}

let dispatchBatchesCache: PayoutDispatchBatch[] | null = null;
let settlementsCache: SettlementRecord[] | null = null;
let holdbacksCache: CommissionHoldbackLien[] | null = null;
let clawbacksCache: ClawbackTransaction[] | null = null;
let taxProfilesCache: PayeeTaxProfile[] | null = null;
let secpMetricsCache: SecpRegulatoryMetric[] | null = null;

export async function listPayoutDispatchBatches(): Promise<PayoutDispatchBatch[]> {
  if (dispatchBatchesCache) return dispatchBatchesCache;
  const runs = await listPayoutRuns();
  dispatchBatchesCache = runs.map((run, i) => ({
    batchId: `BATCH-${run.id}`,
    payoutRunId: run.id,
    railType: i % 2 === 0 ? '1LINK_IBFT' : 'RAAST_BULK',
    targetBankCode: 'MEZ',
    // Real run totals — these were previously read as totalGross/totalWithheld/
    // totalNet, which are not fields on PayoutRun, so every amount column on
    // the Banking screen rendered undefined.
    totalRecords: run.payeeCount,
    totalGrossAmount: run.grossTotal,
    totalWhtDeducted: run.deductionsTotal,
    totalNetDisbursed: run.netTotal,
    status: i === 0 ? 'GENERATED' : 'ACKNOWLEDGED',
    // No file is actually produced, so there is nothing to hash. This used to
    // carry the SHA-256 of the empty string, which reads as a real digest.
    fileChecksumSha256: null,
    filePath: `/sftp/outbound/PAYOUT_${run.id}.csv`,
    dispatchedAt: i === 0 ? undefined : run.createdAt,
    ackReference: i === 0 ? undefined : `1LINK-ACK-${seeded(`ack:${run.id}`, 100000, 999999)}`
  }));
  return dispatchBatchesCache;
}

export async function listSettlementRecords(): Promise<SettlementRecord[]> {
  if (settlementsCache) return settlementsCache;
  const payees = await listPayees();
  settlementsCache = payees.slice(0, 15).map((p, i) => ({
    settlementId: `SETTL-${seeded(`settl:${p.id}`, 10000, 99999)}`,
    batchId: `BATCH-RUN-${seeded(`batch:${p.id}`, 1, 10)}`,
    lineItemId: `LI-${seeded(`li:${p.id}`, 10000, 99999)}`,
    payeeId: p.id,
    bankReferenceNumber: `BNK-${seeded(`bnk:${p.id}`, 1000000, 9999999)}`,
    clearingDate: new Date().toISOString(),
    status: i % 5 === 0 ? 'BOUNCED' : 'CLEARED',
    returnReasonCode: i % 5 === 0 ? 'TITLE_MISMATCH' : undefined,
    returnReasonDescription: i % 5 === 0 ? 'Beneficiary name does not match account title' : undefined,
    actionTaken: i % 5 === 0 ? 'RETURNED_TO_UNPAID' : 'NONE'
  }));
  return settlementsCache;
}

export async function listHoldbacks(): Promise<CommissionHoldbackLien[]> {
  if (holdbacksCache) return holdbacksCache;
  const payees = await listPayees();
  holdbacksCache = payees.slice(0, 5).map((p, i) => ({
    holdbackId: `HOLD-${seeded(`hold:${p.id}`, 1000, 9999)}`,
    payeeId: p.id,
    category: i === 0 ? 'FRAUD_SUSPENSION' : (i % 2 === 0 ? 'SECP_LICENSE_EXPIRED' : 'DEBT_RECOVERY'),
    withholdingPercentage: i === 0 ? 100 : 50,
    targetAmount: i === 0 ? null : seeded(`hold:tgt:${p.id}`, 10000, 110000),
    accumulatedRecovered: i === 0 ? 0 : seeded(`hold:rec:${p.id}`, 1000, 11000),
    startDate: new Date(Date.now() - 1000000000).toISOString(),
    status: 'ACTIVE',
    authorizedBy: 'Compliance Officer (M. Arslan)',
    reasonNotes: i === 0 ? 'Pending investigation for mis-selling' : 'Standard debt recovery schedule'
  }));
  return holdbacksCache;
}

export async function listClawbacks(): Promise<ClawbackTransaction[]> {
  if (clawbacksCache) return clawbacksCache;
  const payees = await listPayees();
  clawbacksCache = Array.from({ length: 8 }).map((_, i) => {
    // Gross, tax and net were drawn independently, so net + tax never
    // reconciled to gross on any row. Derive the parts from the whole.
    const gross = seeded(`cb:gross:${i}`, 5000, 55000);
    const tax = Math.round(gross * 0.1);
    return {
      clawbackId: `CB-${seeded(`cb:id:${i}`, 10000, 99999)}`,
      policyNumber: `PL-DEMO-${seeded(`cb:pol:${i}`, 1000, 9999)}`,
      originalTransactionId: `TRX-${seeded(`cb:trx:${i}`, 10000, 99999)}`,
      payeeId: payees[i % payees.length].id,
      roleInHierarchy: i % 3 === 0 ? 'BRANCH_MANAGER' as const : 'PRODUCER' as const,
      clawbackTrigger: i % 4 === 0 ? 'FREE_LOOK_CANCELLATION' as const : 'EARLY_LAPSE' as const,
      grossClawbackAmount: gross,
      taxAdjustmentAmount: tax,
      netDebitAmount: gross - tax,
      recoveryStatus: i % 2 === 0 ? 'FULLY_RECOVERED' as const : 'CARRIED_FORWARD_DEBT' as const,
      createdAt: new Date(Date.now() - seeded(`cb:age:${i}`, 1, 120) * 86_400_000).toISOString()
    };
  });
  return clawbacksCache;
}

export async function listTaxProfiles(): Promise<PayeeTaxProfile[]> {
  if (taxProfilesCache) return taxProfilesCache;
  const payees = await listPayees();
  taxProfilesCache = payees.map((p) => {
    // Filer status comes from the payee registry rather than an index trick,
    // so this screen agrees with the Payees screen for the same person.
    // The CNIC/NTN is NEVER synthesised — it identifies a real taxpayer.
    const isFiler = p.taxFilerStatus === "FILER";
    return {
      payeeId: p.id,
      cnicOrNtn: p.taxId ?? null,
      fbrStatus: (isFiler ? 'ACTIVE_FILER' : 'NON_FILER') as 'ACTIVE_FILER' | 'NON_FILER',
      // s.233 Income Tax Ordinance: filer 10%, non-filer double.
      applicableWhtRate: isFiler ? 0.10 : 0.20,
      lastAtlSyncTimestamp: null,
      totalTaxWithheldYtd: Math.round(p.ytdCommission * (isFiler ? 0.10 : 0.20)),
    };
  });
  return taxProfilesCache;
}

export async function listSecpMetrics(): Promise<SecpRegulatoryMetric[]> {
  if (secpMetricsCache) return secpMetricsCache;
  // ILLUSTRATIVE FIGURES — not this insurer's actual book, and the statutory
  // cap ratios below (65% conventional, 60% takaful) are inherited numbers
  // that have NOT been confirmed against a published SECP circular. The
  // TAKAFUL_FAMILY row therefore reports a regulatory BREACH on invented
  // premium against an unverified cap. Do not put this in front of a
  // regulator, an auditor or a board pack until both sides are real:
  // premium/expense from the ledger, cap ratios from a cited source.
  secpMetricsCache = [
    {
      fiscalYear: '2026',
      productLine: 'CONVENTIONAL_INDIVIDUAL_LIFE',
      totalGrossPremiumCollected: 1500000000,
      totalDistributionExpense: 850000000,
      currentExpenseRatio: 56.67,
      secpStatutoryCapRatio: 65.00,
      variancePercentage: 8.33,
      complianceStatus: 'COMPLIANT'
    },
    {
      fiscalYear: '2026',
      productLine: 'BANCASSURANCE',
      totalGrossPremiumCollected: 5000000000,
      totalDistributionExpense: 3200000000,
      currentExpenseRatio: 64.00,
      secpStatutoryCapRatio: 65.00,
      variancePercentage: 1.00,
      complianceStatus: 'WARNING_85_PERCENT'
    },
    {
      fiscalYear: '2026',
      productLine: 'TAKAFUL_FAMILY',
      totalGrossPremiumCollected: 800000000,
      totalDistributionExpense: 490000000,
      currentExpenseRatio: 61.25,
      secpStatutoryCapRatio: 60.00,
      variancePercentage: -1.25,
      complianceStatus: 'BREACHED'
    }
  ];
  return secpMetricsCache;
}
