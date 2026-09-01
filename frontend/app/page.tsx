"use client";

import { useEffect, useState } from "react";
import { MetricCard } from "@/components/MetricCard";
import { UnderwritingCard } from "@/components/dashboard/UnderwritingCard";
import { FraudCard } from "@/components/dashboard/FraudCard";
import { ArtifactCard } from "@/components/dashboard/ArtifactCard";
import { ClaimsCard } from "@/components/dashboard/ClaimsCard";
import { CustomerCard } from "@/components/dashboard/CustomerCard";
import { AgentCard } from "@/components/dashboard/AgentCard";
import { FinancialCard } from "@/components/dashboard/FinancialCard";
import { InteractiveMapCard } from "@/components/dashboard/InteractiveMapCard";
import { TimeTrendChartCard } from "@/components/dashboard/TimeTrendChartCard";
import { PortfolioHealthCard } from "@/components/dashboard/PortfolioHealthCard";
import { DateRangeFilter, resolvePreset, type DatePreset, type DateRange } from "@/components/commissions/DateRangeFilter";
import { RegionFilter, ALL_REGIONS } from "@/components/RegionFilter";
import { listBranches, distinctRegions, resolvePayeeRegion, type Branch } from "@/app/services/branches";
import { listClaims, type Claim } from "@/app/services/claims";
import { listPolicies, getPolicyStats, type PolicyListItem, type PolicyStats } from "@/app/services/policies";
import {
  listPayees,
  listCommissionLedger,
  evaluateIncentives,
  type CommissionPayee,
  type CommissionLedgerEntry,
  type IncentiveQualification,
} from "@/app/services/commissions";

const REFRESH_INTERVAL_MS = 60_000;

