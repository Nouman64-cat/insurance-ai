"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listClaims, createClaim, Claim, CreateClaimRequest } from "@/app/services/claims";
import { listPolicies, getPolicyDetail, PolicyListItem, PolicyDetail } from "@/app/services/policies";
import { formatCnic } from "@/lib/cnic";
import { DateRangeFilter, resolvePreset, type DatePreset, type DateRange } from "@/components/commissions/DateRangeFilter";

function getEligibleClaimTypes(policy?: PolicyListItem): string[] {
  if (!policy) {
    return ["Hospitalization", "Surgery", "Death Claim", "OPD Reimbursement"];
  }

  const pType = (policy.insurance_type || "").toUpperCase();
  const pName = (policy.product_name || "").toLowerCase();

  if (
    pType.includes("LIFE") ||
    pType.includes("ENDOWMENT") ||
    pType.includes("SAVINGS") ||
    pType.includes("SINGLE_PREMIUM") ||
    pName.includes("life") ||
    pName.includes("term") ||
    pName.includes("endowment")
  ) {
    return [
      "Death Claim",
      "Accidental Death Benefit",
      "Total & Permanent Disability (TPD)",
      "Terminal Illness Benefit",
      "Maturity Claim",
    ];
  }

  if (
    pType.includes("HEALTH") ||
    pType.includes("FLOATER") ||
    pName.includes("health") ||
    pName.includes("floater") ||
    pName.includes("medical") ||
    pName.includes("care")
  ) {
    return [
      "Hospitalization",
      "Surgery",
      "OPD Reimbursement",
      "Maternity Benefit",
      "Critical Illness Benefit",
    ];
  }

  if (
    pName.includes("salary") ||
    pName.includes("income") ||
    pName.includes("disability") ||
    pName.includes("protection")
  ) {
    return [
      "Total Permanent Disability (TPD)",
      "Temporary Total Disability / Salary Protection",
      "Critical Illness Lump Sum",
      "Death Claim",
    ];
  }

  if (
    pType.includes("CHILD") ||
    pName.includes("education") ||
    pName.includes("child") ||
    pName.includes("marriage")
  ) {
    return [
      "Payer Death / Premium Waiver Claim",
      "Education Benefit Drawdown",
      "Milestone Maturity Benefit",
    ];
  }

  return [
    "Hospitalization",
    "Surgery",
    "Death Claim",
    "OPD Reimbursement",
    "Total & Permanent Disability (TPD)",
  ];
}

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
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [riskFilter, setRiskFilter] = useState("ALL");
  const [amountFilter, setAmountFilter] = useState("ALL");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [dateRange, setDateRange] = useState<DateRange>(() => resolvePreset("all"));
  const [dateField, setDateField] = useState("incident_date");
  const [search, setSearch] = useState("");
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

  const [selectedPolicyDetail, setSelectedPolicyDetail] = useState<PolicyDetail | null>(null);
  const [claimantType, setClaimantType] = useState<"SELF" | "NOMINEE_BENEFICIARY" | "LEGAL_HEIR" | "GUARDIAN">("SELF");
  const [claimantName, setClaimantName] = useState("");
  const [claimantCnic, setClaimantCnic] = useState("");
  const [claimantRelationship, setClaimantRelationship] = useState("Spouse");
  const [claimantPhone, setClaimantPhone] = useState("");

  const selectPolicy = async (p: PolicyListItem) => {
    const options = getEligibleClaimTypes(p);
    const nextClaimType = options.includes(form.claim_type) ? form.claim_type : options[0];
    setForm({ ...form, policy_id: p.id, claim_type: nextClaimType });
    setPolicyDropdownOpen(false);

    if (nextClaimType.includes("Death")) {
      setClaimantType("NOMINEE_BENEFICIARY");
    } else {
      setClaimantType("SELF");
    }

    try {
      const detail = await getPolicyDetail(p.id);
      setSelectedPolicyDetail(detail);
      if (detail.nominee_name) {
        if (nextClaimType.includes("Death") || claimantType === "NOMINEE_BENEFICIARY") {
          setClaimantName(detail.nominee_name);
          setClaimantRelationship(detail.nominee_relationship || "Spouse");
        }
      }
    } catch {
      setSelectedPolicyDetail(null);
    }
  };

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
        start_date: dateRange.from || undefined,
        end_date: dateRange.to || undefined,
        date_field: dateField,
        search: search.trim() || undefined,
      });
      setClaims(data);
    } catch (err) {
      console.error("Failed to fetch claims:", err);
      setClaims([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [statusFilter, typeFilter, riskFilter, amountFilter, datePreset, dateRange, dateField, search]);

  useEffect(() => { listPolicies().then(setPolicies).catch(() => { }); }, []);

  const filteredPolicies = policies.filter((p) => {
    if (!policySearch.trim()) return true;
    const q = policySearch.toLowerCase();
    const num = (p.policy_number || p.id).toLowerCase();
    const name = (p.customer_name || "").toLowerCase();
    const prod = (p.product_name || "").toLowerCase();
    return num.includes(q) || name.includes(q) || prod.includes(q);
  });

  const handleResetFilters = () => {
    setStatusFilter("ALL");
    setTypeFilter("ALL");
    setRiskFilter("ALL");
    setAmountFilter("ALL");
    setDatePreset("all");
    setDateRange(resolvePreset("all"));
    setDateField("incident_date");
    setSearch("");
  };

  const isFiltered =
    statusFilter !== "ALL" ||
    typeFilter !== "ALL" ||
    riskFilter !== "ALL" ||
    amountFilter !== "ALL" ||
    datePreset !== "all" ||
    dateRange.from !== "" ||
    dateRange.to !== "" ||
    search.trim() !== "";

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.policy_id) { setErrorMsg("Please select an active policy."); return; }

    const selectedP = policies.find(p => p.id === form.policy_id);
    if (claimantType !== "SELF" && !claimantName.trim()) {
      setErrorMsg("Claimant / Beneficiary Name is required for Death or Representative claims.");
      return;
    }

    setSubmitting(true); setErrorMsg("");
    try {
      const finalClaimantName = claimantType === "SELF"
        ? (selectedP?.customer_name || "Self")
        : claimantName.trim();

      const created = await createClaim({
        ...form,
        claimant_type: claimantType,
        claimant_name: finalClaimantName,
        claimant_cnic: claimantCnic.trim() || undefined,
        claimant_relationship: claimantType === "SELF" ? "Self" : claimantRelationship,
        claimant_phone: claimantPhone.trim() || undefined,
      });

      if (created?.id) {
        setHighlightId(created.id);
        setTimeout(() => {
          setHighlightId(null);
        }, 2500);
      }

      setShowModal(false); setStep(1);
      setForm({ policy_id: "", claim_type: "Hospitalization", submitted_amount: 50000, incident_date: new Date().toISOString().split("T")[0], notes: "" });
      setClaimantType("SELF"); setClaimantName(""); setClaimantCnic(""); setClaimantRelationship("Spouse"); setClaimantPhone(""); setSelectedPolicyDetail(null);
      fetchData();
    } catch (err: any) {
      setErrorMsg(err.response?.data?.detail || "Failed to submit claim FNOL.");
    } finally { setSubmitting(false); }
  };

  const openModal = () => {
    setShowModal(true); setStep(1); setErrorMsg("");
    setSelectedPolicyDetail(null); setClaimantType("SELF"); setClaimantName(""); setClaimantCnic(""); setClaimantRelationship("Spouse"); setClaimantPhone("");
  };

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
            className="text-xs font-semibold px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-xs transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>File New Claim</span>
          </button>
        </div>
      </div>

      {/* Register & Filters Card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-visible relative">
        <div className="p-4 border-b border-slate-100 bg-slate-50/50 space-y-3 rounded-t-xl">
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
              {/* Date Range Filter */}
              <DateRangeFilter
                preset={datePreset}
                range={dateRange}
                onPresetChange={(p, r) => {
                  setDatePreset(p);
                  setDateRange(r);
                }}
                size="sm"
                align="left"
              />

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

              <button
                onClick={fetchData}
                className="h-9 text-xs font-semibold px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-all shadow-xs flex items-center gap-1.5 cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span>Search</span>
              </button>
            </div>
          </div>

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
                {(dateRange.from || dateRange.to) && (
                  <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-medium flex items-center gap-1.5 border border-indigo-200/80 text-[11px] shadow-2xs">
                    Incident Date: {dateRange.from || "Start"} to {dateRange.to || "Today"}
                    <button onClick={() => { setDatePreset("all"); setDateRange(resolvePreset("all")); }} className="text-indigo-400 hover:text-indigo-700 font-bold">&times;</button>
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

        <div className="overflow-x-auto rounded-b-xl">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">Claim Ref</th>
                <th className="px-5 py-3 font-semibold">Policyholder</th>
                <th className="px-5 py-3 font-semibold text-center">Claimant</th>
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
                  <td colSpan={11} className="px-5 py-8 text-center text-slate-400 text-xs">
                    Loading claims register...
                  </td>
                </tr>
              ) : claims.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-5 py-8 text-center text-slate-400 text-xs">
                    No claims found matching applied filters.
                  </td>
                </tr>
              ) : (
                claims.map(c => (
                  <tr
                    key={c.id}
                    className={`transition-colors duration-1000 ${highlightId === c.id || highlightId === c.claim_number
                        ? "bg-blue-100/90 font-semibold text-blue-950 shadow-inner"
                        : "hover:bg-slate-50/50"
                      }`}
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{c.claim_number}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-bold text-slate-900">{c.customer_name || "—"}</div>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <div className="flex flex-col items-center justify-center gap-1">
                        {c.claimant_name && c.customer_name && c.claimant_name !== c.customer_name ? (
                          <>
                            <span className="text-xs font-medium text-slate-800">
                              {c.claimant_name}
                            </span>
                            {c.claimant_relationship && (
                              <span className="text-[9.5px] font-bold text-slate-500 bg-slate-100 border border-slate-200/50 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                {c.claimant_relationship}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">
                            Self
                          </span>
                        )}
                      </div>
                    </td>
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
                        className="text-[11.5px] font-bold text-blue-600 hover:text-blue-800 underline flex items-center justify-center gap-1"
                      >
                        Review
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
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
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl max-h-[90vh] flex flex-col relative my-auto">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/90 rounded-t-2xl shrink-0">
              <div>
                <h3 className="text-sm font-bold text-slate-900">File First Notice of Loss (FNOL)</h3>
                <p className="text-[11px] text-slate-500">Step {step} of 2 — {step === 1 ? "Select Policy" : "Claim & Beneficiary Details"}</p>
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
                            onClick={() => selectPolicy(p)}
                            className={`w-full text-left px-3.5 py-2.5 text-xs transition-colors flex items-center justify-between ${isSelected ? "bg-blue-50/90 text-blue-800 font-semibold" : "hover:bg-slate-50 text-slate-700"
                              }`}
                          >
                            <div className="flex flex-col min-w-0 pr-2 space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-slate-900">{p.customer_name}</span>
                                <span className="font-mono text-slate-400 text-[11px]">({p.policy_number ?? p.id.slice(0, 8)})</span>
                              </div>
                              <span className="text-[10px] text-slate-500 truncate">
                                {p.product_name} • {p.insurance_type || "Standard"} • PKR {(p.coverage_amount || 0).toLocaleString()}
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

                  {selectedPolicyDetail?.nominee_name && (
                    <div className="p-2.5 bg-slate-50 border border-slate-200/80 rounded-lg text-[11px] text-slate-600 flex items-center justify-between">
                      <span className="font-medium">Nominee on file: <strong className="text-slate-800">{selectedPolicyDetail.nominee_name}</strong> ({selectedPolicyDetail.nominee_relationship || "Nominee"})</span>
                      <span className="text-slate-400 text-[10px]">Auto-populates in Step 2</span>
                    </div>
                  )}

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
                        if (!form.policy_id) { setErrorMsg("Please select a policy first."); return; }
                        setErrorMsg(""); setStep(2);
                      }}
                      className="px-4 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
                    >
                      Next Step &rarr;
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (() => {
                const eligibleClaimTypes = getEligibleClaimTypes(selectedPolicy);
                const isDeathClaim = form.claim_type.includes("Death");

                return (
                  <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
                    {/* Distinct Policy Banner */}
                    <div className="p-4 bg-gradient-to-r from-blue-100/70 to-blue-50/40 border border-blue-200/80 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs shadow-sm relative overflow-hidden">
                      <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-600" />

                      <div className="space-y-1.5 min-w-0 pl-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="font-extrabold text-blue-950 text-[14px] tracking-tight drop-shadow-xs">{selectedPolicy?.customer_name}</span>
                          <span className="px-2.5 py-0.5 rounded-full bg-white border border-blue-200 text-blue-800 font-bold shadow-xs">
                            {selectedPolicy?.product_name}
                          </span>
                          <span className="font-bold text-blue-800 uppercase tracking-widest text-[10px] bg-blue-100/80 px-2 py-0.5 rounded">
                            {selectedPolicy?.insurance_type.replace("_", " ")}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-blue-900/80 font-medium">
                          <span>Policy #: <strong className="text-blue-950 font-mono tracking-wide">{selectedPolicy?.policy_number}</strong></span>
                          <span className="hidden sm:inline text-blue-300 font-bold">•</span>
                          <span>Coverage Limit: <strong className="text-blue-950 font-bold">PKR {selectedPolicy?.coverage_amount.toLocaleString()}</strong></span>
                        </div>
                      </div>

                      <div className="shrink-0 relative z-10 pl-2">
                        <span className="flex items-center gap-1.5 bg-emerald-500 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider shadow-xs shadow-emerald-500/20">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          Verified
                        </span>
                      </div>
                    </div>

                    {/* Claim Type & Amount Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Eligible Claim Type <span className="text-slate-400 font-normal">({eligibleClaimTypes.length} available)</span>
                        </label>
                        <select
                          value={form.claim_type}
                          onChange={e => {
                            const newType = e.target.value;
                            setForm({ ...form, claim_type: newType });
                            if (newType.includes("Death")) {
                              setClaimantType("NOMINEE_BENEFICIARY");
                              if (selectedPolicyDetail?.nominee_name && !claimantName) {
                                setClaimantName(selectedPolicyDetail.nominee_name);
                                setClaimantRelationship(selectedPolicyDetail.nominee_relationship || "Spouse");
                              }
                            } else {
                              setClaimantType("SELF");
                            }
                          }}
                          className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white font-semibold text-slate-800"
                        >
                          {eligibleClaimTypes.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Claim Amount (PKR)
                        </label>
                        <input
                          type="number"
                          required
                          min="1"
                          max={selectedPolicy?.coverage_amount}
                          value={form.submitted_amount || ""}
                          onChange={e => setForm({ ...form, submitted_amount: parseInt(e.target.value) || 0 })}
                          className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-medium"
                        />
                      </div>
                    </div>

                    {/* Claimant & Beneficiary Intake Box */}
                    <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl space-y-3">
                      {/* <div className="flex items-center justify-between">
                        <label className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                          Claimant & Beneficiary Intake
                        </label>
                        {isDeathClaim && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-200">
                            DEATH CLAIM MANDATE
                          </span>
                        )}
                      </div> */}

                      {/* Claimant Role Selection */}
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button
                          type="button"
                          disabled={isDeathClaim}
                          onClick={() => setClaimantType("SELF")}
                          className={`p-2 rounded-lg border text-left flex items-center justify-between transition-all ${claimantType === "SELF"
                              ? "bg-blue-50 border-blue-300 text-blue-900 font-semibold shadow-xs"
                              : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
                            } ${isDeathClaim ? "opacity-40 cursor-not-allowed bg-slate-100/50" : ""}`}
                        >
                          <span>Self (Policyholder)</span>
                          {claimantType === "SELF" && <span className="text-blue-600 font-bold text-xs">✓</span>}
                        </button>

                        <button
                          type="button"
                          disabled={!isDeathClaim}
                          onClick={() => {
                            setClaimantType("NOMINEE_BENEFICIARY");
                            if (selectedPolicyDetail?.nominee_name && !claimantName) {
                              setClaimantName(selectedPolicyDetail.nominee_name);
                              setClaimantRelationship(selectedPolicyDetail.nominee_relationship || "Spouse");
                            }
                          }}
                          className={`p-2 rounded-lg border text-left flex items-center justify-between transition-all ${claimantType !== "SELF"
                              ? "bg-blue-50 border-blue-300 text-blue-900 font-semibold shadow-xs"
                              : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
                            } ${!isDeathClaim ? "opacity-40 cursor-not-allowed bg-slate-100/50" : ""}`}
                        >
                          <span>Nominee / Beneficiary / Heir</span>
                          {claimantType !== "SELF" && <span className="text-blue-600 font-bold text-xs">✓</span>}
                        </button>
                      </div>

                      {/* Beneficiary Inputs if Filing as Nominee/Representative */}
                      {claimantType !== "SELF" && (
                        <div className="p-3.5 bg-white border border-slate-200 shadow-2xs rounded-lg space-y-3 mt-2 animate-in fade-in slide-in-from-top-2 duration-300">
                          {selectedPolicyDetail?.nominee_name && (
                            <div className="flex items-center justify-between p-2 bg-white border border-slate-200 rounded-lg text-xs">
                              <div>
                                <span className="text-slate-400 text-[10px] uppercase font-bold">Policy Recorded Nominee:</span>
                                <div className="font-semibold text-slate-900">{selectedPolicyDetail.nominee_name} ({selectedPolicyDetail.nominee_relationship || "Nominee"})</div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setClaimantName(selectedPolicyDetail.nominee_name || "");
                                  setClaimantRelationship(selectedPolicyDetail.nominee_relationship || "Spouse");
                                }}
                                className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold rounded"
                              >
                                Pre-fill
                              </button>
                            </div>
                          )}

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-700 mb-0.5">Claimant Full Name *</label>
                              <input
                                type="text"
                                required
                                placeholder="e.g. Fatima Ahmed"
                                value={claimantName}
                                onChange={e => setClaimantName(e.target.value)}
                                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-semibold text-slate-700 mb-0.5">Relationship to Insured</label>
                              <select
                                value={claimantRelationship}
                                onChange={e => setClaimantRelationship(e.target.value)}
                                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white"
                              >
                                <option value="Spouse">Spouse</option>
                                <option value="Child">Child</option>
                                <option value="Parent">Parent</option>
                                <option value="Legal Heir">Legal Heir</option>
                                <option value="Executor">Executor / Legal Representative</option>
                              </select>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-700 mb-0.5">Claimant CNIC / Govt ID</label>
                              <input
                                type="text"
                                inputMode="numeric"
                                maxLength={15}
                                placeholder="42101-1234567-1"
                                value={claimantCnic}
                                onChange={e => setClaimantCnic(formatCnic(e.target.value))}
                                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-semibold text-slate-700 mb-0.5">Claimant Phone Number</label>
                              <input
                                type="text"
                                placeholder="+92 300 XXXXXXX"
                                value={claimantPhone}
                                onChange={e => setClaimantPhone(e.target.value)}
                                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Incident Date & Description */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                        <label className="block font-semibold text-slate-700 mb-1">
                          Description / Intake Notes <span className="text-[10px] font-normal text-slate-400">(Optional)</span>
                        </label>
                        <textarea
                          rows={2}
                          placeholder="Describe the claim event (optional)..."
                          value={form.notes}
                          onChange={e => setForm({ ...form, notes: e.target.value })}
                          className="w-full text-xs p-2 rounded-lg border border-slate-200"
                        />
                      </div>
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
                        {submitting ? "Submitting FNOL..." : "Submit Claim FNOL"}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
