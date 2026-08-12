"use client";

import React, { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { SegmentDropdown, SegmentFilter, SEGMENT_LABEL, SEGMENT_BADGE_STYLE } from "@/components/SegmentDropdown";
import { useNotify } from "@/components/NotificationContext";
import { fmtCoverage } from "@/lib/mock-data";
import { listCases, runCaseCompliance, clearComplianceCheck, type CaseQueueItem } from "@/app/services/cases";
import { getEApplication, inviteEApplication, type EApplication } from "@/app/services/eApplication";
import { getACR, type AgentConfidentialReport } from "@/app/services/agentConfidentialReport";
import { ACRModal } from "@/components/entities/ACRModal";
import { IPPModal } from "@/components/entities/IPPModal";
import CustomizeEAppModal from "@/components/entities/CustomizeEAppModal";
import VerifyEAppModal from "@/components/entities/VerifyEAppModal";
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

function StatusPill({ done, pending, label, locked }: { done: boolean; pending: string; label: string; locked?: boolean }) {
  if (locked) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wide bg-slate-100 text-slate-400 border border-slate-200/80">
        <span className="text-[9px]">🔒</span>
        <span>Locked</span>
      </span>
    );
  }

  const isVerified = pending === "Verified" || done;
  const isSubmitted = pending === "Submitted";
  const isStarted = pending && pending !== "Not Started" && pending !== "NotSent" && pending !== "Draft" && pending !== "NotStarted";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wide border transition-all ${isVerified
          ? "bg-emerald-50 text-emerald-700 border-emerald-200/80 shadow-2xs"
          : isSubmitted
            ? "bg-amber-50 text-amber-800 border-amber-300 shadow-2xs animate-pulse"
            : isStarted
              ? "bg-blue-50 text-blue-700 border-blue-200/80"
              : "bg-slate-100 text-slate-600 border-slate-200/80"
        }`}
    >
      <span className="text-[9px]">{isVerified ? "✓" : isSubmitted ? "●" : "○"}</span>
      <span>{isVerified ? label : isSubmitted ? "Submitted (Needs Review)" : pending}</span>
    </span>
  );
}

function GateStepItem({ step, isLast, isExpanded, onToggle }: { step: any; isLast: boolean; isExpanded: boolean; onToggle: () => void }) {

  return (
    <div className={`relative flex gap-4 transition-all duration-300 group ${isExpanded ? "pb-6" : "pb-2"} last:pb-1`}>
      {/* Continuous Vertical Progress Line Track */}
      {!isLast && (
        <div
          className={`absolute top-8 left-[17px] -ml-px w-0.5 h-[calc(100%-20px)] transition-colors duration-300 ${
            step.isDone
              ? "bg-emerald-500"
              : step.isNextActive
              ? "bg-gradient-to-b from-blue-500 to-slate-200"
              : "bg-slate-200"
          }`}
        />
      )}

      {/* Progress Node Circle */}
      <div 
        className="relative z-10 shrink-0 cursor-pointer transition-transform active:scale-95"
        onClick={onToggle}
      >
        {step.isDone ? (
          <div className="w-9 h-9 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs font-bold shadow-md shadow-emerald-600/20 ring-4 ring-emerald-50">
            ✓
          </div>
        ) : step.isNextActive ? (
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 text-white flex items-center justify-center text-xs font-bold shadow-md shadow-blue-600/25 ring-4 ring-blue-100 animate-pulse">
            {step.num}
          </div>
        ) : (
          <div className="w-9 h-9 rounded-full bg-slate-100 text-slate-400 border border-slate-200 flex items-center justify-center text-xs font-bold">
            {step.isLocked ? "🔒" : step.num}
          </div>
        )}
      </div>

      {/* Step Content Container Row */}
      <div
        className={`flex-1 rounded-xl border transition-all duration-300 overflow-hidden ${
          step.isDone
            ? "bg-emerald-50/30 border-emerald-200/80 hover:border-emerald-300"
            : step.isNextActive
            ? "bg-white border-blue-300/90 shadow-xs ring-1 ring-blue-200/50"
            : "bg-slate-50/50 border-slate-200/70 opacity-75 hover:opacity-100"
        }`}
      >
        <div 
          className={`cursor-pointer flex flex-col justify-center transition-all duration-300 ${isExpanded ? "p-3.5" : "px-3.5 py-2"}`}
          onClick={onToggle}
        >
          <div className="flex items-center justify-between gap-2 select-none pr-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h4
                className={`font-bold tracking-tight transition-colors ${
                  isExpanded ? "text-xs" : "text-[11px]"
                } ${
                  step.isDone
                    ? "text-emerald-950"
                    : step.isNextActive
                    ? "text-blue-950"
                    : "text-slate-600"
                }`}
              >
                Gate {step.num}: {step.title}
              </h4>
              
              <span className={`text-[10px] text-slate-400 font-mono transition-all duration-300 hidden sm:inline-block ${isExpanded ? "opacity-100 max-w-full ml-1" : "opacity-0 max-w-0 overflow-hidden m-0"}`}>
                • {step.law}
              </span>
              
              <div className="scale-95 sm:scale-100 ml-1">
                {step.badge}
              </div>
            </div>
            
            <div 
              className={`shrink-0 p-1 rounded-full hover:bg-black/5 transition-colors ${
                isExpanded ? "text-slate-500" : "text-slate-400"
              }`}
            >
              <svg
                className={`w-4 h-4 transition-transform duration-300 ${
                  isExpanded ? "rotate-180" : ""
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
          
          <div 
            className={`grid transition-[grid-template-rows,opacity,margin] duration-300 ease-in-out ${
              isExpanded ? "grid-rows-[1fr] opacity-100 mt-3" : "grid-rows-[0fr] opacity-0 mt-0"
            }`}
          >
            <div className="overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p className="text-xs text-slate-500 leading-relaxed">
                  {step.desc}
                </p>
                <div 
                  className="shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {step.action}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UnderwritingMainContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { notify } = useNotify();

  const initialTab = (searchParams.get("tab") as "pre-underwriting" | "risk-engine") || "pre-underwriting";

  const [activeTab, setActiveTab] = useState<"pre-underwriting" | "risk-engine">(initialTab);
  const [cases, setCases] = useState<CaseQueueItem[]>([]);
  const [expandedGates, setExpandedGates] = useState<Record<string, number>>({});
  const [showAllGates, setShowAllGates] = useState<Record<string, boolean>>({});

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

  const [forceProceedBusy, setForceProceedBusy] = useState(false);

  const handleForceProceedCompliance = async (checks: any[]) => {
    setForceProceedBusy(true);
    try {
      const flaggedChecks = checks.filter(c => c.status === "Flagged");
      for (const chk of flaggedChecks) {
        await clearComplianceCheck(tenantId, chk.id);
      }
      setCompModal(null);
      await loadData();
      notify("Compliance check override successful", true);
    } catch (e: any) {
      notify(e?.message ?? "Failed to force proceed", false);
    } finally {
      setForceProceedBusy(false);
    }
  };

  const [histBusyFor, setHistBusyFor] = useState<string | null>(null);
  const [histModal, setHistModal] = useState<{ caseId: string; customerName?: string; data: any } | null>(null);
  const [medBusyFor, setMedBusyFor] = useState<string | null>(null);
  const [medModal, setMedModal] = useState<{ caseId: string; customerName?: string; data: any; link: string | null } | null>(null);
  const [acrModal, setAcrModal] = useState<{ caseId: string; initial: AgentConfidentialReport | null } | null>(null);
  const [acrLoadingFor, setAcrLoadingFor] = useState<string | null>(null);
  const [ippModal, setIppModal] = useState<{ caseId: string; customerName?: string } | null>(null);
  const [customizeModal, setCustomizeModal] = useState<{ caseId: string; customerName?: string } | null>(null);
  const [verifyModal, setVerifyModal] = useState<{ caseId: string; customerName?: string; eApp: EApplication } | null>(null);
  const [verifyLoadingFor, setVerifyLoadingFor] = useState<string | null>(null);

  const handleOpenVerifyModal = async (c: CaseQueueItem) => {
    setVerifyLoadingFor(c.caseld);
    try {
      const eApp = await getEApplication(c.caseld);
      setVerifyModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined, eApp });
    } catch (e: any) {
      notify(e?.message || "Failed to fetch customer E-Application details", false);
    } finally {
      setVerifyLoadingFor(null);
    }
  };

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
    (c.e_application_status === "Verified" || c.e_application_status === "Submitted") &&
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
    const missingEApp = active.filter((c) => c.e_application_status !== "Verified" && c.e_application_status !== "Submitted").length;
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
      notify("E-Application link generated successfully", true);
    } catch (e: any) {
      setLinkErr(e?.message ?? "Failed to generate link");
      notify(e?.message ?? "Failed to generate link", false);
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
      notify("Compliance check processed", true);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? e?.message ?? "Compliance check failed", false);
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
      notify("Insurance history verification completed", true);
    } catch (e: any) {
      notify(e?.message ?? "Insurance history check failed", false);
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
      notify(order.status === "NotRequired" ? "Medical assessment completed: Not Required" : "Medical assessment completed: Referral Generated", true);
    } catch (e: any) {
      notify(e?.message ?? "Medical assessment failed", false);
    } finally {
      setMedBusyFor(null);
    }
  };

  const openAcrModal = async (c: CaseQueueItem) => {
    setAcrLoadingFor(c.caseld);
    try {
      const acr = await getACR(c.caseld);
      setAcrModal({ caseId: c.caseld, initial: acr.status === "NotStarted" ? null : acr });
    } catch (e: any) {
      notify("Failed to fetch Agent Confidential Report", false);
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
              accent="sky"
              icon={
                <svg className="w-5 h-5 text-sky-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
              accent="blue"
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
                const g1Done = c.e_application_status === "Verified";
                const g2Done = c.acr_status === "Submitted";
                const g3Done = c.compliance_status === "Passed";
                const g4Done = c.ipp_status === "Realized";
                const g5Done = c.insurance_history_status === "Clear";
                const g6Done = medicalCleared(c);

                const stepCount = [
                  g1Done,
                  g2Done,
                  g3Done,
                  g4Done,
                  g5Done,
                  g6Done,
                ].filter(Boolean).length;

                return (
                  <div
                    key={c.caseld}
                    className={`bg-white rounded-2xl border transition-all duration-300 overflow-hidden ${cleared
                        ? "border-emerald-300/80 shadow-xs bg-gradient-to-b from-emerald-50/10 via-white to-white"
                        : "border-slate-200/90 shadow-xs hover:shadow-md hover:border-slate-300"
                      }`}
                  >
                    {/* Card Header */}
                    <div className="px-5 py-4 bg-slate-50/70 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="flex items-center gap-3.5">
                        <div className={`w-11 h-11 rounded-xl flex items-center justify-center font-black text-xs tracking-wider shadow-xs ${cleared
                            ? "bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-emerald-500/20"
                            : "bg-gradient-to-br from-blue-700 to-indigo-800 text-white shadow-blue-900/10"
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
                                className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${step <= stepCount
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
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                          </button>
                        ) : (
                          <button
                            onClick={() => router.push(`/case/${c.caseld}`)}
                            className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold shadow-xs hover:shadow transition-all flex items-center gap-1.5 active:scale-[0.98]"
                          >
                            <span>View Case Detail</span>
                            <svg className="w-3.5 h-3.5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Pre-Underwriting Operational Progression Timeline — Vertical Progress Lines */}
                    {(() => {
                      const g1Done = c.e_application_status === "Verified";
                      const g1Submitted = c.e_application_status === "Submitted";
                      const g2Unlocked = g1Done;
                      const g2Done = c.acr_status === "Submitted";
                      const g3Unlocked = g2Done;
                      const g3Done = c.compliance_status === "Passed";
                      const g4Unlocked = g3Done;
                      const g4Done = c.ipp_status === "Realized";
                      const g5Unlocked = g4Done;
                      const g5Done = c.insurance_history_status === "Clear";
                      const g6Unlocked = g5Done;
                      const g6Done = medicalCleared(c);

                      const canFileAcr = g1Done;

                      const gateSteps = [
                        {
                          num: 1,
                          title: "E-Application Verification",
                          law: "Medical Disclosures & Declarations",
                          desc: "Digital e-application verification & applicant medical disclosure.",
                          isDone: g1Done,
                          isLocked: false,
                          isNextActive: !g1Done,
                          badge: <StatusPill done={g1Done} pending={c.e_application_status ?? "NotSent"} label="Verified" />,
                          action: g1Done ? (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                                <span>✓ Verified</span>
                              </span>
                              <button
                                onClick={() => handleOpenVerifyModal(c)}
                                className="text-[11px] font-bold text-blue-800 hover:text-blue-950 underline px-2.5 py-1 bg-blue-50/80 rounded-lg border border-blue-200/80"
                              >
                                View Form →
                              </button>
                            </div>
                          ) : g1Submitted ? (
                            <button
                              onClick={() => handleOpenVerifyModal(c)}
                              disabled={verifyLoadingFor === c.caseld}
                              className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5"
                            >
                              {verifyLoadingFor === c.caseld ? "Loading Details…" : "👁️ Review & Verify Submission →"}
                            </button>
                          ) : (
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => setCustomizeModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined })}
                                className="px-2.5 py-1 bg-white hover:bg-slate-100 text-slate-700 font-semibold text-xs rounded-lg border border-slate-200 shadow-2xs transition-all flex items-center gap-1"
                              >
                                <span>⚙️ Customize</span>
                              </button>
                              <button
                                onClick={() => handleGenerateLink(c)}
                                disabled={linkBusyFor === c.caseld}
                                className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5 disabled:opacity-50"
                              >
                                {linkBusyFor === c.caseld ? "Generating…" : c.e_application_status && c.e_application_status !== "NotSent" ? "Resend Link" : "Generate & Send Link"}
                              </button>
                              {generatedLinks[c.caseld] && (
                                <div className="flex items-center gap-1">
                                  <input readOnly value={generatedLinks[c.caseld]} onFocus={(e) => e.currentTarget.select()} className="text-[10px] border border-slate-200 rounded px-2 py-1 max-w-[120px] font-mono text-slate-600 bg-white" />
                                  <button onClick={() => navigator.clipboard.writeText(generatedLinks[c.caseld])} className="text-[10px] font-bold text-blue-700 px-2 py-1 bg-blue-50 border border-blue-200/60 rounded hover:bg-blue-100">Copy</button>
                                </div>
                              )}
                            </div>
                          ),
                        },
                        {
                          num: 2,
                          title: "Agent's Confidential Report (ACR)",
                          law: "Moral Hazard & Financial Standing",
                          desc: !g2Unlocked ? "Requires completion of Gate 1: E-App Verification before proceeding." : "Moral hazard, KYC witness, and financial standing report submitted by field agent.",
                          isDone: g2Done,
                          isLocked: !g2Unlocked,
                          isNextActive: g2Unlocked && !g2Done,
                          badge: !g2Unlocked ? null : <StatusPill done={g2Done} pending={c.acr_status ?? "Not Started"} label="Submitted" />,
                          action: !g2Unlocked ? (
                            <span className="text-xs text-slate-400 font-medium italic">Prerequisite: Complete Gate 1 first</span>
                          ) : g2Done ? (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                                <span>✓ Report Filed</span>
                              </span>
                              <button
                                onClick={() => openAcrModal(c)}
                                className="text-[11px] font-bold text-blue-800 hover:text-blue-950 underline px-2 py-1 bg-blue-50/80 rounded-lg border border-blue-200/80"
                              >
                                View ACR →
                              </button>
                            </div>
                          ) : (
                            <button
                              disabled={!canFileAcr || acrLoadingFor === c.caseld}
                              onClick={() => openAcrModal(c)}
                              className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5 disabled:opacity-50"
                            >
                              {acrLoadingFor === c.caseld ? "Loading…" : c.acr_status === "Draft" ? "Continue ACR →" : "File ACR →"}
                            </button>
                          ),
                        },
                        {
                          num: 3,
                          title: "PEP / Sanctions Screening",
                          law: "OpenSanctions & SECP AML Rules",
                          desc: !g3Unlocked ? "Requires completion of Gate 2: ACR Submission before proceeding." : "Anti-money laundering, PEP watchlist, and UN/NACTA sanctions screening check.",
                          isDone: g3Done,
                          isLocked: !g3Unlocked,
                          isNextActive: g3Unlocked && !g3Done,
                          badge: !g3Unlocked ? null : <StatusPill done={g3Done} pending={c.compliance_status ?? "Not Started"} label="Passed" />,
                          action: !g3Unlocked ? (
                            <span className="text-xs text-slate-400 font-medium italic">Prerequisite: Complete Gate 2 first</span>
                          ) : g3Done ? (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                                <span>✓ Screening Passed</span>
                              </span>
                              <button
                                onClick={() => handleRunCompliance(c)}
                                disabled={compBusyFor === c.caseld}
                                className="text-[11px] font-bold text-blue-800 hover:text-blue-950 underline px-2 py-1 bg-blue-50/80 rounded-lg border border-blue-200/80"
                              >
                                Re-Screen →
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleRunCompliance(c)}
                              disabled={compBusyFor === c.caseld}
                              className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5 disabled:opacity-50"
                            >
                              {compBusyFor === c.caseld ? (
                                <>
                                  <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                  <span>Screening…</span>
                                </>
                              ) : (
                                <span>{c.compliance_status && c.compliance_status !== "NotStarted" ? "Re-Screen PEP →" : "Run Screening →"}</span>
                              )}
                            </button>
                          ),
                        },
                        {
                          num: 4,
                          title: "Initial Premium Payment (IPP)",
                          law: "Section 30 Insurance Act 1938",
                          desc: !g4Unlocked ? "Requires completion of Gate 3: PEP Screening before proceeding." : "Section 30 statutory advance payment requirement & premium realization verification.",
                          isDone: g4Done,
                          isLocked: !g4Unlocked,
                          isNextActive: g4Unlocked && !g4Done,
                          badge: !g4Unlocked ? null : <StatusPill done={g4Done} pending={c.ipp_status ?? "Not Started"} label="Cleared" />,
                          action: !g4Unlocked ? (
                            <span className="text-xs text-slate-400 font-medium italic">Prerequisite: Complete Gate 3 first</span>
                          ) : g4Done ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                              <span>✓ Premium Realized</span>
                            </span>
                          ) : (
                            <button
                              onClick={() => setIppModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined })}
                              className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5"
                            >
                              <span>{c.ipp_status === "Initiated" ? "Complete Payment →" : "Collect Payment →"}</span>
                            </button>
                          ),
                        },
                        {
                          num: 5,
                          title: "Industry Insurance History",
                          law: "CII Shared Database Standard",
                          desc: !g5Unlocked ? "Requires completion of Gate 4: IPP Clearance before proceeding." : "Prior and other-insurer cover verification, cumulative exposure, over-insurance, and replacement.",
                          isDone: g5Done,
                          isLocked: !g5Unlocked,
                          isNextActive: g5Unlocked && !g5Done,
                          badge: !g5Unlocked ? null : <StatusPill done={g5Done} pending={c.insurance_history_status ?? "Not Started"} label="Clear" />,
                          action: !g5Unlocked ? (
                            <span className="text-xs text-slate-400 font-medium italic">Prerequisite: Complete Gate 4 first</span>
                          ) : g5Done ? (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                                <span>✓ History Clear</span>
                              </span>
                              <button
                                onClick={() => handleRunHistory(c)}
                                disabled={histBusyFor === c.caseld}
                                className="text-[11px] font-bold text-blue-800 hover:text-blue-950 underline px-2 py-1 bg-blue-50/80 rounded-lg border border-blue-200/80"
                              >
                                Re-check →
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleRunHistory(c)}
                              disabled={histBusyFor === c.caseld}
                              className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5 disabled:opacity-50"
                            >
                              {histBusyFor === c.caseld ? (
                                <>
                                  <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                  <span>Checking…</span>
                                </>
                              ) : (
                                <span>{c.insurance_history_status && c.insurance_history_status !== "NotStarted" ? "Re-check History →" : "Run History Check →"}</span>
                              )}
                            </button>
                          ),
                        },
                        {
                          num: 6,
                          title: "Medical Examination & NML",
                          law: "Non-Medical Limit Matrix",
                          desc: !g6Unlocked ? "Requires completion of Gate 5: Insurance History Check before proceeding." : "Non-medical limit grid verification and panel-clinic diagnostics appointment.",
                          isDone: g6Done,
                          isLocked: !g6Unlocked,
                          isNextActive: g6Unlocked && !g6Done,
                          badge: !g6Unlocked ? null : <StatusPill done={g6Done} pending={c.medical_exam_status ?? "Not Assessed"} label={c.medical_exam_status === "NotRequired" ? "Within NML" : "Completed"} />,
                          action: !g6Unlocked ? (
                            <span className="text-xs text-slate-400 font-medium italic">Prerequisite: Complete Gate 5 first</span>
                          ) : g6Done ? (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                                <span>✓ {c.medical_exam_status === "NotRequired" ? "No Exam Required" : c.medical_exam_status === "Waived" ? "Waived" : "Results Received"}</span>
                              </span>
                              <button
                                onClick={() => handleMedical(c)}
                                disabled={medBusyFor === c.caseld}
                                className="text-[11px] font-bold text-blue-800 hover:text-blue-950 underline px-2 py-1 bg-blue-50/80 rounded-lg border border-blue-200/80"
                              >
                                Re-Apply NML →
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleMedical(c)}
                              disabled={medBusyFor === c.caseld}
                              className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5 disabled:opacity-50"
                            >
                              {medBusyFor === c.caseld ? (
                                <>
                                  <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                  <span>Applying NML…</span>
                                </>
                              ) : (
                                <span>
                                  {c.medical_exam_status === "Scheduled"
                                    ? "View Appointment →"
                                    : c.medical_exam_status === "Invited"
                                    ? "Resend Booking Link →"
                                    : c.medical_exam_status === "Required"
                                    ? "Invite for Checkup →"
                                    : "Apply NML Grid →"}
                                </span>
                              )}
                            </button>
                          ),
                        },
                      ];

                      return (
                        <div className="p-6">
                          <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                                Operational Progression Timeline
                              </span>
                              <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-200/60 font-mono">
                                Sequential Gating 1 → 6
                              </span>
                            </div>
                            <span className="text-xs text-slate-500">
                              Completed <strong className="text-slate-900 font-mono">{stepCount}</strong> of 6 verification milestones
                            </span>
                          </div>

                          <div className="relative pl-2">
                            {(() => {
                              const isShowingAll = showAllGates[c.caseld] || false;
                              const defaultActive = gateSteps.find(s => s.isNextActive)?.num || gateSteps[gateSteps.length - 1].num;
                              const activeNum = expandedGates[c.caseld] !== undefined ? expandedGates[c.caseld] : defaultActive;
                              const visibleSteps = isShowingAll ? gateSteps : [gateSteps.find(s => s.num === defaultActive) || gateSteps[0]];
                              
                              return (
                                <>
                                  {!isShowingAll && defaultActive > 1 && (
                                    <div 
                                      className="relative flex gap-4 transition-all duration-300 pb-2 cursor-pointer group"
                                      onClick={() => setShowAllGates(prev => ({ ...prev, [c.caseld]: true }))}
                                    >
                                      <div className="absolute top-8 left-[17px] -ml-px w-0.5 h-[calc(100%-20px)] bg-emerald-500" />
                                      <div className="relative z-10 shrink-0 w-9 h-9 rounded-full bg-slate-50 text-slate-400 border border-slate-200 flex items-center justify-center text-xs font-bold group-hover:bg-emerald-50 group-hover:text-emerald-600 group-hover:border-emerald-200 transition-colors shadow-sm">
                                        <span className="tracking-[0.1em] -ml-0.5">•••</span>
                                      </div>
                                      <div className="flex-1 flex flex-col justify-center">
                                        <span className="text-[11px] font-semibold text-slate-400 group-hover:text-emerald-600 transition-colors">
                                          Show {defaultActive - 1} previous stage{defaultActive - 1 > 1 ? "s" : ""}
                                        </span>
                                      </div>
                                    </div>
                                  )}

                                  {visibleSteps.map((step, idx) => {
                                    const isLast = isShowingAll ? false : defaultActive === gateSteps.length;
                                    return (
                                      <GateStepItem 
                                        key={step.num} 
                                        step={step} 
                                        isLast={isLast} 
                                        isExpanded={activeNum === step.num}
                                        onToggle={() => {
                                          setExpandedGates(prev => ({
                                            ...prev,
                                            [c.caseld]: prev[c.caseld] === step.num ? -1 : step.num
                                          }));
                                        }}
                                      />
                                    );
                                  })}

                                  {!isShowingAll && defaultActive < gateSteps.length && (
                                    <div 
                                      className="relative flex gap-4 transition-all duration-300 pb-2 pt-1 cursor-pointer group"
                                      onClick={() => setShowAllGates(prev => ({ ...prev, [c.caseld]: true }))}
                                    >
                                      <div className="relative z-10 shrink-0 w-9 h-9 rounded-full bg-slate-50 text-slate-400 border border-slate-200 flex items-center justify-center text-xs font-bold group-hover:bg-slate-100 group-hover:text-slate-600 group-hover:border-slate-300 transition-colors shadow-sm">
                                        <span className="tracking-[0.1em] -ml-0.5">•••</span>
                                      </div>
                                      <div className="flex-1 flex flex-col justify-center">
                                        <span className="text-[11px] font-semibold text-slate-400 group-hover:text-slate-600 transition-colors">
                                          Show {gateSteps.length - defaultActive} remaining stage{gateSteps.length - defaultActive > 1 ? "s" : ""}
                                        </span>
                                      </div>
                                    </div>
                                  )}

                                  {isShowingAll && (
                                    <div 
                                      className="relative flex gap-4 transition-all duration-300 pb-2 pt-1 cursor-pointer group"
                                      onClick={() => setShowAllGates(prev => ({ ...prev, [c.caseld]: false }))}
                                    >
                                      <div className="relative z-10 shrink-0 w-9 h-9 rounded-full bg-slate-50 text-slate-500 border border-slate-200 flex items-center justify-center text-xs font-bold group-hover:bg-slate-200 group-hover:text-slate-700 group-hover:border-slate-300 transition-colors shadow-sm">
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                        </svg>
                                      </div>
                                      <div className="flex-1 flex flex-col justify-center">
                                        <span className="text-[11px] font-semibold text-slate-500 group-hover:text-slate-700 transition-colors">
                                          Collapse timeline (view active only)
                                        </span>
                                      </div>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ── TAB 2: RISK ENGINE & OCR OPS ─────────────────────────────────────── */}
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
                      className={`flex flex-col border rounded-xl overflow-hidden transition-all duration-200 ${isExpanded ? "border-blue-300 shadow-md ring-1 ring-blue-500/20" : "border-slate-200 shadow-xs hover:shadow-md hover:border-blue-200 bg-white"
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
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${compModal.data.overall_status === "Passed" ? "bg-emerald-100 text-emerald-800 border border-emerald-200" :
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
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${chk.status === "Passed" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
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
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex justify-end gap-2">
              {compModal.data.overall_status === "Flagged" && (
                <button
                  onClick={() => handleForceProceedCompliance(compModal.data.checks)}
                  disabled={forceProceedBusy}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50"
                >
                  {forceProceedBusy ? "Proceeding..." : "Proceed Anyway"}
                </button>
              )}
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
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${histModal.data.status === "Clear" ? "bg-emerald-100 text-emerald-800 border border-emerald-200" :
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
                  <div key={i} className={`border-l-2 pl-2.5 py-1 text-[11px] ${f.severity === "critical" ? "border-red-400 text-red-800"
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
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${medModal.data.status === "NotRequired"
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
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex flex-wrap justify-between items-center gap-2">
              <div className="flex items-center gap-3">
                <button onClick={() => router.push(`/case/${medModal.caseId}`)} className="text-xs font-semibold text-blue-600 hover:text-blue-700">
                  Open case →
                </button>
                {medModal.data.status !== "NotRequired" && medModal.data.status !== "Completed" && (
                  <button
                    onClick={async () => {
                      if (!medModal) return;
                      setMedBusyFor(medModal.caseId);
                      try {
                        await recordMedicalResult(medModal.caseId, {
                          results: { standard_panel: "normal", fasting_blood_sugar: "normal", urinalysis: "normal" },
                          reported_by: "Panel Diagnostic Center",
                        });
                        setMedModal(null);
                        await loadData();
                      } catch (e: any) {
                        alert(e?.message ?? "Failed to complete medical examination");
                      } finally {
                        setMedBusyFor(null);
                      }
                    }}
                    disabled={medBusyFor === medModal.caseId}
                    className="text-xs font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shadow-2xs"
                  >
                    {medBusyFor === medModal.caseId ? "Completing…" : "✓ Mark Examination Completed"}
                  </button>
                )}
              </div>
              <button onClick={() => setMedModal(null)} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customize E-App Modal */}
      {customizeModal && (
        <CustomizeEAppModal
          caseId={customizeModal.caseId}
          customerName={customizeModal.customerName}
          onClose={() => setCustomizeModal(null)}
          onSaved={() => {
            setCustomizeModal(null);
            loadData();
          }}
        />
      )}

      {/* Verify E-App Modal */}
      {verifyModal && (
        <VerifyEAppModal
          caseId={verifyModal.caseId}
          customerName={verifyModal.customerName}
          eApp={verifyModal.eApp}
          onClose={() => setVerifyModal(null)}
          onVerified={() => {
            setVerifyModal(null);
            loadData();
          }}
        />
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
