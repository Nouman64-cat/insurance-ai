"use client";

import React, { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { SegmentDropdown, SegmentFilter, SEGMENT_LABEL, SEGMENT_BADGE_STYLE } from "@/components/SegmentDropdown";
import { fmtCoverage } from "@/lib/mock-data";
import { listCases, runCaseCompliance, type CaseQueueItem } from "@/app/services/cases";
import { inviteEApplication } from "@/app/services/eApplication";
import { getACR, type AgentConfidentialReport } from "@/app/services/agentConfidentialReport";
import { ACRModal } from "@/components/entities/ACRModal";
import { IPPModal } from "@/components/entities/IPPModal";
import { createCounterOffer } from "@/app/services/preIssuance";
import api from "@/app/services/api";
import FiltersPanel from "@/components/FiltersPanel";

const CASE_STATUS_STYLE: Record<string, string> = {
  New: "bg-slate-100 text-slate-600 border-slate-200",
  InProgress: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border-amber-200",
  "Under Review": "bg-blue-50 text-blue-700 border-blue-200",
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Rejected: "bg-red-50 text-red-700 border-red-200",
  Closed: "bg-slate-200 text-slate-700 border-slate-300",
};

const ACTIVE_STATUSES = new Set(["New", "InProgress", "Pending Documents", "Under Review"]);

interface CustomerFolder {
  customer_id: string;
  customer_name: string;
  customer_cnic: string;
  customer_segment: "individual" | "family" | "organization";
  cases: CaseQueueItem[];
}

function StatusPill({ done, pending, label }: { done: boolean; pending: string; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border transition-all ${
        done
          ? "bg-emerald-50 text-emerald-700 border-emerald-200/80 shadow-xs"
          : "bg-amber-50 text-amber-700 border-amber-200/80"
      }`}
    >
      <span>{done ? "✓" : "!"}</span>
      <span>{done ? label : pending}</span>
    </span>
  );
}

function UnderwritingMainContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") === "pre-underwriting" ? "pre-underwriting" : "risk-engine";

  const [activeTab, setActiveTab] = useState<"pre-underwriting" | "risk-engine">(initialTab);
  const [cases, setCases] = useState<CaseQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);

  // Pre-Underwriting state
  const [preSearch, setPreSearch] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [linkBusyFor, setLinkBusyFor] = useState<string | null>(null);
  const [generatedLinks, setGeneratedLinks] = useState<Record<string, string>>({});
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [compBusyFor, setCompBusyFor] = useState<string | null>(null);
  const [compModal, setCompModal] = useState<{ caseId: string; customerName?: string; data: any } | null>(null);
  const [acrModal, setAcrModal] = useState<{ caseId: string; initial: AgentConfidentialReport | null } | null>(null);
  const [acrLoadingFor, setAcrLoadingFor] = useState<string | null>(null);
  const [ippModal, setIppModal] = useState<{ caseId: string; customerName?: string } | null>(null);

  // Risk Engine state
  const [riskSearch, setRiskSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [counterOfferCase, setCounterOfferCase] = useState<CaseQueueItem | null>(null);

  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  const loadData = useCallback(async () => {
    if (!tenantId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await listCases(tenantId);
      setCases(data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load cases");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setUserRole(localStorage.getItem("user_role"));
    }
    loadData();
  }, [loadData]);

  // Pre-Underwriting helpers
  const isFullyReady = (c: CaseQueueItem) =>
    c.e_application_status === "Submitted" &&
    c.acr_status === "Submitted" &&
    c.compliance_status === "Passed" &&
    c.ipp_status === "Realized";

  const preFiltered = useMemo(() => {
    const q = preSearch.trim().toLowerCase();
    return cases
      .filter((c) => ACTIVE_STATUSES.has(c.caseStatus))
      .filter((c) => showCompleted || !isFullyReady(c))
      .filter(
        (c) =>
          !q ||
          (c.customer_name ?? "").toLowerCase().includes(q) ||
          (c.customer_cnic ?? "").toLowerCase().includes(q) ||
          c.caseNumber.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const aDone = isFullyReady(a);
        const bDone = isFullyReady(b);
        if (aDone !== bDone) return aDone ? 1 : -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [cases, preSearch, showCompleted]);

  const preKpis = useMemo(() => {
    const active = cases.filter((c) => ACTIVE_STATUSES.has(c.caseStatus));
    const missingEApp = active.filter((c) => c.e_application_status !== "Submitted").length;
    const missingAcr = active.filter((c) => c.acr_status !== "Submitted").length;
    const missingComp = active.filter((c) => c.compliance_status !== "Passed").length;
    const missingIpp = active.filter((c) => c.ipp_status !== "Realized").length;
    const ready = active.filter(isFullyReady).length;
    return { total: active.length, missingEApp, missingAcr, missingComp, missingIpp, ready };
  }, [cases]);

  const handleGenerateLink = async (c: CaseQueueItem) => {
    setLinkBusyFor(c.caseld);
    setLinkErr(null);
    try {
      const invite = await inviteEApplication(c.caseld);
      setGeneratedLinks((prev) => ({ ...prev, [c.caseld]: `${window.location.origin}${invite.link_path}` }));
      await loadData();
    } catch (e: any) {
      setLinkErr(e?.message ?? "Failed to generate link");
    } finally {
      setLinkBusyFor(null);
    }
  };

  const handleRunCompliance = async (c: CaseQueueItem) => {
    setCompBusyFor(c.caseld);
    try {
      const res = await runCaseCompliance(tenantId, c.caseld);
      setCases((prev) =>
        prev.map((item) =>
          item.caseld === c.caseld ? { ...item, compliance_status: res.overall_status } : item,
        ),
      );
      setCompModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined, data: res });
      await loadData();
    } catch (e: any) {
      alert(e?.response?.data?.detail ?? e?.message ?? "Compliance check failed");
    } finally {
      setCompBusyFor(null);
    }
  };

  const openAcrModal = async (c: CaseQueueItem) => {
    setAcrLoadingFor(c.caseld);
    try {
      const acr = await getACR(c.caseld);
      setAcrModal({ caseId: c.caseld, initial: acr.status === "NotStarted" ? null : acr });
    } catch {
      setAcrModal({ caseId: c.caseld, initial: null });
    } finally {
      setAcrLoadingFor(null);
    }
  };

  const canFileAcr = userRole === "Agent" || userRole === "Admin";

  // Risk Engine helpers
  const segmentCases = useMemo(() => {
    let list = cases;
    if (segment !== "all") {
      list = list.filter((c) => (c.customer_segment ?? "individual") === segment);
    }
    if (filterStatus !== "ALL") {
      list = list.filter((c) => c.caseStatus === filterStatus);
    }
    if (dateFrom || dateTo) {
      list = list.filter((c) => {
        const d = new Date(c.createdAt).getTime();
        const start = dateFrom ? new Date(dateFrom).getTime() : 0;
        const end = dateTo ? new Date(dateTo).getTime() + 86400000 : Infinity;
        return d >= start && d <= end;
      });
    }
    return list;
  }, [cases, segment, filterStatus, dateFrom, dateTo]);

  const segmentCounts = useMemo(() => {
    const counts: Partial<Record<SegmentFilter, number>> = {};
    const ind = cases.filter((c) => (c.customer_segment ?? "individual") === "individual");
    counts["individual"] = new Set(ind.map((c) => c.customer_id)).size;

    const org = cases.filter((c) => c.customer_segment === "organization");
    counts["organization"] = new Set(org.map((c) => c.organization_id).filter(Boolean)).size;

    const fam = cases.filter((c) => c.customer_segment === "family");
    counts["family"] = new Set(fam.map((c) => c.family_group_id).filter(Boolean)).size;

    counts["all"] = (counts["individual"] || 0) + (counts["organization"] || 0) + (counts["family"] || 0);

    return counts;
  }, [cases]);

  const folders = useMemo<CustomerFolder[]>(() => {
    const q = riskSearch.trim().toLowerCase();
    const filteredList = q
      ? segmentCases.filter(
          (c) =>
            (c.customer_name ?? "").toLowerCase().includes(q) ||
            (c.customer_cnic ?? "").toLowerCase().includes(q) ||
            c.caseNumber.toLowerCase().includes(q),
        )
      : segmentCases;

    const grouped = new Map<string, CustomerFolder>();
    for (const c of filteredList) {
      const groupId =
        c.customer_segment === "organization" && c.organization_id
          ? c.organization_id
          : c.customer_segment === "family" && c.family_group_id
          ? c.family_group_id
          : c.customer_id;

      if (!grouped.has(groupId)) {
        grouped.set(groupId, {
          customer_id: groupId,
          customer_name:
            c.customer_segment === "organization"
              ? "Corporate Account"
              : c.customer_segment === "family"
              ? c.family_group_name ?? `${c.customer_name} & Family`
              : c.customer_name ?? "Unknown Customer",
          customer_cnic: c.customer_segment === "individual" ? c.customer_cnic ?? "—" : "Multiple",
          customer_segment: c.customer_segment ?? "individual",
          cases: [],
        });
      }
      grouped.get(groupId)!.cases.push(c);
    }
    return Array.from(grouped.values());
  }, [segmentCases, riskSearch]);

  const handleDownloadReport = async (c: CaseQueueItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (!tenantId) return;
      const res = await api.get(`/tenants/${tenantId}/cases/${c.caseld}/detail`, {
        headers: { "X-Tenant-Id": tenantId },
      });
      const { customer, latest_assessment, policy } = res.data;
      if (!latest_assessment) {
        alert("No AI assessment available to download for this case.");
        return;
      }

      const { generateAssessmentPDF } = await import("@/lib/pdf-export");
      await generateAssessmentPDF({
        customer_name: customer?.name ?? "Unknown",
        customer_cnic: customer?.cnic ?? "Unknown",
        case_id: c.caseld,
        created_at: latest_assessment.created_at,
        medical_score: latest_assessment.medical_score,
        financial_score: latest_assessment.financial_score,
        fraud_probability: latest_assessment.fraud_probability,
        composite_risk_score: latest_assessment.composite_risk_score,
        ai_decision: latest_assessment.ai_decision,
        suggested_loading: latest_assessment.suggested_loading,
        reasons: latest_assessment.reasons ?? [],
        ai_summary: null,
        product_name: policy?.product_name ?? null,
      });
    } catch (err) {
      console.error("Failed to download report:", err);
      alert("Failed to download report.");
    }
  };

  const riskKpis = useMemo(() => {
    let pendingDocs = 0;
    let underReview = 0;
    let approved = 0;

    for (const folder of folders) {
      const statuses = folder.cases.map((c) => c.caseStatus);
      if (statuses.includes("Pending Documents")) {
        pendingDocs++;
      } else if (statuses.every((s) => s === "Approved")) {
        approved++;
      } else {
        underReview++;
      }
    }

    return [
      { title: "Folders", value: folders.length, subtitle: "active customer groups", accent: "blue" as const },
      { title: "Awaiting Documents", value: pendingDocs, subtitle: "intake pending", accent: "amber" as const },
      { title: "In Underwriting", value: underReview, subtitle: "under evaluation", accent: "blue" as const },
      { title: "Approved", value: approved, subtitle: "cleared for issuance", accent: "emerald" as const },
    ];
  }, [folders]);

  return (
    <div className="px-6 py-4 space-y-4 max-w-screen-2xl mx-auto w-full">
      {/* Sleek Compact Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200/80">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-xs shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 tracking-tight">Underwriting Hub</h1>
              <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 text-[10px] font-semibold uppercase tracking-wider">
                Unified Portal
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Pre-underwriting clearance gates (E-App, ACR, PEP/Sanctions, IPP) &amp; AI Risk Engine evaluation.
            </p>
          </div>
        </div>

        {/* Compact Segmented Switcher */}
        <div className="flex bg-slate-100/90 p-1 rounded-xl border border-slate-200/80 shrink-0">
          <button
            onClick={() => setActiveTab("pre-underwriting")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === "pre-underwriting"
                ? "bg-white text-slate-900 shadow-xs border border-slate-200/60"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <span>1. Pre-Underwriting Clearance</span>
            {preKpis.total > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-mono font-bold">
                {preKpis.total - preKpis.ready}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab("risk-engine")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === "risk-engine"
                ? "bg-white text-slate-900 shadow-xs border border-slate-200/60"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <span>2. Risk Engine &amp; AI Cases</span>
            {folders.length > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-mono font-bold">
                {folders.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-xs font-semibold">
          {error}
        </div>
      )}

      {/* ── TAB 1: PRE-UNDERWRITING VERIFICATION ──────────────────────────────── */}
      {activeTab === "pre-underwriting" && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* KPI Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <MetricCard title="Active Proposals" value={preKpis.total} subtitle="intake pipeline" accent="slate" />
            <MetricCard title="Missing E-App" value={preKpis.missingEApp} subtitle="medical form" accent="amber" />
            <MetricCard title="Missing ACR" value={preKpis.missingAcr} subtitle="agent report" accent="amber" />
            <MetricCard title="PEP / Sanctions" value={preKpis.missingComp} subtitle="screening check" accent="amber" />
            <MetricCard title="Missing IPP" value={preKpis.missingIpp} subtitle="Section 30 payment" accent="amber" />
            <MetricCard title="Fully Cleared" value={preKpis.ready} subtitle="ready for risk engine" accent="blue" />
          </div>

          {/* Controls Bar */}
          <div className="flex items-center justify-between gap-3 flex-wrap bg-white p-3.5 rounded-xl border border-slate-200/80 shadow-xs">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="relative w-full max-w-xs">
                <input
                  type="text"
                  placeholder="Search customer, CNIC, or case number…"
                  value={preSearch}
                  onChange={(e) => setPreSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 bg-slate-50"
                />
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              {linkErr && <p className="text-xs text-red-600 font-semibold">{linkErr}</p>}
            </div>

            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer select-none bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
              <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
              Show fully-cleared proposals
            </label>
          </div>

          {/* Proposals Queue */}
          <div className="space-y-4">
            {loading ? (
              <div className="py-16 bg-white rounded-xl border border-slate-200 text-center"><div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-200 border-t-blue-600 mx-auto" /></div>
            ) : preFiltered.length === 0 ? (
              <div className="py-16 bg-white rounded-xl border border-slate-200 text-center px-4">
                <p className="text-sm font-bold text-slate-700">No proposals requiring intake attention right now.</p>
                <p className="text-xs text-slate-400 mt-1">Check "Show fully-cleared proposals" or try another search.</p>
              </div>
            ) : (
              preFiltered.map((c) => {
                const cleared = isFullyReady(c);
                const stepCount = [
                  c.e_application_status === "Submitted",
                  c.acr_status === "Submitted",
                  c.compliance_status === "Passed",
                  c.ipp_status === "Realized",
                ].filter(Boolean).length;

                return (
                  <div
                    key={c.caseld}
                    className={`bg-white rounded-2xl border transition-all duration-200 overflow-hidden ${
                      cleared
                        ? "border-emerald-200 shadow-sm bg-gradient-to-r from-emerald-50/20 to-white"
                        : "border-slate-200/90 shadow-sm hover:shadow-md hover:border-blue-200"
                    }`}
                  >
                    {/* Card Header */}
                    <div className="px-6 py-4 bg-slate-50/70 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs ${cleared ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>
                          {c.customer_name?.slice(0, 2).toUpperCase() ?? "CA"}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-bold text-slate-900 text-sm">{c.customer_name}</h3>
                            <span className="font-mono text-[10px] text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded font-semibold">{c.caseNumber}</span>
                            {c.customer_segment && (
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${SEGMENT_BADGE_STYLE[c.customer_segment]}`}>
                                {SEGMENT_LABEL[c.customer_segment]}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 font-mono mt-0.5">CNIC: {c.customer_cnic ?? "—"} · Product: {c.product_name ?? "—"}</p>
                        </div>
                      </div>

                      {/* Stepper Badge */}
                      <div className="flex items-center gap-3">
                        <div className="flex flex-col items-end">
                          <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Clearance Gates</span>
                          <span className={`text-xs font-extrabold ${cleared ? "text-emerald-700" : "text-blue-700"}`}>
                            {stepCount} of 4 Gates Passed
                          </span>
                        </div>
                        {cleared ? (
                          <button
                            onClick={() => router.push(`/case/${c.caseld}`)}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-xs transition-all flex items-center gap-1.5"
                          >
                            <span>Trigger Risk Engine</span>
                            <span>→</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => router.push(`/case/${c.caseld}`)}
                            className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold transition-all"
                          >
                            View Case Detail
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Gates Grid */}
                    <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {/* Gate 1: E-App */}
                      <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-100 flex flex-col justify-between space-y-3">
                        <div>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">1. E-Application</span>
                            <StatusPill done={c.e_application_status === "Submitted"} pending={c.e_application_status ?? "Not Sent"} label="Submitted" />
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1">Medical disclosures &amp; declarative disclosures.</p>
                        </div>
                        <div className="pt-2 border-t border-slate-200/60">
                          <button
                            onClick={() => handleGenerateLink(c)}
                            disabled={linkBusyFor === c.caseld}
                            className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40"
                          >
                            {linkBusyFor === c.caseld ? "Generating Link…" : c.e_application_status && c.e_application_status !== "NotSent" ? "Resend Link" : "Generate Link"}
                          </button>
                          {generatedLinks[c.caseld] && (
                            <div className="mt-2 flex items-center gap-1">
                              <input readOnly value={generatedLinks[c.caseld]} onFocus={(e) => e.currentTarget.select()} className="text-[10px] border border-slate-200 rounded px-1.5 py-1 w-full font-mono text-slate-600 bg-white" />
                              <button onClick={() => navigator.clipboard.writeText(generatedLinks[c.caseld])} className="text-[10px] font-bold text-blue-600 px-1.5 py-1 bg-blue-50 rounded">Copy</button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Gate 2: ACR */}
                      <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-100 flex flex-col justify-between space-y-3">
                        <div>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">2. Agent's ACR</span>
                            <StatusPill done={c.acr_status === "Submitted"} pending={c.acr_status ?? "Not Started"} label="Submitted" />
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1">Moral hazard &amp; financial standing report.</p>
                        </div>
                        <div className="pt-2 border-t border-slate-200/60">
                          {c.acr_status !== "Submitted" ? (
                            <button
                              disabled={!canFileAcr || acrLoadingFor === c.caseld}
                              onClick={() => openAcrModal(c)}
                              className={`text-xs font-bold ${!canFileAcr ? "text-slate-400 opacity-50 cursor-not-allowed" : "text-blue-600 hover:text-blue-700"}`}
                            >
                              {acrLoadingFor === c.caseld ? "Loading…" : c.acr_status === "Draft" ? "Continue ACR" : "File ACR"}
                            </button>
                          ) : (
                            <span className="text-[11px] font-semibold text-emerald-700">✓ Report Filed</span>
                          )}
                        </div>
                      </div>

                      {/* Gate 3: PEP & Sanctions */}
                      <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-100 flex flex-col justify-between space-y-3">
                        <div>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">3. PEP / Sanctions</span>
                            <StatusPill done={c.compliance_status === "Passed"} pending={c.compliance_status ?? "Not Started"} label="Passed" />
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1">OpenSanctions &amp; SECP regulatory check.</p>
                        </div>
                        <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between">
                          <button
                            onClick={() => handleRunCompliance(c)}
                            disabled={compBusyFor === c.caseld}
                            className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 flex items-center gap-1"
                          >
                            {compBusyFor === c.caseld ? (
                              <>
                                <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                                <span>Screening…</span>
                              </>
                            ) : (
                              <span>{c.compliance_status && c.compliance_status !== "NotStarted" ? "Re-Screen PEP" : "Run Screening"}</span>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Gate 4: IPP */}
                      <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-100 flex flex-col justify-between space-y-3">
                        <div>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">4. IPP Clearance</span>
                            <StatusPill done={c.ipp_status === "Realized"} pending={c.ipp_status ?? "Not Started"} label="Cleared" />
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1">Section 30 Insurance Ordinance requirement.</p>
                        </div>
                        <div className="pt-2 border-t border-slate-200/60">
                          {c.ipp_status !== "Realized" ? (
                            <button
                              onClick={() => setIppModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined })}
                              className="text-xs font-bold text-blue-600 hover:text-blue-700"
                            >
                              {c.ipp_status === "Initiated" ? "Complete Payment" : "Collect Payment"}
                            </button>
                          ) : (
                            <span className="text-[11px] font-semibold text-emerald-700">✓ Premium Realized</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ── TAB 2: RISK ENGINE & AI CASES ─────────────────────────────────────── */}
      {activeTab === "risk-engine" && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {riskKpis.map((k) => (
              <MetricCard key={k.title} {...k} />
            ))}
          </div>

          {/* Search & Filter Toolbar */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
              <input
                type="text"
                placeholder="Search customer, CNIC, or case number…"
                value={riskSearch}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full max-w-xs px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 bg-white"
              />
              <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />

              <FiltersPanel
                dateFrom={dateFrom}
                dateTo={dateTo}
                onDateFromChange={setDateFrom}
                onDateToChange={setDateTo}
                statusFilter={filterStatus}
                onStatusChange={setFilterStatus}
                statusOptions={[
                  { value: "New", label: "New" },
                  { value: "InProgress", label: "In Progress" },
                  { value: "Pending Documents", label: "Pending Documents" },
                  { value: "Under Review", label: "Under Review" },
                  { value: "Approved", label: "Approved" },
                  { value: "Rejected", label: "Rejected" },
                  { value: "Closed", label: "Closed" },
                ]}
                activeCount={[filterStatus !== "ALL", dateFrom || dateTo].filter(Boolean).length}
                onClearAll={() => {
                  setFilterStatus("ALL");
                  setDateFrom("");
                  setDateTo("");
                }}
              />
            </div>

            <div className="inline-flex bg-slate-100 p-1 rounded-xl border border-slate-200 shrink-0">
              <button
                onClick={() => setViewMode("list")}
                className={`p-1.5 rounded-lg transition-all ${viewMode === "list" ? "bg-white text-blue-600 shadow-xs" : "text-slate-500 hover:text-slate-700"}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
              </button>
              <button
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-lg transition-all ${viewMode === "grid" ? "bg-white text-blue-600 shadow-xs" : "text-slate-500 hover:text-slate-700"}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
              </button>
            </div>
          </div>

          {/* Customer Group Folders */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
            {loading ? (
              <div className="py-16 flex justify-center"><div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-600" /></div>
            ) : folders.length === 0 ? (
              <div className="py-16 flex flex-col items-center justify-center text-center px-4">
                <p className="text-sm font-bold text-slate-700">No underwriting case folders match your criteria.</p>
                <p className="text-xs text-slate-400 mt-1">Cases open automatically when a quotation is proceeded.</p>
              </div>
            ) : (
              <div className={viewMode === "grid" ? "p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "p-4 flex flex-col gap-3"}>
                {folders.map((folder) => {
                  const isExpanded = expandedCustomerId === folder.customer_id;
                  const decidedCount = folder.cases.filter((c) => c.latest_ai_decision).length;
                  return (
                    <div
                      key={folder.customer_id}
                      className={`flex flex-col border rounded-xl overflow-hidden transition-all duration-200 ${
                        isExpanded ? "border-blue-300 shadow-md ring-1 ring-blue-500/20" : "border-slate-200 shadow-xs hover:shadow-md hover:border-blue-200 bg-white"
                      }`}
                    >
                      <div
                        onClick={() => setExpandedCustomerId(isExpanded ? null : folder.customer_id)}
                        className={`flex items-start justify-between cursor-pointer select-none p-4 ${isExpanded ? "bg-blue-50/40" : "bg-white"}`}
                      >
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className={`w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl ${isExpanded ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-500"}`}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-bold text-slate-900 truncate">{folder.customer_name}</h3>
                            <p className="text-[11px] text-slate-500 font-mono mt-0.5">{folder.customer_cnic}</p>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold border uppercase tracking-wide ${SEGMENT_BADGE_STYLE[folder.customer_segment]}`}>
                                {SEGMENT_LABEL[folder.customer_segment]}
                              </span>
                              {decidedCount > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                                  {decidedCount} evaluated
                                </span>
                              )}
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                                {folder.cases.length} {folder.cases.length === 1 ? "Case" : "Cases"}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="pt-1">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-slate-400 transition-transform ${isExpanded ? "rotate-180 text-blue-500" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-slate-100 bg-white overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-slate-100 bg-slate-50 font-semibold uppercase tracking-wider text-slate-400">
                                <th className="px-4 py-2.5 text-left">Case</th>
                                <th className="px-4 py-2.5 text-left">Product</th>
                                <th className="px-4 py-2.5 text-right">Sum Assured</th>
                                <th className="px-4 py-2.5 text-left">Status</th>
                                <th className="px-4 py-2.5 text-left">AI Decision</th>
                                <th className="px-4 py-2.5 text-right" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                              {folder.cases.map((c) => (
                                <tr key={c.caseld} onClick={() => router.push(`/case/${c.caseld}`)} className="hover:bg-slate-50 cursor-pointer transition-colors">
                                  <td className="px-4 py-2.5">
                                    <p className="font-semibold text-slate-900">{c.customer_name}</p>
                                    <p className="font-mono text-[10px] text-slate-500 mt-0.5">{c.caseNumber}</p>
                                  </td>
                                  <td className="px-4 py-2.5 text-slate-600">{c.product_name ?? "—"}</td>
                                  <td className="px-4 py-2.5 text-right font-semibold text-slate-700">{c.coverage_amount != null ? fmtCoverage(c.coverage_amount) : "—"}</td>
                                  <td className="px-4 py-2.5">
                                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${CASE_STATUS_STYLE[c.caseStatus] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                                      {c.caseStatus}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    {c.latest_ai_decision ? <StatusBadge decision={c.latest_ai_decision} /> : <span className="text-[10px] text-slate-400 italic">Not evaluated</span>}
                                  </td>
                                  <td className="px-4 py-2.5 text-right">
                                    <div className="flex items-center justify-end gap-2">
                                      {c.latest_ai_decision && (
                                        <button onClick={(e) => handleDownloadReport(c, e)} className="text-xs font-semibold text-slate-500 hover:text-slate-800">Report</button>
                                      )}
                                      {c.policy_id && c.caseStatus !== "Approved" && c.caseStatus !== "Rejected" && (
                                        <button
                                          disabled={userRole === "Agent"}
                                          onClick={(e) => { e.stopPropagation(); if (userRole !== "Agent") setCounterOfferCase(c); }}
                                          className={`text-xs font-semibold ${userRole === "Agent" ? "text-slate-300 cursor-not-allowed" : "text-amber-600 hover:text-amber-700"}`}
                                        >
                                          Counter-offer
                                        </button>
                                      )}
                                      <span className="text-xs font-bold text-blue-600">Open →</span>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ACR Modal */}
      {acrModal && (
        <ACRModal
          caseId={acrModal.caseId}
          initial={acrModal.initial}
          onClose={() => setAcrModal(null)}
          onDone={() => { setAcrModal(null); loadData(); }}
        />
      )}

      {/* IPP Modal */}
      {ippModal && (
        <IPPModal
          caseId={ippModal.caseId}
          customerName={ippModal.customerName}
          onClose={() => setIppModal(null)}
          onConfirmed={() => { setIppModal(null); loadData(); }}
        />
      )}

      {/* Compliance Results Popup Modal */}
      {compModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">Compliance Screening Results</h3>
                <p className="text-xs text-slate-500">{compModal.customerName ?? compModal.caseId}</p>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                compModal.data.overall_status === "Passed" ? "bg-emerald-100 text-emerald-800 border border-emerald-200" :
                compModal.data.overall_status === "Flagged" ? "bg-amber-100 text-amber-800 border border-amber-200" : "bg-red-100 text-red-800 border border-red-200"
              }`}>
                {compModal.data.overall_status}
              </span>
            </div>
            <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
              {compModal.data.checks?.map((chk: any) => (
                <div key={chk.id || chk.check_type} className="border border-slate-200 rounded-xl p-3.5 space-y-1.5 bg-slate-50/50 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">{chk.check_type} Check</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      chk.status === "Passed" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
                      chk.status === "Flagged" ? "bg-amber-50 text-amber-700 border border-amber-200" : "bg-red-50 text-red-700 border border-red-200"
                    }`}>
                      {chk.status}
                    </span>
                  </div>
                  {chk.details && (
                    <div className="text-[11px] text-slate-600 bg-white p-2.5 rounded-lg border border-slate-100 space-y-1">
                      {chk.details.note && <p className="font-medium text-slate-700">{chk.details.note}</p>}
                      {chk.details.cnic && <p className="font-mono text-[10px] text-slate-500">CNIC: {chk.details.cnic}</p>}
                      {chk.details.list && <p className="text-slate-500">List: {chk.details.list}</p>}
                      {chk.details.reasons && chk.details.reasons.map((r: string, idx: number) => <p key={idx}>{r}</p>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button onClick={() => setCompModal(null)} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold">
                Close &amp; Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Counter Offer Modal */}
      {counterOfferCase && (
        <CounterOfferModal
          caseItem={counterOfferCase}
          onClose={() => setCounterOfferCase(null)}
          onDone={() => {
            setCounterOfferCase(null);
            loadData();
          }}
        />
      )}
    </div>
  );
}

export default function UnderwritingPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-slate-500">Loading Underwriting Hub…</div>}>
      <UnderwritingMainContent />
    </Suspense>
  );
}

function CounterOfferModal({
  caseItem, onClose, onDone,
}: Readonly<{ caseItem: CaseQueueItem; onClose: () => void; onDone: () => void }>) {
  const [offerType, setOfferType] = useState<"Loading" | "Exclusion" | "ReducedSumAssured" | "PlanSubstitution">("Loading");
  const [loadingPct, setLoadingPct] = useState(25);
  const [revisedCoverage, setRevisedCoverage] = useState<number>(caseItem.coverage_amount ?? 0);
  const [revisedProduct, setRevisedProduct] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!caseItem.policy_id) return;
    setBusy(true); setErr(null);
    try {
      await createCounterOffer(caseItem.policy_id, {
        offer_type: offerType,
        reason: reason || undefined,
        created_by: "underwriter",
        revised_loading_pct: offerType === "Loading" ? loadingPct : undefined,
        revised_coverage_amount: offerType === "ReducedSumAssured" ? revisedCoverage : undefined,
        revised_product_name: offerType === "PlanSubstitution" ? revisedProduct : undefined,
        exclusions: offerType === "Exclusion" ? exclusions.split(",").map(s => s.trim()).filter(Boolean) : undefined,
      });
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to send counter-offer");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="bg-amber-500 px-5 py-3">
          <p className="text-white/80 text-[11px] font-semibold uppercase tracking-wider">Revised Terms</p>
          <h2 className="text-white text-lg font-bold">Send Counter-Offer</h2>
          <p className="text-white/80 text-xs">{caseItem.customer_name} · {caseItem.product_name}</p>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Type</label>
            <select value={offerType} onChange={(e) => setOfferType(e.target.value as any)}
              className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2">
              <option value="Loading">Accept with Loading</option>
              <option value="Exclusion">Exclusion</option>
              <option value="ReducedSumAssured">Reduced Sum Assured</option>
              <option value="PlanSubstitution">Plan Substitution</option>
            </select>
          </div>
          {offerType === "Loading" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Premium loading %</label>
              <input type="number" value={loadingPct} onChange={(e) => setLoadingPct(Number(e.target.value))}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          {offerType === "ReducedSumAssured" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Revised sum assured (PKR)</label>
              <input type="number" value={revisedCoverage} onChange={(e) => setRevisedCoverage(Number(e.target.value))}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          {offerType === "PlanSubstitution" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Substitute product</label>
              <input value={revisedProduct} onChange={(e) => setRevisedProduct(e.target.value)} placeholder="e.g. Health Gold"
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          {offerType === "Exclusion" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Exclusions (comma-separated)</label>
              <input value={exclusions} onChange={(e) => setExclusions(e.target.value)} placeholder="e.g. Pre-existing cardiac conditions"
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Reason</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
              className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
            <button onClick={submit} disabled={busy}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-40">
              {busy ? "Sending…" : "Send counter-offer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
