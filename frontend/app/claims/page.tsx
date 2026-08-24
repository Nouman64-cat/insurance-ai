"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listClaims, createClaim, Claim, CreateClaimRequest } from "@/app/services/claims";
import { listPolicies, PolicyListItem } from "@/app/services/policies";

const STATUS_STYLE: Record<string, string> = {
  "New": "bg-slate-100 text-slate-700",
  "Triaged": "bg-blue-50 text-blue-800",
  "Under Investigation": "bg-amber-50 text-amber-800",
  "Pending Documents": "bg-orange-50 text-orange-800",
  "Approved": "bg-emerald-50 text-emerald-800",
  "Partial Approval": "bg-teal-50 text-teal-800",
  "Declined": "bg-rose-50 text-rose-800",
  "Referred to Manager": "bg-purple-50 text-purple-800",
  "Settled": "bg-slate-100 text-slate-800",
  "Closed": "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium ${style}`}>
      {status}
    </span>
  );
}

function RiskBadge({ prob, flag }: { prob: number; flag: boolean }) {
  const pct = Math.round(prob * 100);
  if (flag) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700">Duplicate</span>;
  }
  if (pct >= 70) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700">High ({pct}%)</span>;
  }
  if (pct >= 30) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700">Medium ({pct}%)</span>;
  }
  return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700">Low ({pct}%)</span>;
}

