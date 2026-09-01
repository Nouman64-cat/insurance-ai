"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listClaims,
  createClaim,
  Claim,
  CreateClaimRequest,
} from "@/app/services/claims";
import { listPolicies, PolicyListItem } from "@/app/services/policies";
import { listBranches, distinctRegions } from "@/app/services/branches";
import { DateRangeFilter, resolvePreset, type DatePreset, type DateRange } from "@/components/commissions/DateRangeFilter";
import { RegionFilter, ALL_REGIONS } from "@/components/RegionFilter";
import { FilterDropdown, type FilterOption } from "@/components/FilterDropdown";
import { InteractiveMapCard } from "@/components/dashboard/InteractiveMapCard";
import { TimeTrendChartCard } from "@/components/dashboard/TimeTrendChartCard";
import { listCommissionLedger, type CommissionLedgerEntry } from "@/app/services/commissions";

function RiskBadge({ prob, flag }: { prob: number; flag: boolean }) {
  if (flag) {
    return (
      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-purple-100 text-purple-700 border border-purple-200">
        DUPLICATE
      </span>
    );
  }
  if (prob >= 0.7) {
    return (
      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-100 text-rose-700 border border-rose-200">
        HIGH RISK ({(prob * 100).toFixed(0)}%)
      </span>
    );
  }
  if (prob >= 0.3) {
    return (
      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200">
        MEDIUM ({(prob * 100).toFixed(0)}%)
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200">
      LOW ({(prob * 100).toFixed(0)}%)
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    New: "bg-slate-100 text-slate-700 border-slate-200",
    Triaged: "bg-blue-50 text-blue-700 border-blue-200",
    "Under Investigation": "bg-amber-50 text-amber-700 border-amber-200",
    "Pending Documents": "bg-orange-50 text-orange-700 border-orange-200",
    Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    "Partial Approval": "bg-teal-50 text-teal-700 border-teal-200",
    Declined: "bg-rose-50 text-rose-700 border-rose-200",
    "Referred to Manager": "bg-purple-50 text-purple-700 border-purple-200",
    Settled: "bg-emerald-100 text-emerald-800 border-emerald-300",
    Closed: "bg-slate-200 text-slate-600 border-slate-300",
  };
  const cls = map[status] ?? "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cls}`}>
      {status}
    </span>
  );
}

const CLAIM_TYPE_OPTIONS: FilterOption[] = [
  { value: "ALL", label: "All Claim Types" },
  { value: "Hospitalization", label: "Hospitalization" },
  { value: "Surgery", label: "Surgery" },
  { value: "Death Claim", label: "Death Claim" },
  { value: "Reimbursement", label: "Reimbursement" },
];

const RISK_OPTIONS: FilterOption[] = [
  { value: "ALL", label: "All Risk Levels" },
  { value: "LOW", label: "Low Risk (< 30%)" },
  { value: "MEDIUM", label: "Medium Risk (30–69%)" },
  { value: "HIGH", label: "High Risk (≥ 70%)" },
  { value: "DUPLICATE", label: "Duplicate" },
];

function riskLevelOf(c: Claim): "LOW" | "MEDIUM" | "HIGH" | "DUPLICATE" {
  if (c.duplicate_flag) return "DUPLICATE";
  if (c.fraud_probability >= 0.7) return "HIGH";
  if (c.fraud_probability >= 0.3) return "MEDIUM";
  return "LOW";
}

