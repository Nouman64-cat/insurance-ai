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
import { runInsuranceHistory } from "@/app/services/insuranceHistory";
import { assessMedicalExam, inviteMedicalExam, MEDICAL_CLEARED } from "@/app/services/medicalExam";
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
  const isStarted = pending && pending !== "Not Started" && pending !== "NotSent" && pending !== "Draft";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wide border transition-all ${
        done
          ? "bg-emerald-50 text-emerald-700 border-emerald-200/80 shadow-2xs"
          : isStarted
          ? "bg-blue-50 text-blue-700 border-blue-200/80"
          : "bg-slate-100 text-slate-600 border-slate-200/80"
      }`}
    >
      <span className="text-[9px]">{done ? "✓" : "●"}</span>
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

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "pre-underwriting" || tab === "risk-engine") {
      setActiveTab(tab);
    }
  }, [searchParams]);

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
  const [histBusyFor, setHistBusyFor] = useState<string | null>(null);
  const [histModal, setHistModal] = useState<{ caseId: string; customerName?: string; data: any } | null>(null);
  const [medBusyFor, setMedBusyFor] = useState<string | null>(null);
  const [medModal, setMedModal] = useState<{ caseId: string; customerName?: string; data: any; link: string | null } | null>(null);
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

  // Pre-Underwriting helpers — six clearance gates must be settled before the
  // risk engine may produce a decision on the case.
  const medicalCleared = (c: CaseQueueItem) =>
    MEDICAL_CLEARED.has((c.medical_exam_status ?? "NotAssessed") as any);

  const isFullyReady = (c: CaseQueueItem) =>
    c.e_application_status === "Submitted" &&
    c.acr_status === "Submitted" &&
    c.compliance_status === "Passed" &&
    c.ipp_status === "Realized" &&
    c.insurance_history_status === "Clear" &&
    medicalCleared(c);

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
    const missingHistory = active.filter((c) => c.insurance_history_status !== "Clear").length;
    const missingMedical = active.filter((c) => !medicalCleared(c)).length;
    const ready = active.filter(isFullyReady).length;
    return {
      total: active.length, missingEApp, missingAcr, missingComp, missingIpp,
      missingHistory, missingMedical, ready,
    };
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

  const handleRunHistory = async (c: CaseQueueItem) => {
    setHistBusyFor(c.caseld);
    try {
      const res = await runInsuranceHistory(c.caseld);
      setHistModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined, data: res });
      await loadData();
    } catch (e: any) {
      alert(e?.message ?? "Insurance history check failed");
    } finally {
      setHistBusyFor(null);
    }
  };

  // One click covers the common path: read the non-medical-limit grid, and if
  // an examination is mandated, issue the customer's booking link immediately.
  const handleMedical = async (c: CaseQueueItem) => {
    setMedBusyFor(c.caseld);
    try {
      const order = await assessMedicalExam(c.caseld);
      if (order.status === "NotRequired") {
        setMedModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined, data: order, link: null });
      } else {
        const invite = await inviteMedicalExam(c.caseld);
        setMedModal({
          caseId: c.caseld,
          customerName: c.customer_name ?? undefined,
          data: order,
          link: `${window.location.origin}${invite.link_path}`,
        });
      }
      await loadData();
    } catch (e: any) {
      alert(e?.message ?? "Medical assessment failed");
    } finally {
      setMedBusyFor(null);
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
      { title: "Folders", value: folders.length, subtitle: "active customer groups", accent: "slate" as const },
      { title: "Awaiting Documents", value: pendingDocs, subtitle: "intake pending", accent: "slate" as const },
      { title: "In Underwriting", value: underReview, subtitle: "under evaluation", accent: "slate" as const },
      { title: "Approved", value: approved, subtitle: "cleared for issuance", accent: "slate" as const },
    ];
  }, [folders]);

  return (
    <div className="px-6 py-4 space-y-4 max-w-screen-2xl mx-auto w-full">


      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-xs font-semibold">
          {error}
        </div>
      )}

      {/* ── TAB 1: PRE-UNDERWRITING VERIFICATION ──────────────────────────────── */}
      {activeTab === "pre-underwriting" && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Executive 4-Card Metric Suite */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Active Proposals"
              value={preKpis.total}
              subtitle="intake pipeline total"
              accent="blue"
              icon={
                <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              }
            />
            <MetricCard
              title="Clearance In Progress"
              value={preKpis.total - preKpis.ready}
              subtitle="proposals undergoing gate checks"
              accent="amber"
              icon={
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Fully Cleared"
              value={preKpis.ready}
              subtitle="all 6 gates settled — ready for risk engine"
              accent="emerald"
              icon={
                <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Diagnostics & PEP"
              value={preKpis.missingMedical + preKpis.missingComp}
              subtitle="medical exam & sanctions pending"
              accent="purple"
              icon={
                <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              }
            />
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
                  c.insurance_history_status === "Clear",
                  medicalCleared(c),
                ].filter(Boolean).length;

                return (
                  <div
                    key={c.caseld}
                    className={`bg-white rounded-2xl border transition-all duration-300 overflow-hidden ${
                      cleared
                        ? "border-emerald-300/80 shadow-xs bg-gradient-to-b from-emerald-50/10 via-white to-white"
                        : "border-slate-200/90 shadow-xs hover:shadow-md hover:border-slate-300"
                    }`}
                  >
                    {/* Card Header */}
                    <div className="px-5 py-4 bg-slate-50/70 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="flex items-center gap-3.5">
                        <div className={`w-11 h-11 rounded-xl flex items-center justify-center font-black text-xs tracking-wider shadow-xs ${
                          cleared 
                            ? "bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-emerald-500/20" 
                            : "bg-gradient-to-br from-slate-800 to-slate-900 text-white shadow-slate-900/10"
                        }`}>
                          {c.customer_name?.slice(0, 2).toUpperCase() ?? "CA"}
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 
                              onClick={() => router.push(`/case/${c.caseld}`)}
                              className="font-bold text-slate-900 text-sm tracking-tight hover:text-blue-600 cursor-pointer transition-colors"
                            >
                              {c.customer_name}
                            </h3>
                            <span className="font-mono text-[10px] text-slate-600 bg-slate-200/70 px-2 py-0.5 rounded font-semibold border border-slate-300/50">
                              {c.caseNumber}
                            </span>
                            {c.customer_segment && (
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wider border ${SEGMENT_BADGE_STYLE[c.customer_segment]}`}>
                                {SEGMENT_LABEL[c.customer_segment]}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-slate-500 mt-1 flex-wrap">
                            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                              <span className="text-slate-400 font-sans font-medium">CNIC:</span> {c.customer_cnic ?? "—"}
                            </span>
                            <span className="text-slate-300">•</span>
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                              <span className="text-slate-400 font-medium">Product:</span> {c.product_name ?? "Standard Plan"}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Stepper Progress & Action */}
                      <div className="flex items-center gap-4 border-t md:border-t-0 pt-3 md:pt-0 border-slate-200/60">
                        <div className="flex flex-col items-end min-w-[130px]">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Gate Progress</span>
                            <span className={`text-xs font-black font-mono ${cleared ? "text-emerald-700" : "text-slate-800"}`}>
                              {stepCount}/6
                            </span>
                          </div>
                          {/* Segmented Progress Bar */}
                          <div className="flex gap-1 w-full max-w-[120px]">
                            {[1, 2, 3, 4, 5, 6].map((step) => (
                              <div
                                key={step}
                                className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                                  step <= stepCount
                                    ? cleared ? "bg-emerald-500" : "bg-blue-600"
                                    : "bg-slate-200"
                                }`}
                              />
                            ))}
                          </div>
                        </div>

                        {cleared ? (
                          <button
                            onClick={() => router.push(`/case/${c.caseld}`)}
                            className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-xs font-bold shadow-sm hover:shadow transition-all flex items-center gap-1.5 active:scale-[0.98]"
                          >
                            <span>Trigger Risk Engine</span>
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                          </button>
                        ) : (
                          <button
                            onClick={() => router.push(`/case/${c.caseld}`)}
                            className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold shadow-xs hover:shadow transition-all flex items-center gap-1.5 active:scale-[0.98]"
                          >
                            <span>View Case Detail</span>
                            <svg className="w-3.5 h-3.5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Gates Grid — 3 spacious columns per row for clean typography and no text clipping */}
                    <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {/* Gate 1: E-App */}
                      <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-blue-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                              <svg className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                              1. E-Application
                            </span>
                            <StatusPill done={c.e_application_status === "Submitted"} pending={c.e_application_status ?? "Not Sent"} label="Submitted" />
                          </div>
                          <p className="text-xs text-slate-500 mt-2 leading-relaxed">Medical disclosures &amp; applicant statements.</p>
                        </div>
                        <div className="pt-2.5 border-t border-slate-200/60">
                          <button
                            onClick={() => handleGenerateLink(c)}
                            disabled={linkBusyFor === c.caseld}
                            className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-blue-700 font-bold text-xs rounded-lg border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
                          >
                            {linkBusyFor === c.caseld ? "Generating Link…" : c.e_application_status && c.e_application_status !== "NotSent" ? "Resend Link" : "Generate Link"}
                          </button>
                          {generatedLinks[c.caseld] && (
                            <div className="mt-2 flex items-center gap-1 animate-in fade-in duration-200">
                              <input readOnly value={generatedLinks[c.caseld]} onFocus={(e) => e.currentTarget.select()} className="text-[10px] border border-slate-200 rounded px-2 py-1 w-full font-mono text-slate-600 bg-white shadow-inner" />
                              <button onClick={() => navigator.clipboard.writeText(generatedLinks[c.caseld])} className="text-[10px] font-bold text-blue-700 px-2 py-1 bg-blue-50 border border-blue-200/60 rounded shrink-0 hover:bg-blue-100 transition-colors">Copy</button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Gate 2: ACR */}
                      <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-blue-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                              <svg className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>
                              2. Agent's ACR
                            </span>
                            <StatusPill done={c.acr_status === "Submitted"} pending={c.acr_status ?? "Not Started"} label="Submitted" />
                          </div>
                          <p className="text-xs text-slate-500 mt-2 leading-relaxed">Moral hazard &amp; financial standing report.</p>
                        </div>
                        <div className="pt-2.5 border-t border-slate-200/60">
                          {c.acr_status !== "Submitted" ? (
                            <button
                              disabled={!canFileAcr || acrLoadingFor === c.caseld}
                              onClick={() => openAcrModal(c)}
                              className={`w-full py-2 px-3 bg-white hover:bg-slate-100 font-bold text-xs rounded-lg border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5 ${
                                !canFileAcr ? "text-slate-400 opacity-50 cursor-not-allowed" : "text-blue-700"
                              }`}
                            >
                              {acrLoadingFor === c.caseld ? "Loading…" : c.acr_status === "Draft" ? "Continue ACR" : "File ACR"}
                            </button>
                          ) : (
                            <div className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/80 flex items-center justify-center gap-1">
                              <span>✓</span>
                              <span>Report Filed</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Gate 3: PEP & Sanctions */}
                      <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-blue-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                              <svg className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                              3. PEP / Sanctions
                            </span>
                            <StatusPill done={c.compliance_status === "Passed"} pending={c.compliance_status ?? "Not Started"} label="Passed" />
                          </div>
                          <p className="text-xs text-slate-500 mt-2 leading-relaxed">OpenSanctions &amp; SECP screening check.</p>
                        </div>
                        <div className="pt-2.5 border-t border-slate-200/60 flex items-center justify-between">
                          <button
                            onClick={() => handleRunCompliance(c)}
                            disabled={compBusyFor === c.caseld}
                            className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-blue-700 font-bold text-xs rounded-lg border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
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
                      <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-blue-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                              <svg className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                              4. IPP Clearance
                            </span>
                            <StatusPill done={c.ipp_status === "Realized"} pending={c.ipp_status ?? "Not Started"} label="Cleared" />
                          </div>
                          <p className="text-xs text-slate-500 mt-2 leading-relaxed">Section 30 payment requirement.</p>
                        </div>
                        <div className="pt-2.5 border-t border-slate-200/60">
                          {c.ipp_status !== "Realized" ? (
                            <button
                              onClick={() => setIppModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined })}
                              className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-blue-700 font-bold text-xs rounded-lg border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5"
                            >
                              {c.ipp_status === "Initiated" ? "Complete Payment" : "Collect Payment"}
                            </button>
                          ) : (
                            <div className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/80 flex items-center justify-center gap-1">
                              <span>✓</span>
                              <span>Premium Realized</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Gate 5: Insurance History */}
                      <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-blue-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                              <svg className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
                              5. Insurance History
                            </span>
                            <StatusPill done={c.insurance_history_status === "Clear"} pending={c.insurance_history_status ?? "Not Started"} label="Clear" />
                          </div>
                          <p className="text-xs text-slate-500 mt-2 leading-relaxed">Prior &amp; other-insurer cover, over-insurance, replacement.</p>
                        </div>
                        <div className="pt-2.5 border-t border-slate-200/60">
                          <button
                            onClick={() => handleRunHistory(c)}
                            disabled={histBusyFor === c.caseld}
                            className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-blue-700 font-bold text-xs rounded-lg border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
                          >
                            {histBusyFor === c.caseld ? (
                              <>
                                <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                                <span>Checking…</span>
                              </>
                            ) : (
                              <span>{c.insurance_history_status && c.insurance_history_status !== "NotStarted" ? "Re-check History" : "Run History Check"}</span>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Gate 6: Medical Examination */}
                      <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-blue-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                              <svg className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg>
                              6. Medical Exam
                            </span>
                            <StatusPill done={medicalCleared(c)} pending={c.medical_exam_status ?? "Not Assessed"} label={c.medical_exam_status === "NotRequired" ? "Within NML" : "Completed"} />
                          </div>
                          <p className="text-xs text-slate-500 mt-2 leading-relaxed">Non-medical limit grid &amp; panel-clinic diagnostics.</p>
                        </div>
                        <div className="pt-2.5 border-t border-slate-200/60">
                          {medicalCleared(c) ? (
                            <div className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/80 flex items-center justify-center gap-1">
                              <span>✓</span>
                              <span>{c.medical_exam_status === "NotRequired" ? "No Exam Required" : c.medical_exam_status === "Waived" ? "Waived" : "Results Received"}</span>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleMedical(c)}
                              disabled={medBusyFor === c.caseld}
                              className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-blue-700 font-bold text-xs rounded-lg border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
                            >
                              {medBusyFor === c.caseld ? (
                                <>
                                  <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                                  <span>Applying NML…</span>
                                </>
                              ) : (
                                <span>
                                  {c.medical_exam_status === "Scheduled" ? "View Appointment"
                                    : c.medical_exam_status === "Invited" ? "Resend Booking Link"
                                    : c.medical_exam_status === "Required" ? "Invite for Checkup"
                                    : "Apply NML Grid"}
                                </span>
                              )}
                            </button>
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

      {/* Insurance History Results Modal */}
      {histModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">Insurance History Screen</h3>
                <p className="text-xs text-slate-500">{histModal.customerName ?? histModal.caseId}</p>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                histModal.data.status === "Clear" ? "bg-emerald-100 text-emerald-800 border border-emerald-200" :
                histModal.data.status === "Flagged" ? "bg-amber-100 text-amber-800 border border-amber-200" :
                "bg-red-100 text-red-800 border border-red-200"
              }`}>
                {histModal.data.status}
              </span>
            </div>
            <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Aggregate cover</p>
                  <p className="font-bold text-slate-800 mt-0.5">{fmtCoverage(histModal.data.aggregate_sum_assured)}</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Human Life Value cap</p>
                  <p className="font-bold text-slate-800 mt-0.5">
                    {histModal.data.hlv_limit != null ? fmtCoverage(histModal.data.hlv_limit) : "Unknown — no income"}
                    {histModal.data.hlv_ratio != null && (
                      <span className={`ml-1.5 font-mono text-[10px] ${histModal.data.hlv_ratio > 1 ? "text-red-600" : "text-emerald-600"}`}>
                        {histModal.data.hlv_ratio}×
                      </span>
                    )}
                  </p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">This insurer, in force</p>
                  <p className="font-bold text-slate-800 mt-0.5">{fmtCoverage(histModal.data.internal_inforce_sum_assured)}</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Other insurers, declared</p>
                  <p className="font-bold text-slate-800 mt-0.5">{fmtCoverage(histModal.data.external_declared_sum_assured)}</p>
                </div>
              </div>

              <div className="space-y-1.5">
                {(histModal.data.findings ?? []).map((f: any, i: number) => (
                  <div key={i} className={`border-l-2 pl-2.5 py-1 text-[11px] ${
                    f.severity === "critical" ? "border-red-400 text-red-800"
                      : f.severity === "warning" ? "border-amber-400 text-amber-800"
                      : "border-slate-300 text-slate-600"
                  }`}>
                    {f.message}
                  </div>
                ))}
              </div>

              {(histModal.data.internal_policies?.length > 0 || histModal.data.external_policies?.length > 0) && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 text-slate-400 uppercase tracking-wider font-bold text-[9px]">
                      <tr>
                        <th className="px-2.5 py-1.5 text-left">Insurer</th>
                        <th className="px-2.5 py-1.5 text-left">Product</th>
                        <th className="px-2.5 py-1.5 text-right">Sum Assured</th>
                        <th className="px-2.5 py-1.5 text-left">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {[...(histModal.data.internal_policies ?? []), ...(histModal.data.external_policies ?? [])].map((p: any, i: number) => (
                        <tr key={i}>
                          <td className="px-2.5 py-1.5 text-slate-700 font-medium">{p.insurer}</td>
                          <td className="px-2.5 py-1.5 text-slate-500">{p.product ?? "—"}</td>
                          <td className="px-2.5 py-1.5 text-right font-mono text-slate-700">{fmtCoverage(p.sum_assured)}</td>
                          <td className="px-2.5 py-1.5 text-slate-500">{p.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex justify-between items-center">
              <button onClick={() => router.push(`/case/${histModal.caseId}`)} className="text-xs font-semibold text-blue-600 hover:text-blue-700">
                Open case to clear or reject →
              </button>
              <button onClick={() => setHistModal(null)} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Medical Examination Modal */}
      {medModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">Medical Requirement — Non-Medical Limit</h3>
                <p className="text-xs text-slate-500">{medModal.customerName ?? medModal.caseId}</p>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                medModal.data.status === "NotRequired"
                  ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                  : "bg-amber-100 text-amber-800 border border-amber-200"
              }`}>
                {medModal.data.status}
              </span>
            </div>
            <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto text-xs">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Sum at risk</p>
                  <p className="font-bold text-slate-800 mt-0.5">{fmtCoverage(medModal.data.sum_assured_at_risk)}</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Non-medical limit (age {medModal.data.applicant_age ?? "—"})</p>
                  <p className="font-bold text-slate-800 mt-0.5">
                    {medModal.data.non_medical_limit != null ? fmtCoverage(medModal.data.non_medical_limit) : "—"}
                  </p>
                </div>
              </div>

              {(medModal.data.trigger_reasons ?? []).length > 0 && (
                <div className="space-y-1">
                  {medModal.data.trigger_reasons.map((r: string, i: number) => (
                    <p key={i} className="border-l-2 border-amber-400 pl-2.5 py-1 text-[11px] text-amber-800">{r}</p>
                  ))}
                </div>
              )}

              {medModal.data.status === "NotRequired" ? (
                <p className="text-slate-600 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  This proposal is within the non-medical limit — it can be underwritten on the
                  E-Application alone. No panel examination is needed.
                </p>
              ) : (
                <>
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="bg-slate-50 px-3 py-2 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                        Mandated panel — {(medModal.data.required_tests ?? []).length} tests
                      </span>
                      <span className="text-[11px] font-bold text-slate-700 font-mono">
                        PKR {Math.round(medModal.data.estimated_cost ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <ul className="divide-y divide-slate-50">
                      {(medModal.data.required_tests ?? []).map((t: any) => (
                        <li key={t.code} className="px-3 py-1.5 flex items-center justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-800 text-[11px]">{t.name}</p>
                            <p className="text-[10px] text-slate-400">{t.category}</p>
                          </div>
                          {t.fasting && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 shrink-0">
                              FASTING
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {medModal.link && (
                    <div>
                      <p className="text-[11px] text-slate-500 mb-1">
                        Send this link to the customer — they pick a panel clinic and an appointment slot:
                      </p>
                      <div className="flex items-center gap-1.5">
                        <input readOnly value={medModal.link} onFocus={(e) => e.currentTarget.select()}
                          className="text-[10px] border border-slate-200 rounded px-2 py-1.5 w-full font-mono text-slate-600 bg-white" />
                        <button onClick={() => navigator.clipboard.writeText(medModal.link!)}
                          className="text-[10px] font-bold text-blue-700 px-2.5 py-1.5 bg-blue-50 border border-blue-200/60 rounded shrink-0 hover:bg-blue-100">
                          Copy
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex justify-between items-center">
              <button onClick={() => router.push(`/case/${medModal.caseId}`)} className="text-xs font-semibold text-blue-600 hover:text-blue-700">
                Open case to book or record results →
              </button>
              <button onClick={() => setMedModal(null)} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold">
                Close
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