function isToday(dateStr: string): boolean {
  return dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function inRange(dateStr: string, range: DateRange): boolean {
  if (!range.from || !range.to) return true;
  const d = dateStr.slice(0, 10);
  return d >= range.from && d <= range.to;
}

export default function DashboardPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [policyStats, setPolicyStats] = useState<PolicyStats | null>(null);
  const [payees, setPayees] = useState<CommissionPayee[]>([]);
  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const [dateRange, setDateRange] = useState<DateRange>(() => resolvePreset("30d"));
  const [regionFilter, setRegionFilter] = useState(ALL_REGIONS);

  const fetchAll = async () => {
    try {
      const tid = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
      const [claimsData, policiesData, statsData, payeesData, ledgerData, branchesData] = await Promise.all([
        listClaims(),
        listPolicies(),
        getPolicyStats().catch(() => null),
        listPayees().catch(() => []),
        listCommissionLedger().catch(() => []),
        tid ? listBranches(tid).catch(() => []) : Promise.resolve([]),
      ]);
      setClaims(claimsData);
      setPolicies(policiesData);
      setPolicyStats(statsData);
      setPayees(payeesData);
      setLedger(ledgerData);
      setBranches(branchesData);
      setLastRefreshed(new Date());
    } catch {
      /* keep whatever was last loaded rather than blanking the dashboard */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const regions = distinctRegions(branches);
  const payeeRegionById = new Map(payees.map((p: CommissionPayee) => [p.id, resolvePayeeRegion(p.branch, branches)]));

  const filteredClaims: Claim[] = claims.filter((c: Claim) => {
    if (!inRange(c.created_at, dateRange)) return false;
    if (regionFilter !== ALL_REGIONS && c.region !== regionFilter) return false;
    return true;
  });
  const filteredPolicies: PolicyListItem[] = policies.filter((p: PolicyListItem) => {
    if (!inRange(p.created_at, dateRange)) return false;
    if (regionFilter !== ALL_REGIONS && p.region !== regionFilter) return false;
    return true;
  });
  const filteredLedger: CommissionLedgerEntry[] = ledger.filter((entry: CommissionLedgerEntry) => {
    if (!inRange(entry.accruedAt, dateRange)) return false;
    if (regionFilter !== ALL_REGIONS && payeeRegionById.get(entry.payeeId) !== regionFilter) return false;
    return true;
  });
  const filteredQualifications: IncentiveQualification[] = evaluateIncentives(payees, filteredLedger);

  // ── Top-level executive KPIs — computed from filtered datasets ─────────────

  const casesToday =
    claims.filter((c) => isToday(c.created_at)).length + policies.filter((p) => isToday(p.created_at)).length;

  const terminalClaimStatuses = ["Approved", "Partial Approval", "Declined", "Settled", "Closed"];
  const openClaims = filteredClaims.filter((c) => !terminalClaimStatuses.includes(c.status));
  const avgOpenFraudProb =
    openClaims.length > 0 ? openClaims.reduce((s, c) => s + c.fraud_probability, 0) / openClaims.length : 0;
  const atRiskPolicyShare =
    policyStats && policyStats.total > 0 ? (policyStats.grace_period + policyStats.lapsed) / policyStats.total : 0;

  const portfolioRiskIndex = Math.round((avgOpenFraudProb * 0.6 + atRiskPolicyShare * 0.4) * 100);

  const premiumCollected = filteredLedger.reduce((sum, e) => sum + e.collectedPremium, 0);

  const fraudFlaggedOrDeclined = filteredClaims.filter(
    (c) => c.status === "Declined" || c.fraud_probability >= 0.7 || c.duplicate_flag
  );
  const fraudSavings = fraudFlaggedOrDeclined.reduce((sum, c) => sum + c.submitted_amount, 0);

  const fmtCompact = (v: number) =>
    v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `PKR ${(v / 1_000).toFixed(0)}K` : `PKR ${v.toFixed(0)}`;

  const KPIs = [
    {
      title: "Cases Evaluated Today",
      value: String(casesToday),
      subtitle: "new claims + policies ingested",
      accent: "blue" as const,
    },
    {
      title: "Portfolio Risk Index",
      value: `${portfolioRiskIndex} / 100`,
      subtitle: "fraud exposure + lapse risk",
      accent: "blue" as const,
    },
    {
      title: "Gross Premium (GWP)",
      value: fmtCompact(premiumCollected),
      subtitle: "collected in range",
      accent: "blue" as const,
    },
    {
      title: "Fraud Mitigation Exposure",
      value: fmtCompact(fraudSavings),
      subtitle: "flagged + declined claims",
      accent: "blue" as const,
    },
  ];

  return (
    <div className="px-6 py-6 space-y-6 max-w-screen-2xl mx-auto w-full">

      {/* ── Executive Navigation Header Bar ───────────────────────────────── */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Executive Insurance Command Center</h1>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Live AI Suite Active
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time Underwriting Governance, Financial Operations &amp; Geospatial Intelligence
          </p>
        </div>

        {/* Global Filter Bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <RegionFilter regions={regions} value={regionFilter} onChange={setRegionFilter} />
          <DateRangeFilter
            preset={datePreset}
            range={dateRange}
            onPresetChange={(p, r) => { setDatePreset(p); setDateRange(r); }}
            align="right"
          />
        </div>
      </div>

      {/* ── KPI Strip ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIs.map((k) => (
          <MetricCard
            key={k.title}
            title={k.title}
            value={loading ? "—" : k.value}
            subtitle={k.subtitle}
            accent={k.accent}
          />
        ))}
      </div>

      {/* ── SECTION 1: HERO ANALYTICS (Geospatial Map + Temporal Time Trend) ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6">
          <InteractiveMapCard
            policies={filteredPolicies}
            claims={filteredClaims}
            ledger={filteredLedger}
            selectedRegion={regionFilter}
            onSelectRegion={setRegionFilter}
          />
        </div>
        <div className="lg:col-span-6">
          <TimeTrendChartCard
            policies={filteredPolicies}
            claims={filteredClaims}
            ledger={filteredLedger}
          />
        </div>
      </div>

      {/* ── SECTION 2: PORTFOLIO HEALTH & FINANCIAL INTELLIGENCE ──────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6">
          <PortfolioHealthCard
            policies={filteredPolicies}
            claims={filteredClaims}
            ledger={filteredLedger}
            policyStats={policyStats}
          />
        </div>
        <div className="lg:col-span-6">
          <FinancialCard ledger={filteredLedger} claims={filteredClaims} />
        </div>
      </div>

      {/* ── SECTION 3: UNDERWRITING GOVERNANCE & AI FRAUD ENGINE ─────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7">
          <UnderwritingCard
            policies={filteredPolicies}
            claims={filteredClaims}
            policyStats={policyStats}
            riskIndex={portfolioRiskIndex}
          />
        </div>
        <div className="lg:col-span-5">
          <FraudCard claims={filteredClaims} />
        </div>
      </div>

      {/* ── SECTION 4: OPERATIONAL WORKBENCH (Claims, Documents, Customers) ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <ArtifactCard claims={filteredClaims} />
        <ClaimsCard claims={filteredClaims} />
        <CustomerCard policyStats={policyStats} policies={filteredPolicies} payees={payees} />
      </div>

      {/* ── SECTION 5: SALES FORCE & DISTRIBUTION CHANNEL INTELLIGENCE ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-1 gap-6">
        <AgentCard payees={payees} ledger={filteredLedger} qualifications={filteredQualifications} />
      </div>

      {/* ── Footer Disclaimer ─────────────────────────────────────────────── */}
      <p className="text-center text-[10px] text-slate-400 pb-2 leading-relaxed">
        Metrics are computed live from claims, policies and commission data for the selected filters.
        {lastRefreshed && ` Last refreshed ${lastRefreshed.toLocaleTimeString()} · refreshes every 60 seconds.`}
        &nbsp;·&nbsp; Model suite: <span className="font-mono">insurance-ai v0.1.0-proto</span>
        &nbsp;·&nbsp; Enterprise Command Center — Internal Use Only
      </p>

    </div>
  );
}