export default function ClaimsDashboardPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [step, setStep] = useState(1);

  // ── Date Range Filter ─────────────────────────────────────────────────
  const [datePreset, setDatePreset] = useState<DatePreset>("ytd");
  const [dateRange, setDateRange] = useState<DateRange>(() => resolvePreset("ytd"));

  // ── Region / Claim Type / Risk Level Filters ────────────────────────────
  const [regions, setRegions] = useState<string[]>([]);
  const [regionFilter, setRegionFilter] = useState(ALL_REGIONS);
  const [claimTypeFilter, setClaimTypeFilter] = useState("ALL");
  const [riskFilter, setRiskFilter] = useState("ALL");

  // Filter claims by created_at (always populated); incident_date may be null.
  // Filters claims directly (rather than composing through filterLedgerByDate)
  // so every downstream computation keeps the full Claim type.
  const inSelectedDateRange = (dateStr: string): boolean => {
    if (!dateRange.from || !dateRange.to) return true;
    const d = dateStr.slice(0, 10);
    return d >= dateRange.from && d <= dateRange.to;
  };
  const filteredClaims: Claim[] = claims.filter((c: Claim) => {
    if (!inSelectedDateRange(c.created_at)) return false;
    if (regionFilter !== ALL_REGIONS && c.region !== regionFilter) return false;
    if (claimTypeFilter !== "ALL" && c.claim_type !== claimTypeFilter) return false;
    if (riskFilter !== "ALL" && riskLevelOf(c) !== riskFilter) return false;
    return true;
  });

  const [policySearch, setPolicySearch] = useState("");
  const [policyDropdownOpen, setPolicyDropdownOpen] = useState(false);
  const policyDropdownRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState<CreateClaimRequest>({
    policy_id: "",
    claim_type: "Hospitalization",
    submitted_amount: 50000,
    incident_date: new Date().toISOString().split("T")[0],
    notes: "",
  });

  useEffect(() => {
    if (!policyDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (policyDropdownRef.current && !policyDropdownRef.current.contains(e.target as Node)) {
        setPolicyDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [policyDropdownOpen]);

  const fetchData = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await listClaims();
      setClaims(data);
    } catch {
      setLoadError("Could not load claims. The data below may be incomplete or stale — try refreshing.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    listPolicies().then(setPolicies).catch(() => { });
    listCommissionLedger().then(setLedger).catch(() => { });
    const tid = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    if (tid) {
      listBranches(tid).then((b) => setRegions(distinctRegions(b))).catch(() => { });
    }
  }, []);

  const filteredPolicies = policies.filter((p) => {
    if (!policySearch.trim()) return true;
    const q = policySearch.toLowerCase();
    const num = (p.policy_number || p.id).toLowerCase();
    const name = (p.customer_name || "").toLowerCase();
    const prod = (p.product_name || "").toLowerCase();
    return num.includes(q) || name.includes(q) || prod.includes(q);
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.policy_id) {
      setErrorMsg("Please select a policy.");
      return;
    }
    setSubmitting(true);
    setErrorMsg("");
    try {
      const created = await createClaim(form);
      if (created?.id) {
        setHighlightId(created.id);
        setTimeout(() => {
          setHighlightId(null);
        }, 2500);
      }
      setShowModal(false);
      setStep(1);
      setForm({
        policy_id: "",
        claim_type: "Hospitalization",
        submitted_amount: 50000,
        incident_date: new Date().toISOString().split("T")[0],
        notes: "",
      });
      fetchData();
    } catch (err: any) {
      setErrorMsg(err?.response?.data?.detail ?? "Failed to create claim.");
    } finally {
      setSubmitting(false);
    }
  };

  // Metrics Calculations (all from filteredClaims)
  const totalClaimsCount = filteredClaims.length;
  const inProgressCount = filteredClaims.filter((c) =>
    ["New", "Triaged", "Under Investigation", "Pending Documents", "Referred to Manager"].includes(c.status)
  ).length;
  const totalApprovedSum = filteredClaims.reduce((acc, c) => acc + (c.approved_amount || 0), 0);
  const totalSubmittedSum = filteredClaims.reduce((acc, c) => acc + (c.submitted_amount || 0), 0);
  const highRiskCount = filteredClaims.filter((c) => c.fraud_probability >= 0.7 || c.duplicate_flag).length;
  const mediumRiskCount = filteredClaims.filter((c) => c.fraud_probability >= 0.3 && c.fraud_probability < 0.7 && !c.duplicate_flag).length;
  const lowRiskCount = filteredClaims.filter((c) => c.fraud_probability < 0.3 && !c.duplicate_flag).length;

  const approvedCount = filteredClaims.filter((c) => ["Approved", "Partial Approval", "Settled"].includes(c.status)).length;
  const closedCount = filteredClaims.filter((c) => ["Approved", "Partial Approval", "Declined", "Settled", "Closed"].includes(c.status)).length;
  const approvalRate = closedCount > 0 ? ((approvedCount / closedCount) * 100).toFixed(1) : null;

  // ── SLA & Workload metrics — computed from real claim timestamps ────────
  const terminalStatuses = ["Approved", "Partial Approval", "Declined", "Settled", "Closed"];
  const resolvedClaims = filteredClaims.filter(
    (c) => terminalStatuses.includes(c.status) && (c.settled_at || c.closed_at)
  );
  const avgAdjudicationHours =
    resolvedClaims.length > 0
      ? resolvedClaims.reduce((sum, c) => {
          const end = new Date((c.settled_at || c.closed_at) as string).getTime();
          const start = new Date(c.created_at).getTime();
          return sum + Math.max(0, end - start) / 3_600_000;
        }, 0) / resolvedClaims.length
      : null;
  const investigatedStatuses = ["Under Investigation", "Referred to Manager", "Pending Documents"];
  const autoTriagedCount = filteredClaims.filter(
    (c) =>
      terminalStatuses.includes(c.status) &&
      !(c.status_history || []).some((h) => investigatedStatuses.includes(h.to_status))
  ).length;
  const autoTriageRate = closedCount > 0 ? (autoTriagedCount / closedCount) * 100 : null;
  const reinsuranceFlaggedCount = filteredClaims.filter((c) => !!c.reinsurance_referral_id).length;
  const reinsuranceFlagRate = totalClaimsCount > 0 ? (reinsuranceFlaggedCount / totalClaimsCount) * 100 : null;
  const SLA_TARGET_HOURS = 24;
  const withinSlaCount = resolvedClaims.filter((c) => {
    const end = new Date((c.settled_at || c.closed_at) as string).getTime();
    const start = new Date(c.created_at).getTime();
    return (end - start) / 3_600_000 <= SLA_TARGET_HOURS;
  }).length;
  const slaCompliancePct = resolvedClaims.length > 0 ? (withinSlaCount / resolvedClaims.length) * 100 : null;

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  filteredClaims.forEach((c) => {
    statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
  });

  // Type breakdown
  const typeCounts: Record<string, number> = {};
  filteredClaims.forEach((c) => {
    typeCounts[c.claim_type] = (typeCounts[c.claim_type] || 0) + 1;
  });

  const selectedPolicy = policies.find((p) => p.id === form.policy_id);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 font-sans">
      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 uppercase tracking-wider mb-1">
            <span>Insurance Operations</span>
            <span>/</span>
            <span>Claims Management</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Claims Analytics & Dashboard</h1>
          {/* <p className="text-xs text-slate-500 mt-1">
            Real-time portfolio metrics, AI risk exposure, and adjuster workflow throughput.
          </p> */}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Region Filter */}
          <RegionFilter regions={regions} value={regionFilter} onChange={setRegionFilter} />
          {/* Claim Type Filter */}
          <FilterDropdown value={claimTypeFilter} options={CLAIM_TYPE_OPTIONS} onChange={setClaimTypeFilter} />
          {/* Risk Level Filter */}
          <FilterDropdown value={riskFilter} options={RISK_OPTIONS} onChange={setRiskFilter} />
          {/* Date Range Filter */}
          <DateRangeFilter
            preset={datePreset}
            range={dateRange}
            onPresetChange={(p, r) => { setDatePreset(p); setDateRange(r); }}
            align="right"
          />
          <Link
            href="/claims/register"
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 transition-all shadow-2xs flex items-center gap-2"
          >
            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
            <span>Claims Register</span>
          </Link>

          {/* <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-all shadow-xs flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>File FNOL Claim</span>
          </button> */}
        </div>
      </div>

      {loadError && (
        <div className="px-4 py-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <button onClick={fetchData} className="px-2.5 py-1 rounded-md bg-rose-600 text-white text-[11px] font-bold hover:bg-rose-700 shrink-0">
            Retry
          </button>
        </div>
      )}

        {/* Primary KPI Stats Grid */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Showing</span>
          <span className="px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-[10px] font-bold">
            {dateRange.from} – {dateRange.to}
          </span>
          <span className="text-[10px] text-slate-400">{filteredClaims.length} claims</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-2 relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Total Claims Volume</span>
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-slate-900">{loading ? "—" : totalClaimsCount}</div>
          <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100 text-slate-500">
            <span>Submitted Value:</span>
            <span className="font-semibold text-slate-800">PKR {(totalSubmittedSum / 1000000).toFixed(2)}M</span>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-2 relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">In Progress Queue</span>
            <div className="p-2 rounded-lg bg-amber-50 text-amber-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-slate-900">{loading ? "—" : inProgressCount}</div>
          <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100 text-slate-500">
            <span>Awaiting Action:</span>
            <span className="font-semibold text-amber-700">Triage & Investigation</span>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-2 relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Approved Value</span>
            <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-slate-900">
            PKR {loading ? "—" : (totalApprovedSum / 1000000).toFixed(2)}M
          </div>
          <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100 text-slate-500">
            <span>Approval Rate:</span>
            <span className="font-semibold text-emerald-700">{approvalRate !== null ? `${approvalRate}%` : "—"}</span>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-2 relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">AI Risk Flagged</span>
            <div className="p-2 rounded-lg bg-rose-50 text-rose-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-slate-900">{loading ? "—" : highRiskCount}</div>
          <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100 text-slate-500">
            <span>Fraud Probability:</span>
            <span className="font-semibold text-rose-700">&gt; 70% or Duplicate</span>
          </div>
        </div>
      </div>

      {/* ── HERO VISUAL ANALYTICS: Regional Map & Claims Temporal Trend ─────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6">
          <InteractiveMapCard
            policies={policies}
            claims={filteredClaims}
            ledger={ledger}
            selectedRegion={regionFilter}
            onSelectRegion={setRegionFilter}
          />
        </div>
        <div className="lg:col-span-6">
          <TimeTrendChartCard
            policies={policies}
            claims={filteredClaims}
            ledger={ledger}
          />
        </div>
      </div>

      {/* Analytics Breakdown Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Status Distribution */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900">Claim Status Distribution</h3>
            <span className="text-xs font-semibold text-slate-400">Total: {totalClaimsCount}</span>
          </div>

          <div className="space-y-3 text-xs">
            {[
              { label: "New & Triaged", count: (statusCounts["New"] || 0) + (statusCounts["Triaged"] || 0), color: "bg-blue-500" },
              { label: "Under Investigation", count: statusCounts["Under Investigation"] || 0, color: "bg-amber-500" },
              { label: "Pending Documents", count: statusCounts["Pending Documents"] || 0, color: "bg-orange-400" },
              { label: "Approved & Settled", count: (statusCounts["Approved"] || 0) + (statusCounts["Settled"] || 0) + (statusCounts["Partial Approval"] || 0), color: "bg-emerald-500" },
              { label: "Declined", count: statusCounts["Declined"] || 0, color: "bg-rose-500" },
              { label: "Referred to Manager", count: statusCounts["Referred to Manager"] || 0, color: "bg-purple-500" },
            ].map((st) => {
              const pct = totalClaimsCount > 0 ? (st.count / totalClaimsCount) * 100 : 0;
              return (
                <div key={st.label} className="space-y-1">
                  <div className="flex justify-between font-medium text-slate-700">
                    <span>{st.label}</span>
                    <span className="font-bold text-slate-900">{st.count} ({pct.toFixed(0)}%)</span>
                  </div>
                  <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full ${st.color} rounded-full`} style={{ width: `${pct}%` }}></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* AI Fraud & Risk Breakdown */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900">AI Risk & Fraud Exposure</h3>
            <span className="text-xs font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-md">Live AI Monitor</span>
          </div>

          <div className="space-y-4 text-xs">
            <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-lg flex items-center justify-between">
              <div>
                <div className="font-bold text-slate-800">Low Risk (&lt; 30%)</div>
                <div className="text-[11px] text-slate-500">Auto-triage eligible claims</div>
              </div>
              <div className="text-lg font-extrabold text-emerald-600">{lowRiskCount}</div>
            </div>

            <div className="p-3 bg-amber-50/60 border border-amber-200/80 rounded-lg flex items-center justify-between">
              <div>
                <div className="font-bold text-amber-900">Medium Risk (30% - 69%)</div>
                <div className="text-[11px] text-amber-700">Requires manual document review</div>
              </div>
              <div className="text-lg font-extrabold text-amber-600">{mediumRiskCount}</div>
            </div>

            <div className="p-3 bg-rose-50/60 border border-rose-200/80 rounded-lg flex items-center justify-between">
              <div>
                <div className="font-bold text-rose-900">High Risk (&ge; 70%) / Duplicate</div>
                <div className="text-[11px] text-rose-700">Escalated for SIU fraud audit</div>
              </div>
              <div className="text-lg font-extrabold text-rose-600">{highRiskCount}</div>
            </div>
          </div>
        </div>

        {/* Claim Type Portfolio */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900">Claim Type Distribution</h3>
            <span className="text-xs font-semibold text-slate-400">By Product</span>
          </div>

          <div className="space-y-3 text-xs">
            {Object.keys(typeCounts).length === 0 ? (
              <div className="text-slate-400 text-center py-6">No claim type data available</div>
            ) : (
              Object.entries(typeCounts).map(([type, count]) => {
                const pct = totalClaimsCount > 0 ? (count / totalClaimsCount) * 100 : 0;
                return (
                  <div key={type} className="p-3 bg-slate-50 border border-slate-100 rounded-lg space-y-1.5">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-slate-800">{type}</span>
                      <span className="font-extrabold text-slate-900">{count} claims</span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-slate-900 rounded-full" style={{ width: `${pct}%` }}></div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Triage Priority Queue (Recent Claims Table Preview) */}
      {/* Executive Operational Intelligence Section (Replaces table) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* High-Priority SIU & AI Risk Watchlist */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">SIU Fraud Watchlist & AI Risk Flags</h3>
              <p className="text-xs text-slate-500">Claims automatically flagged for potential duplicate filing or high risk anomaly.</p>
            </div>
            <Link
              href="/claims/register"
              className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
            >
              <span>Claims Register &rarr;</span>
            </Link>
          </div>

          <div className="space-y-3">
            {filteredClaims.filter((c) => c.fraud_probability >= 0.3 || c.duplicate_flag).length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                No high risk or duplicate claims detected in the active queue.
              </div>
            ) : (
              filteredClaims
                .filter((c) => c.fraud_probability >= 0.3 || c.duplicate_flag)
                .slice(0, 5)
                .map((c) => (
                  <div
                    key={c.id}
                    className={`p-3.5 rounded-lg border transition-colors duration-1000 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs ${
                      highlightId === c.id || highlightId === c.claim_number
                        ? "bg-blue-100/90 border-blue-300 shadow-sm"
                        : "border-slate-200 bg-slate-50/50 hover:bg-slate-50"
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">{c.claim_number}</span>
                        <span className="text-slate-400">•</span>
                        <span className="font-semibold text-slate-700">
                          {c.customer_name || c.claimant_name || "—"}
                          {c.claimant_name && c.customer_name && c.claimant_name !== c.customer_name && (
                            <span className="text-slate-500 font-normal"> / {c.claimant_name} (Claimant)</span>
                          )}
                        </span>
                        <RiskBadge prob={c.fraud_probability} flag={c.duplicate_flag} />
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-3">
                        <span>Type: <strong>{c.claim_type}</strong></span>
                        <span>Incident: <strong>{c.incident_date ?? "N/A"}</strong></span>
                        <span>Claimed: <strong>PKR {c.submitted_amount.toLocaleString()}</strong></span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <StatusBadge status={c.status} />
                      <Link
                        href={`/claims/${c.id}`}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-bold text-[11px] hover:bg-blue-700 transition-colors whitespace-nowrap flex items-center gap-1.5 shadow-xs"
                      >
                        Review Claim
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </Link>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>

        {/* Operational SLA & Throughput Benchmarks */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 space-y-4">
          <div className="border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">SLA & Workload Performance</h3>
            <p className="text-xs text-slate-500">Adjudication throughput & operational benchmarks.</p>
          </div>

          <div className="space-y-4 text-xs">
            <div className="p-3.5 bg-blue-50/50 border border-blue-100 rounded-lg space-y-2">
              <div className="flex justify-between font-semibold text-slate-800">
                <span>Avg Adjudication Time</span>
                <span className="text-blue-700 font-bold">
                  {avgAdjudicationHours !== null
                    ? avgAdjudicationHours >= 48
                      ? `${(avgAdjudicationHours / 24).toFixed(1)} Days`
                      : `${avgAdjudicationHours.toFixed(1)} Hours`
                    : "—"}
                </span>
              </div>
              <div className="text-[11px] text-slate-500">
                Target SLA: &lt; {SLA_TARGET_HOURS}.0 Hours
                {slaCompliancePct !== null ? ` (${slaCompliancePct.toFixed(0)}% compliant)` : " (no resolved claims yet)"}
              </div>
              <div className="h-1.5 w-full bg-blue-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 rounded-full" style={{ width: `${slaCompliancePct ?? 0}%` }}></div>
              </div>
            </div>

            <div className="p-3.5 bg-emerald-50/50 border border-emerald-100 rounded-lg space-y-2">
              <div className="flex justify-between font-semibold text-slate-800">
                <span>Auto-Triage Rate</span>
                <span className="text-emerald-700 font-bold">{autoTriageRate !== null ? `${autoTriageRate.toFixed(1)}%` : "—"}</span>
              </div>
              <div className="text-[11px] text-slate-500">Resolved claims that never hit manual investigation</div>
              <div className="h-1.5 w-full bg-emerald-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-600 rounded-full" style={{ width: `${autoTriageRate ?? 0}%` }}></div>
              </div>
            </div>

            <div className="p-3.5 bg-purple-50/50 border border-purple-100 rounded-lg space-y-2">
              <div className="flex justify-between font-semibold text-slate-800">
                <span>Reinsurance Treaty Flag Rate</span>
                <span className="text-purple-700 font-bold">{reinsuranceFlagRate !== null ? `${reinsuranceFlagRate.toFixed(1)}%` : "—"}</span>
              </div>
              <div className="text-[11px] text-slate-500">Escalated to facultative reinsurance desk</div>
              <div className="h-1.5 w-full bg-purple-100 rounded-full overflow-hidden">
                <div className="h-full bg-purple-600 rounded-full" style={{ width: `${reinsuranceFlagRate ?? 0}%` }}></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl max-h-[90vh] flex flex-col relative my-auto">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/90 rounded-t-2xl shrink-0">
              <div>
                <h3 className="text-sm font-bold text-slate-900">File First Notice of Loss (FNOL)</h3>
                <p className="text-[11px] text-slate-500">Step {step} of 2 — {step === 1 ? "Select Policy" : "Claim Details"}</p>
              </div>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 text-lg font-bold">&times;</button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-4 text-xs overflow-y-auto flex-1">
              {errorMsg && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-xs font-medium">
                  {errorMsg}
                </div>
              )}

              {step === 1 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider">
                      Select Policy ({policies.length} Available)
                    </label>
                    {selectedPolicy && (
                      <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-md border border-emerald-200/80">
                        Selected: {selectedPolicy.customer_name}
                      </span>
                    )}
                  </div>

                  {/* Direct Search Bar Pinned at Top of Modal */}
                  <div className="relative">
                    <input
                      type="text"
                      autoFocus
                      placeholder="Type customer name, policy #, or product to filter..."
                      value={policySearch}
                      onChange={(e) => setPolicySearch(e.target.value)}
                      className="w-full text-xs px-3.5 py-2.5 pl-9 pr-8 rounded-xl border border-slate-200 focus:outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 bg-white font-medium text-slate-800 placeholder-slate-400 shadow-2xs"
                    />
                    <svg className="w-4 h-4 text-slate-400 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    {policySearch && (
                      <button
                        type="button"
                        onClick={() => setPolicySearch("")}
                        className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 text-xs font-bold w-4 h-4 flex items-center justify-center rounded-full hover:bg-slate-100"
                      >
                        &times;
                      </button>
                    )}
                  </div>

                  {/* Scrollable Policy List positioned higher up — displays 6-8 records at first glance */}
                  <div className="max-h-72 sm:max-h-80 overflow-y-auto divide-y divide-slate-100 border border-slate-200/90 rounded-xl bg-white shadow-2xs">
                    {filteredPolicies.length === 0 ? (
                      <div className="p-6 text-center text-slate-400 text-xs font-medium">
                        No policies found matching &quot;{policySearch}&quot;
                      </div>
                    ) : (
                      filteredPolicies.map((p) => {
                        const isSelected = form.policy_id === p.id;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setForm({ ...form, policy_id: p.id });
                            }}
                            className={`w-full text-left px-3.5 py-2.5 text-xs transition-colors flex items-center justify-between ${
                              isSelected ? "bg-blue-50/90 text-blue-800 font-semibold" : "hover:bg-slate-50 text-slate-700"
                            }`}
                          >
                            <div className="flex flex-col min-w-0 pr-2 space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-slate-900">{p.customer_name}</span>
                                <span className="font-mono text-slate-400 text-[11px]">({p.policy_number ?? p.id.slice(0, 8)})</span>
                              </div>
                              <span className="text-[10px] text-slate-500 truncate">
                                {p.product_name}
                              </span>
                            </div>
                            {isSelected ? (
                              <span className="px-2.5 py-1 rounded-md text-[10px] font-bold bg-blue-600 text-white shrink-0 shadow-2xs">
                                Selected ✓
                              </span>
                            ) : (
                              <span className="text-[11px] text-slate-400 font-medium shrink-0">
                                Select &rarr;
                              </span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>

                  <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => setShowModal(false)}
                      className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!form.policy_id) {
                          setErrorMsg("Please select a policy first.");
                          return;
                        }
                        setErrorMsg("");
                        setStep(2);
                      }}
                      className="px-4 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
                    >
                      Next Step &rarr;
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-3">
                  {/* Distinct Policy Banner */}
                  <div className="p-4 bg-gradient-to-r from-blue-100/70 to-blue-50/40 border border-blue-200/80 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs shadow-sm relative overflow-hidden">
                    <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-600" />
                    
                    <div className="space-y-1.5 min-w-0 pl-2">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="font-extrabold text-blue-950 text-[14px] tracking-tight drop-shadow-xs">{selectedPolicy?.customer_name}</span>
                        <span className="font-bold text-blue-800 bg-white px-2.5 py-0.5 rounded-md border border-blue-200/80 shadow-2xs">
                          {selectedPolicy?.product_name}
                        </span>
                        {selectedPolicy?.insurance_type && (
                          <span className="text-[10px] font-extrabold text-blue-600/80 uppercase tracking-widest">
                            {selectedPolicy.insurance_type}
                          </span>
                        )}
                      </div>
                      <div className="text-[11.5px] text-blue-900/80 flex items-center gap-2.5 flex-wrap">
                        <span>Policy #: <strong className="font-mono font-bold text-blue-950">{selectedPolicy?.policy_number || selectedPolicy?.id.slice(0, 8)}</strong></span>
                        <span className="text-blue-300">•</span>
                        <span>Coverage Limit: <strong className="font-bold text-blue-950">PKR {(selectedPolicy?.coverage_amount || 0).toLocaleString()}</strong></span>
                      </div>
                    </div>

                    <div className="shrink-0">
                      <span className="px-3 py-1.5 rounded-lg text-[10px] font-extrabold bg-emerald-500 text-white shadow-xs flex items-center gap-1.5 uppercase tracking-widest">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Verified
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Claim Type</label>
                      <select
                        value={form.claim_type}
                        onChange={(e) => setForm({ ...form, claim_type: e.target.value })}
                        className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white font-semibold text-slate-800"
                      >
                        <option value="Hospitalization">Hospitalization</option>
                        <option value="Surgery">Surgery</option>
                        <option value="Death Claim">Death Claim</option>
                        <option value="Reimbursement">Reimbursement</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Submitted Amount (PKR)</label>
                      <input
                        type="number"
                        min="1000"
                        step="1000"
                        required
                        value={form.submitted_amount}
                        onChange={(e) => setForm({ ...form, submitted_amount: parseFloat(e.target.value) || 0 })}
                        className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 font-semibold"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Incident Date</label>
                    <input
                      type="date"
                      value={form.incident_date}
                      onChange={(e) => setForm({ ...form, incident_date: e.target.value })}
                      className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Description / Notes <span className="text-[10px] font-normal text-slate-400">(Optional)</span>
                    </label>
                    <textarea
                      rows={3}
                      placeholder="Describe the claim event (optional)..."
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      className="w-full text-xs p-2 rounded-lg border border-slate-200 bg-white"
                    />
                  </div>

                  <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
                    >
                      {submitting ? "Submitting..." : "Submit Claim"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