export default function ClaimsPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [riskFilter, setRiskFilter] = useState("ALL");
  const [amountFilter, setAmountFilter] = useState("ALL");
  const [datePreset, setDatePreset] = useState("ALL");
  const [dateField, setDateField] = useState("incident_date");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [search, setSearch] = useState("");
  const [showAdvancedDate, setShowAdvancedDate] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [step, setStep] = useState(1);
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
    try {
      let min_amount: number | undefined;
      let max_amount: number | undefined;
      if (amountFilter === "UNDER_50K") { max_amount = 50000; }
      else if (amountFilter === "50K_200K") { min_amount = 50000; max_amount = 200000; }
      else if (amountFilter === "OVER_200K") { min_amount = 200000; }

      const data = await listClaims({
        status: statusFilter !== "ALL" ? statusFilter : undefined,
        claim_type: typeFilter !== "ALL" ? typeFilter : undefined,
        risk_level: riskFilter !== "ALL" ? riskFilter : undefined,
        min_amount,
        max_amount,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        date_field: dateField,
        search: search.trim() || undefined,
      });
      setClaims(data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [statusFilter, typeFilter, riskFilter, amountFilter, datePreset, startDate, endDate, dateField]);

  useEffect(() => { listPolicies().then(setPolicies).catch(() => { }); }, []);

  const filteredPolicies = policies.filter((p) => {
    if (!policySearch.trim()) return true;
    const q = policySearch.toLowerCase();
    const num = (p.policy_number || p.id).toLowerCase();
    const name = (p.customer_name || "").toLowerCase();
    const prod = (p.product_name || "").toLowerCase();
    return num.includes(q) || name.includes(q) || prod.includes(q);
  });

  const handlePresetChange = (preset: string) => {
    setDatePreset(preset);
    const today = new Date();
    if (preset === "ALL") {
      setStartDate("");
      setEndDate("");
    } else if (preset === "TODAY") {
      const dStr = today.toISOString().split("T")[0];
      setStartDate(dStr);
      setEndDate(dStr);
    } else if (preset === "7DAYS") {
      const past = new Date(today);
      past.setDate(past.getDate() - 7);
      setStartDate(past.toISOString().split("T")[0]);
      setEndDate(today.toISOString().split("T")[0]);
    } else if (preset === "30DAYS") {
      const past = new Date(today);
      past.setDate(past.getDate() - 30);
      setStartDate(past.toISOString().split("T")[0]);
      setEndDate(today.toISOString().split("T")[0]);
    } else if (preset === "THIS_MONTH") {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      setStartDate(firstDay.toISOString().split("T")[0]);
      setEndDate(today.toISOString().split("T")[0]);
    } else if (preset === "CUSTOM") {
      setShowAdvancedDate(true);
    }
  };

  const handleResetFilters = () => {
    setStatusFilter("ALL");
    setTypeFilter("ALL");
    setRiskFilter("ALL");
    setAmountFilter("ALL");
    setDatePreset("ALL");
    setDateField("incident_date");
    setStartDate("");
    setEndDate("");
    setSearch("");
    setShowAdvancedDate(false);
  };

  const isFiltered =
    statusFilter !== "ALL" ||
    typeFilter !== "ALL" ||
    riskFilter !== "ALL" ||
    amountFilter !== "ALL" ||
    datePreset !== "ALL" ||
    startDate !== "" ||
    endDate !== "" ||
    search.trim() !== "";

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.policy_id) { setErrorMsg("Please select an active policy."); return; }
    setSubmitting(true); setErrorMsg("");
    try {
      await createClaim(form);
      setShowModal(false); setStep(1);
      setForm({ policy_id: "", claim_type: "Hospitalization", submitted_amount: 50000, incident_date: new Date().toISOString().split("T")[0], notes: "" });
      fetchData();
    } catch (err: any) {
      setErrorMsg(err.response?.data?.detail || "Failed to submit claim FNOL.");
    } finally { setSubmitting(false); }
  };

  const openModal = () => { setShowModal(true); setStep(1); setErrorMsg(""); };

  // KPIs
  const total = claims.length;
  const inProgress = claims.filter(c => ["New", "Triaged", "Under Investigation", "Pending Documents"].includes(c.status)).length;
  const totalApproved = claims.filter(c => ["Approved", "Partial Approval", "Settled"].includes(c.status)).reduce((s, c) => s + (c.approved_amount || 0), 0);
  const highRisk = claims.filter(c => c.fraud_probability >= 0.5 || c.duplicate_flag).length;

  const selectedPolicy = policies.find(p => p.id === form.policy_id);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 uppercase tracking-wider mb-1">
            <span>Insurance Operations</span>
            <span>/</span>
            <span>Claims Management</span>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Claims Register & Triage Workbench</h1>
          {/* <p className="text-xs text-slate-500 mt-1">
            Search, filter, and triage claim intake records, rules-engine adjudications, and payout statuses.
          </p> */}
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/claims/dashboard"
            className="text-xs font-semibold px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs flex items-center gap-1.5"
          >
            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span>Claims Dashboard</span>
          </Link>

          <button
            onClick={openModal}
            className="text-xs font-semibold px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg shadow-xs transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>File New Claim</span>
          </button>
        </div>
      </div>

      {/* Register & Filters Card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 bg-slate-50/50 space-y-3">
          {/* Primary Filter Control Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Search Input */}
            <div className="flex items-center gap-2 flex-1 min-w-[260px] max-w-md">
              <div className="relative w-full">
                <input
                  type="text"
                  placeholder="Search Claim #, Policy #, or Claimant..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && fetchData()}
                  className="w-full h-9 text-xs pl-9 pr-8 rounded-lg border border-slate-200 bg-white focus:outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 shadow-2xs text-slate-800 placeholder-slate-400 transition-all"
                />
                <svg className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 text-xs font-bold"
                  >
                    &times;
                  </button>
                )}
              </div>
            </div>

            {/* Filter Dropdowns & Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Date Preset */}
              <select
                value={datePreset}
                onChange={e => handlePresetChange(e.target.value)}
                className="h-9 text-xs px-3 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900/5 hover:border-slate-300 transition-all shadow-2xs cursor-pointer"
              >
                <option value="ALL">Incident Date: All Time</option>
                <option value="TODAY">Today</option>
                <option value="7DAYS">Last 7 Days</option>
                <option value="30DAYS">Last 30 Days</option>
                <option value="THIS_MONTH">This Month</option>
                <option value="CUSTOM">Custom Range...</option>
              </select>

              {/* Status */}
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="h-9 text-xs px-3 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900/5 hover:border-slate-300 transition-all shadow-2xs cursor-pointer"
              >
                <option value="ALL">All Statuses</option>
                <option value="New">New</option>
                <option value="Triaged">Triaged</option>
                <option value="Under Investigation">Under Investigation</option>
                <option value="Pending Documents">Pending Documents</option>
                <option value="Approved">Approved</option>
                <option value="Partial Approval">Partial Approval</option>
                <option value="Declined">Declined</option>
                <option value="Referred to Manager">Referred to Manager</option>
                <option value="Settled">Settled</option>
                <option value="Closed">Closed</option>
              </select>

              {/* Type */}
              <select
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value)}
                className="h-9 text-xs px-3 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900/5 hover:border-slate-300 transition-all shadow-2xs cursor-pointer"
              >
                <option value="ALL">All Claim Types</option>
                <option value="Hospitalization">Hospitalization</option>
                <option value="Surgery">Surgery</option>
                <option value="Death Claim">Death Claim</option>
                <option value="Reimbursement">Reimbursement</option>
              </select>

              {/* Risk Level */}
              <select
                value={riskFilter}
                onChange={e => setRiskFilter(e.target.value)}
                className="h-9 text-xs px-3 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900/5 hover:border-slate-300 transition-all shadow-2xs cursor-pointer"
              >
                <option value="ALL">All Risk Levels</option>
                <option value="LOW">Low Risk (&lt;30%)</option>
                <option value="MEDIUM">Medium Risk (30–69%)</option>
                <option value="HIGH">High Risk (70%+)</option>
                <option value="DUPLICATE">Duplicate Flagged</option>
              </select>

              {/* Amount Range */}
              <select
                value={amountFilter}
                onChange={e => setAmountFilter(e.target.value)}
                className="h-9 text-xs px-3 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900/5 hover:border-slate-300 transition-all shadow-2xs cursor-pointer"
              >
                <option value="ALL">All Amounts</option>
                <option value="UNDER_50K">&lt; PKR 50,000</option>
                <option value="50K_200K">PKR 50k – 200k</option>
                <option value="OVER_200K">&gt; PKR 200,000</option>
              </select>

              {/* Custom Date Range Toggle */}
              <button
                type="button"
                onClick={() => setShowAdvancedDate(!showAdvancedDate)}
                className={`h-9 text-xs px-3 rounded-lg border transition-all flex items-center gap-1.5 font-medium cursor-pointer shadow-2xs ${showAdvancedDate || startDate || endDate
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                  }`}
              >
                <svg className="w-3.5 h-3.5 text-current" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Custom Date</span>
                {(startDate || endDate) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
                )}
              </button>

              <button
                onClick={fetchData}
                className="h-9 text-xs font-semibold px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition-all shadow-xs flex items-center gap-1.5 cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span>Search</span>
              </button>
            </div>
          </div>

          {/* Custom Date Range Panel */}
          {(showAdvancedDate || datePreset === "CUSTOM" || startDate || endDate) && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs bg-slate-50/80 p-3 rounded-lg border border-slate-200/80">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-1.5 text-slate-700 font-semibold">
                  <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span>Incident Date Range:</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-medium">From</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => {
                      setStartDate(e.target.value);
                      if (datePreset !== "CUSTOM") setDatePreset("CUSTOM");
                    }}
                    className="h-8 text-xs px-2.5 rounded-md border border-slate-200 bg-white font-medium text-slate-800 shadow-2xs focus:outline-none focus:border-slate-400"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-medium">To</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={e => {
                      setEndDate(e.target.value);
                      if (datePreset !== "CUSTOM") setDatePreset("CUSTOM");
                    }}
                    className="h-8 text-xs px-2.5 rounded-md border border-slate-200 bg-white font-medium text-slate-800 shadow-2xs focus:outline-none focus:border-slate-400"
                  />
                </div>
              </div>

              {(startDate || endDate) && (
                <button
                  type="button"
                  onClick={() => {
                    setStartDate("");
                    setEndDate("");
                    setDatePreset("ALL");
                  }}
                  className="text-xs font-semibold text-rose-600 hover:text-rose-800 hover:underline flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Clear Date Filter
                </button>
              )}
            </div>
          )}

          {/* Active Filter Badges */}
          {isFiltered && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/60">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-slate-400 font-medium mr-1 flex items-center gap-1 text-[11px]">
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  Active Filters:
                </span>
                {search && (
                  <span className="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium flex items-center gap-1.5 border border-slate-200 text-[11px] shadow-2xs">
                    Search: "{search}"
                    <button onClick={() => setSearch("")} className="text-slate-400 hover:text-slate-700 font-bold">&times;</button>
                  </span>
                )}
                {statusFilter !== "ALL" && (
                  <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 font-medium flex items-center gap-1.5 border border-blue-200/80 text-[11px] shadow-2xs">
                    Status: {statusFilter}
                    <button onClick={() => setStatusFilter("ALL")} className="text-blue-400 hover:text-blue-700 font-bold">&times;</button>
                  </span>
                )}
                {typeFilter !== "ALL" && (
                  <span className="px-2.5 py-0.5 rounded-full bg-purple-50 text-purple-700 font-medium flex items-center gap-1.5 border border-purple-200/80 text-[11px] shadow-2xs">
                    Type: {typeFilter}
                    <button onClick={() => setTypeFilter("ALL")} className="text-purple-400 hover:text-purple-700 font-bold">&times;</button>
                  </span>
                )}
                {riskFilter !== "ALL" && (
                  <span className="px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-800 font-medium flex items-center gap-1.5 border border-amber-200/80 text-[11px] shadow-2xs">
                    Risk: {riskFilter === "LOW" ? "Low (<30%)" : riskFilter === "MEDIUM" ? "Medium (30-69%)" : riskFilter === "HIGH" ? "High (70%+)" : "Duplicate"}
                    <button onClick={() => setRiskFilter("ALL")} className="text-amber-500 hover:text-amber-800 font-bold">&times;</button>
                  </span>
                )}
                {amountFilter !== "ALL" && (
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium flex items-center gap-1.5 border border-emerald-200/80 text-[11px] shadow-2xs">
                    Amount: {amountFilter === "UNDER_50K" ? "< 50k" : amountFilter === "50K_200K" ? "50k-200k" : "> 200k"}
                    <button onClick={() => setAmountFilter("ALL")} className="text-emerald-500 hover:text-emerald-800 font-bold">&times;</button>
                  </span>
                )}
                {(startDate || endDate) && (
                  <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-medium flex items-center gap-1.5 border border-indigo-200/80 text-[11px] shadow-2xs">
                    Incident Date: {startDate || "Start"} to {endDate || "Today"}
                    <button onClick={() => { setStartDate(""); setEndDate(""); setDatePreset("ALL"); }} className="text-indigo-400 hover:text-indigo-700 font-bold">&times;</button>
                  </span>
                )}
              </div>

              <button
                onClick={handleResetFilters}
                className="text-[11px] font-semibold text-slate-500 hover:text-rose-600 transition-colors flex items-center gap-1 cursor-pointer"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Reset Filters
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">Claim Ref</th>
                <th className="px-5 py-3 font-semibold">Claimant</th>
                <th className="px-5 py-3 font-semibold">Policy #</th>
                <th className="px-5 py-3 font-semibold">Type</th>
                <th className="px-5 py-3 font-semibold">Incident Date</th>
                <th className="px-5 py-3 font-semibold text-right">Claimed</th>
                <th className="px-5 py-3 font-semibold text-right">Approved</th>
                <th className="px-5 py-3 font-semibold">Risk Flag</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-5 py-8 text-center text-slate-400 text-xs">
                    Loading claims register...
                  </td>
                </tr>
              ) : claims.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-5 py-8 text-center text-slate-400 text-xs">
                    No claims found matching applied filters.
                  </td>
                </tr>
              ) : (
                claims.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{c.claim_number}</div>
                    </td>
                    <td className="px-5 py-3 text-xs font-medium text-slate-800">{c.claimant_name}</td>
                    <td className="px-5 py-3 text-xs font-mono text-slate-500">{c.policy_number ?? "—"}</td>
                    <td className="px-5 py-3 text-xs text-slate-600">{c.claim_type}</td>
                    <td className="px-5 py-3 text-xs text-slate-600 font-mono">{c.incident_date ?? "—"}</td>
                    <td className="px-5 py-3 text-right font-medium text-slate-900">
                      PKR {c.submitted_amount.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-slate-900">
                      {c.approved_amount ? `PKR ${c.approved_amount.toLocaleString()}` : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <RiskBadge prob={c.fraud_probability} flag={c.duplicate_flag} />
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-5 py-3 text-center">
                      <Link
                        href={`/claims/${c.id}`}
                        className="text-xs font-semibold text-slate-700 hover:text-slate-900 underline"
                      >
                        Workbench
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-lg relative">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50 rounded-t-xl">
              <h3 className="text-sm font-bold text-slate-900">File First Notice of Loss (FNOL)</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-4 text-xs">
              {errorMsg && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-xs">
                  {errorMsg}
                </div>
              )}

              {step === 1 && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="block font-semibold text-slate-700">Select Policy</label>

                    {/* Custom Searchable Dropdown */}
                    <div ref={policyDropdownRef} className="relative">
                      <button
                        type="button"
                        onClick={() => setPolicyDropdownOpen(!policyDropdownOpen)}
                        className={`w-full text-xs px-3 py-2.5 rounded-lg border bg-white flex items-center justify-between transition-all focus:outline-hidden ${
                          policyDropdownOpen ? "border-blue-400 ring-2 ring-blue-500/20 shadow-sm" : "border-slate-200 hover:border-slate-300 shadow-2xs"
                        }`}
                      >
                        <span className={selectedPolicy ? "font-semibold text-slate-800" : "text-slate-500 font-normal"}>
                          {selectedPolicy
                            ? `${selectedPolicy.policy_number ?? selectedPolicy.id.slice(0, 8)} - ${selectedPolicy.customer_name} (${selectedPolicy.product_name})`
                            : `-- Choose Policy (${policies.length} available) --`}
                        </span>
                        <svg
                          className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${policyDropdownOpen ? "rotate-180 text-blue-600" : ""}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>

                      {/* Dropdown Options Popup */}
                      {policyDropdownOpen && (
                        <div className="absolute top-full left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-xl z-50 overflow-hidden animate-in fade-in duration-150">
                          {/* Search Bar Pinned Inside Dropdown Menu */}
                          <div className="p-2 border-b border-slate-100 bg-slate-50/90">
                            <div className="relative">
                              <input
                                type="text"
                                autoFocus
                                placeholder="Type policy #, customer name, or product..."
                                value={policySearch}
                                onChange={(e) => setPolicySearch(e.target.value)}
                                className="w-full text-xs px-3 py-1.5 pl-8 pr-7 rounded-md border border-slate-200 focus:outline-hidden focus:border-blue-400 focus:bg-white bg-white text-slate-800 placeholder-slate-400"
                              />
                              <svg className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                              </svg>
                              {policySearch && (
                                <button
                                  type="button"
                                  onClick={() => setPolicySearch("")}
                                  className="absolute right-2 top-1 text-slate-400 hover:text-slate-600 text-xs font-bold w-4 h-4 flex items-center justify-center rounded-full hover:bg-slate-200"
                                >
                                  &times;
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Scrollable Policy List */}
                          <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
                            {filteredPolicies.length === 0 ? (
                              <div className="p-4 text-center text-slate-400 text-xs font-medium">
                                No policies found matching &quot;{policySearch}&quot;
                              </div>
                            ) : (
                              filteredPolicies.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => {
                                    setForm({ ...form, policy_id: p.id });
                                    setPolicyDropdownOpen(false);
                                  }}
                                  className={`w-full text-left px-3.5 py-2 text-xs transition-colors flex items-center justify-between ${
                                    form.policy_id === p.id ? "bg-blue-50/80 text-blue-700 font-semibold" : "hover:bg-slate-50 text-slate-700"
                                  }`}
                                >
                                  <div className="flex flex-col min-w-0 pr-2">
                                    <span className="font-semibold text-slate-800 truncate">
                                      {p.policy_number ?? p.id.slice(0, 8)} - {p.customer_name}
                                    </span>
                                    <span className="text-[10px] text-slate-400 truncate">
                                      {p.product_name}
                                    </span>
                                  </div>
                                  {form.policy_id === p.id && (
                                    <svg className="w-4 h-4 text-blue-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {selectedPolicy && (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                      <span className="font-semibold">Selected:</span> {selectedPolicy.customer_name} ({selectedPolicy.product_name})
                    </div>
                  )}

                  <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => setShowModal(false)}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!form.policy_id) { setErrorMsg("Please select a policy first."); return; }
                        setErrorMsg(""); setStep(2);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800"
                    >
                      Next Step
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Claim Type</label>
                      <select
                        value={form.claim_type}
                        onChange={e => setForm({ ...form, claim_type: e.target.value })}
                        className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white"
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
                        onChange={e => setForm({ ...form, submitted_amount: parseFloat(e.target.value) || 0 })}
                        className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Incident Date</label>
                    <input
                      type="date"
                      value={form.incident_date}
                      onChange={e => setForm({ ...form, incident_date: e.target.value })}
                      className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Description / Notes</label>
                    <textarea
                      rows={3}
                      placeholder="Describe the claim event..."
                      value={form.notes}
                      onChange={e => setForm({ ...form, notes: e.target.value })}
                      className="w-full text-xs p-2 rounded-lg border border-slate-200"
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
                      className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50"
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
