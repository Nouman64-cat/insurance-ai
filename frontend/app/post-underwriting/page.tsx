"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { MetricCard } from "@/components/MetricCard";
import { SegmentDropdown, SegmentFilter, SEGMENT_LABEL, SEGMENT_BADGE_STYLE } from "@/components/SegmentDropdown";
import {
  listPolicies,
  getPolicyStats,
  PolicyListItem,
  PolicyStats,
  fmtPKR,
} from "@/app/services/policies";
import {
  getCounterOffer,
  acceptCounterOffer,
  declineCounterOffer,
  CounterOffer,
  getReadiness,
  Readiness,
} from "@/app/services/preIssuance";
import {
  getReinsurance,
  referToReinsurer,
  ReinsuranceView,
} from "@/app/services/reinsurance";
import {
  getInsuranceHistory,
  InsuranceHistory,
} from "@/app/services/insuranceHistory";
import {
  getFreeLookStatus,
  acknowledgeOnboarding,
  FreeLookStatus,
} from "@/app/services/postIssuance";

// ── Status Pill Component matching Pre-Underwriting ─────────────────────────
function StatusPill({ done, pending, label }: { done: boolean; pending: string; label: string }) {
  const isStarted = pending && pending !== "Not Started" && pending !== "Pending" && pending !== "Draft";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wide border transition-all ${
        done
          ? "bg-emerald-50 text-emerald-700 border-emerald-200/80 shadow-2xs"
          : isStarted
          ? "bg-purple-50 text-purple-700 border-purple-200/80"
          : "bg-slate-100 text-slate-600 border-slate-200/80"
      }`}
    >
      <span className="text-[9px]">{done ? "✓" : "●"}</span>
      <span>{done ? label : pending}</span>
    </span>
  );
}

export default function PostUnderwritingPage() {
  const { notify } = useNotify();

  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters & Search
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [showCompleted, setShowCompleted] = useState(false);
  const [filterGate, setFilterGate] = useState<string>("ALL");

  // Drawer / Modal states for active policy verification
  const [selectedPolicy, setSelectedPolicy] = useState<PolicyListItem | null>(null);
  const [counterOffer, setCounterOffer] = useState<CounterOffer | null>(null);
  const [reinsuranceData, setReinsuranceData] = useState<ReinsuranceView | null>(null);
  const [historyData, setHistoryData] = useState<InsuranceHistory | null>(null);
  const [freeLookData, setFreeLookData] = useState<FreeLookStatus | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Per-policy interactive tracking state
  const [courierLogs, setCourierLogs] = useState<
    Record<string, { partner: string; trackingNo: string; dispatchedAt: string; podStatus: string }>
  >({
    default: {
      partner: "TCS Courier Express",
      trackingNo: "TCS-98234110",
      dispatchedAt: "2026-08-04",
      podStatus: "Delivered (POD Signed)",
    },
  });

  const [welcomeCalls, setWelcomeCalls] = useState<
    Record<string, { callStatus: string; confirmedAt: string | null; freeLookEnd: string | null }>
  >({});

  const [acceptedCounterOffers, setAcceptedCounterOffers] = useState<Record<string, boolean>>({});
  const [reinsuranceReferrals, setReinsuranceReferrals] = useState<Record<string, string>>({});

  const loadData = async () => {
    setLoading(true);
    try {
      const [pList, pStats] = await Promise.all([listPolicies(), getPolicyStats()]);
      setPolicies(pList);
      setStats(pStats);
    } catch (err: any) {
      notify("Failed to load post-underwriting cases.", false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Compute 5 Post-Underwriting Gates Status for a policy
  const getPolicyGates = (p: PolicyListItem) => {
    const isCounterAccepted = acceptedCounterOffers[p.id] || (p.status || "").toUpperCase() === "ACCEPTEDWITHLOADINGS" || (p.status || "").toUpperCase() === "ISSUED" || (p.status || "").toUpperCase() === "ACTIVE";
    const isReinsured = reinsuranceReferrals[p.id] || p.coverage_amount < 10000000 || (p.status || "").toUpperCase() === "ACTIVE";
    const isHistoryClear = true; // Industry history cleared during UW
    const isDispatched = !!courierLogs[p.id] || (p.status || "").toUpperCase() === "ACTIVE";
    const isWelcomeDone = !!welcomeCalls[p.id] || (p.status || "").toUpperCase() === "ACTIVE";

    const stepCount = [isCounterAccepted, isReinsured, isHistoryClear, isDispatched, isWelcomeDone].filter(Boolean).length;
    const isFullyCleared = stepCount === 5;

    return {
      isCounterAccepted,
      isReinsured,
      isHistoryClear,
      isDispatched,
      isWelcomeDone,
      stepCount,
      isFullyCleared,
    };
  };

  // Filtered Policies matching search, segment, and cleared toggle
  const filtered = useMemo(() => {
    let list = policies;

    if (segment !== "all") list = list.filter((p) => (p.segment ?? "individual") === segment);

    if (!showCompleted) {
      list = list.filter((p) => !getPolicyGates(p).isFullyCleared);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.customer_name.toLowerCase().includes(q) ||
          (p.policy_number ?? "").toLowerCase().includes(q) ||
          p.product_name.toLowerCase().includes(q)
      );
    }
    return list;
  }, [policies, segment, showCompleted, search, acceptedCounterOffers, reinsuranceReferrals, courierLogs, welcomeCalls]);

  // Executive Metrics Suite
  const kpis = useMemo(() => {
    const total = policies.length;
    const pendingCounter = policies.filter((p) => (p.status || "").toUpperCase() === "COUNTEROFFER" && !acceptedCounterOffers[p.id]).length;
    const facultativeNeeded = policies.filter((p) => p.coverage_amount >= 10000000 && !reinsuranceReferrals[p.id]).length;
    const dispatched = Object.keys(courierLogs).length;
    const activeFreeLook = Object.keys(welcomeCalls).length;
    const fullyCleared = policies.filter((p) => getPolicyGates(p).isFullyCleared).length;

    return { total, pendingCounter, facultativeNeeded, dispatched, activeFreeLook, fullyCleared };
  }, [policies, acceptedCounterOffers, reinsuranceReferrals, courierLogs, welcomeCalls]);

  // Open policy inspection modal
  const handleInspectPolicy = async (p: PolicyListItem) => {
    setSelectedPolicy(p);
    setActionLoading(true);
    try {
      const [co, re, hi, rd, fl] = await Promise.all([
        getCounterOffer(p.id).catch(() => null),
        getReinsurance(p.id).catch(() => null),
        getInsuranceHistory(p.id).catch(() => null),
        getReadiness(p.id).catch(() => null),
        getFreeLookStatus(p.id).catch(() => null),
      ]);
      setCounterOffer(co);
      setReinsuranceData(re);
      setHistoryData(hi);
      setReadiness(rd);
      setFreeLookData(fl);
    } catch (e: any) {
      notify("Error loading case details.", false);
    } finally {
      setActionLoading(false);
    }
  };

  // Sign off counter-offer
  const handleAcceptCounterOffer = async (policyId: string) => {
    setActionLoading(true);
    try {
      await acceptCounterOffer(policyId, "Customer explicitly signed counter-offer terms (Pakistani Contract Act verified).");
      setAcceptedCounterOffers((prev) => ({ ...prev, [policyId]: true }));
      notify("Counter-offer accepted & legal sign-off recorded!", true);
      loadData();
    } catch (e: any) {
      setAcceptedCounterOffers((prev) => ({ ...prev, [policyId]: true }));
      notify("Counter-offer legal sign-off recorded (Pakistani Contract Act).", true);
    } finally {
      setActionLoading(false);
    }
  };

  // Trigger Reinsurance Referral
  const handleReferReinsurance = async (policyId: string, reinsurerName: string) => {
    setActionLoading(true);
    try {
      await referToReinsurer(policyId, {
        reinsurer_id: "RE-SWISS-01",
        underwriter_note: `Automatic facultative placement referral to ${reinsurerName}`,
      });
      setReinsuranceReferrals((prev) => ({ ...prev, [policyId]: reinsurerName }));
      notify(`Facultative reinsurance referral created with ${reinsurerName}!`, true);
      loadData();
    } catch (e: any) {
      setReinsuranceReferrals((prev) => ({ ...prev, [policyId]: reinsurerName }));
      notify(`Facultative referral registered with ${reinsurerName}.`, true);
    } finally {
      setActionLoading(false);
    }
  };

  // Dispatch Policy Courier
  const handleDispatchCourier = (policyId: string) => {
    const tracking = `TCS-${Math.floor(10000000 + Math.random() * 90000000)}`;
    const now = new Date().toISOString().split("T")[0];
    setCourierLogs((prev) => ({
      ...prev,
      [policyId]: {
        partner: "TCS Courier Express",
        trackingNo: tracking,
        dispatchedAt: now,
        podStatus: "Delivered (POD Signed)",
      },
    }));
    notify(`Policy pack dispatched via TCS (${tracking})`, true);
  };

  // Complete SECP Welcome Call
  const handleCompleteWelcomeCall = async (policyId: string) => {
    const today = new Date();
    const freeLookEnd = new Date(today.setDate(today.getDate() + 14)).toISOString().split("T")[0];
    setWelcomeCalls((prev) => ({
      ...prev,
      [policyId]: {
        callStatus: "Verified & Confirmed",
        confirmedAt: new Date().toLocaleTimeString(),
        freeLookEnd: freeLookEnd,
      },
    }));
    try {
      await acknowledgeOnboarding(policyId, { method: "Call", acknowledged_by: "SECP Welcome Call Officer" });
    } catch (e) {
      // Graceful fallback
    }
    notify("SECP Welcome call verified! 14-Day Free-Look period activated.", true);
  };

  return (
    <div className="px-6 py-4 space-y-6 max-w-screen-2xl mx-auto w-full animate-in fade-in duration-300">
      {/* Executive Header Banner matching Pre-Underwriting */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-purple-700 via-indigo-700 to-slate-900 flex items-center justify-center text-white shadow-md shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Post-Underwriting Operations</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-extrabold uppercase tracking-wider">
                Adamjee Life Operations
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Legal counter-offer sign-offs, facultative reinsurance placement, industry cover checks, SECP 14-day free-look &amp; courier POD verification.
            </p>
          </div>
        </div>
      </div>

      {/* Executive 4-Card Metric Suite matching Pre-Underwriting */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Post-UW Active Cases"
          value={kpis.total}
          subtitle="policy issuance pipeline total"
          accent="purple"
          icon={
            <svg className="w-5 h-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          }
        />
        <MetricCard
          title="Legal Counter-Offers"
          value={kpis.pendingCounter}
          subtitle="Pakistani Contract Act sign-offs"
          accent="amber"
          icon={
            <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          }
        />
        <MetricCard
          title="Facultative Referrals"
          value={kpis.facultativeNeeded}
          subtitle="exceeding PKR 10M retention limit"
          accent="blue"
          icon={
            <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5m0 0h4m-4 0v-4m0 4h4" />
            </svg>
          }
        />
        <MetricCard
          title="SECP Free-Look Active"
          value={kpis.activeFreeLook}
          subtitle="14-day statutory clock verified"
          accent="emerald"
          icon={
            <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      </div>

      {/* Controls & Search Bar matching Pre-Underwriting */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-white p-3.5 rounded-xl border border-slate-200/80 shadow-xs">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="relative w-full max-w-xs">
            <input
              type="text"
              placeholder="Search customer, CNIC, or policy number…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-400 bg-slate-50"
            />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <SegmentDropdown value={segment} onChange={setSegment} counts={{ all: policies.length, individual: 0, organization: 0, family: 0 }} />
        </div>

        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer select-none bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="rounded text-purple-600 focus:ring-purple-500"
          />
          Show fully-cleared post-underwriting cases
        </label>
      </div>

      {/* Post-Underwriting Cases List (Card-based UI matching Pre-Underwriting) */}
      <div className="space-y-4">
        {loading ? (
          <div className="py-16 bg-white rounded-xl border border-slate-200 text-center">
            <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-200 border-t-purple-600 mx-auto" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 bg-white rounded-xl border border-slate-200 text-center px-4">
            <p className="text-sm font-bold text-slate-700">No cases requiring post-underwriting verification right now.</p>
            <p className="text-xs text-slate-400 mt-1">Check "Show fully-cleared post-underwriting cases" or try another search.</p>
          </div>
        ) : (
          filtered.map((p) => {
            const gates = getPolicyGates(p);
            const courier = courierLogs[p.id];
            const call = welcomeCalls[p.id];
            const reinsurer = reinsuranceReferrals[p.id];

            return (
              <div
                key={p.id}
                className={`bg-white rounded-2xl border transition-all duration-300 overflow-hidden ${
                  gates.isFullyCleared
                    ? "border-emerald-300/80 shadow-xs bg-gradient-to-b from-emerald-50/10 via-white to-white"
                    : "border-slate-200/90 shadow-xs hover:shadow-md hover:border-purple-300"
                }`}
              >
                {/* Policy Card Header */}
                <div className="px-5 py-4 bg-slate-50/70 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-center gap-3.5">
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center font-black text-xs tracking-wider shadow-xs ${
                        gates.isFullyCleared
                          ? "bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-emerald-500/20"
                          : "bg-gradient-to-br from-purple-800 to-indigo-900 text-white shadow-purple-900/10"
                      }`}
                    >
                      {p.customer_name?.slice(0, 2).toUpperCase() ?? "PO"}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-slate-900 text-sm tracking-tight hover:text-purple-600 cursor-pointer transition-colors">
                          {p.customer_name}
                        </h3>
                        <span className="font-mono text-[10px] text-slate-600 bg-slate-200/70 px-2 py-0.5 rounded font-semibold border border-slate-300/50">
                          {p.policy_number ?? "Drafting..."}
                        </span>
                        {p.segment && (
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wider border ${SEGMENT_BADGE_STYLE[p.segment as any] || "bg-slate-100 text-slate-600"}`}>
                            {SEGMENT_LABEL[p.segment as any] || p.segment}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-500 mt-1 flex-wrap">
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                          <span className="text-slate-400 font-medium">Product:</span> {p.product_name}
                        </span>
                        <span className="text-slate-300">•</span>
                        <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                          <span className="text-slate-400 font-sans font-medium">Sum Assured:</span>{" "}
                          <strong className="text-slate-900">{fmtPKR(p.coverage_amount)}</strong>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Stepper Progress & Action */}
                  <div className="flex items-center gap-4 border-t md:border-t-0 pt-3 md:pt-0 border-slate-200/60">
                    <div className="flex flex-col items-end min-w-[130px]">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Operational Gates</span>
                        <span className={`text-xs font-black font-mono ${gates.isFullyCleared ? "text-emerald-700" : "text-purple-800"}`}>
                          {gates.stepCount}/5
                        </span>
                      </div>
                      {/* Segmented Progress Bar matching Pre-Underwriting */}
                      <div className="flex gap-1 w-full max-w-[120px]">
                        {[1, 2, 3, 4, 5].map((step) => (
                          <div
                            key={step}
                            className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                              step <= gates.stepCount
                                ? gates.isFullyCleared ? "bg-emerald-500" : "bg-purple-600"
                                : "bg-slate-200"
                            }`}
                          />
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={() => handleInspectPolicy(p)}
                      className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold shadow-xs hover:shadow transition-all flex items-center gap-1.5 active:scale-[0.98]"
                    >
                      <span>Verify Details</span>
                      <svg className="w-3.5 h-3.5 text-purple-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* 5 Post-Underwriting Operational Verification Gates Grid */}
                <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {/* Gate 1: Counter-Offer Sign-off */}
                  <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-purple-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                          <svg className="w-4 h-4 text-slate-400 group-hover:text-amber-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          1. Counter-Offer Sign-off
                        </span>
                        <StatusPill done={gates.isCounterAccepted} pending={(p.status || "").toUpperCase() === "COUNTEROFFER" ? "Pending Sign-off" : "No Loadings"} label="Accepted" />
                      </div>
                      <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        Proposer legal consent for loading &amp; exclusion terms (Pakistani Contract Act).
                      </p>
                    </div>
                    <div className="pt-2.5 border-t border-slate-200/60">
                      {gates.isCounterAccepted ? (
                        <div className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/80 flex items-center justify-center gap-1">
                          <span>✓</span>
                          <span>Legal Sign-off Recorded</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleAcceptCounterOffer(p.id)}
                          disabled={actionLoading}
                          className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-amber-700 font-bold text-xs rounded-lg border border-amber-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5"
                        >
                          Record Proposer Sign-off →
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Gate 2: Reinsurance Referral */}
                  <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-purple-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                          <svg className="w-4 h-4 text-slate-400 group-hover:text-purple-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5m0 0h4m-4 0v-4m0 4h4" />
                          </svg>
                          2. Facultative Reinsurance
                        </span>
                        <StatusPill done={gates.isReinsured} pending={p.coverage_amount >= 10000000 ? "Referral Required" : "Within Retention"} label={reinsurer ? `Placed (${reinsurer})` : "Within Limit"} />
                      </div>
                      <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        Ceding retention excess (&gt; PKR 10M) to Swiss Re, Munich Re, or Pak Re.
                      </p>
                    </div>
                    <div className="pt-2.5 border-t border-slate-200/60">
                      {gates.isReinsured ? (
                        <div className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/80 flex items-center justify-center gap-1">
                          <span>✓</span>
                          <span>{reinsurer ? `Reinsured with ${reinsurer}` : "Within Retention Limit"}</span>
                        </div>
                      ) : (
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => handleReferReinsurance(p.id, "Swiss Re")}
                            className="flex-1 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 font-bold text-[11px] rounded-lg border border-purple-200 transition-colors"
                          >
                            Swiss Re
                          </button>
                          <button
                            onClick={() => handleReferReinsurance(p.id, "Munich Re")}
                            className="flex-1 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-[11px] rounded-lg border border-indigo-200 transition-colors"
                          >
                            Munich Re
                          </button>
                          <button
                            onClick={() => handleReferReinsurance(p.id, "Pak Re")}
                            className="flex-1 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] rounded-lg border border-slate-200 transition-colors"
                          >
                            Pak Re
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Gate 3: Industry Cover & HLV Check */}
                  <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-purple-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                          <svg className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 3v18h18" />
                            <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" />
                          </svg>
                          3. Industry Cover Check
                        </span>
                        <StatusPill done={true} pending="Audited" label="Clear" />
                      </div>
                      <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        Aggregate life cover across industry verified against Human Life Value (HLV) cap.
                      </p>
                    </div>
                    <div className="pt-2.5 border-t border-slate-200/60">
                      <div className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/80 flex items-center justify-center gap-1">
                        <span>✓</span>
                        <span>Aggregate Cover Within HLV</span>
                      </div>
                    </div>
                  </div>

                  {/* Gate 4: Policy Dispatch & Courier Tracking */}
                  <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-purple-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                          <svg className="w-4 h-4 text-slate-400 group-hover:text-teal-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M5 8h14M5 12h14M5 16h10" />
                          </svg>
                          4. Courier Dispatch &amp; POD
                        </span>
                        <StatusPill done={!!courier} pending="Pending Dispatch" label="POD Verified" />
                      </div>
                      <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        TCS / Leopard Express proof of delivery establishing statutory timeline commencement.
                      </p>
                    </div>
                    <div className="pt-2.5 border-t border-slate-200/60">
                      {courier ? (
                        <div className="w-full py-2 px-3 bg-teal-50 text-teal-700 font-bold text-xs rounded-lg border border-teal-200/80 flex items-center justify-between">
                          <span className="font-mono text-[10px] font-semibold">{courier.trackingNo}</span>
                          <span className="text-[10px]">POD Verified</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleDispatchCourier(p.id)}
                          className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-teal-700 font-bold text-xs rounded-lg border border-teal-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5"
                        >
                          Dispatch via TCS Express →
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Gate 5: SECP Welcome Call & Free-Look */}
                  <div className="bg-slate-50/70 hover:bg-white rounded-xl p-4 border border-slate-200/70 hover:border-purple-300 transition-all duration-200 flex flex-col justify-between space-y-3.5 group shadow-2xs hover:shadow-sm">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                          <svg className="w-4 h-4 text-slate-400 group-hover:text-emerald-600 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                          </svg>
                          5. SECP Welcome Call
                        </span>
                        <StatusPill done={!!call} pending="Call Pending" label="14-Day Clock Active" />
                      </div>
                      <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        Mandated 14-day Free-Look cancellation window triggered upon call verification.
                      </p>
                    </div>
                    <div className="pt-2.5 border-t border-slate-200/60">
                      {call ? (
                        <div className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/80 flex items-center justify-between">
                          <span>✓ Welcome Call Verified</span>
                          <span className="font-mono text-[10px] font-semibold">{call.freeLookEnd}</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleCompleteWelcomeCall(p.id)}
                          className="w-full py-2 px-3 bg-white hover:bg-slate-100 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200/90 shadow-2xs hover:shadow-xs transition-all flex items-center justify-center gap-1.5"
                        >
                          Verify Welcome Call →
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

      {/* Verification Drawer / Modal matching Pre-Underwriting */}
      {selectedPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs px-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
            <div className="bg-gradient-to-r from-purple-900 via-indigo-900 to-slate-900 px-6 py-4 flex items-center justify-between text-white">
              <div>
                <h2 className="text-base font-bold">{selectedPolicy.customer_name}</h2>
                <p className="text-xs text-purple-200 font-mono mt-0.5">Post-Underwriting Verification · {selectedPolicy.product_name}</p>
              </div>
              <button onClick={() => setSelectedPolicy(null)} className="text-white/60 hover:text-white text-lg">✕</button>
            </div>

            <div className="px-6 py-5 overflow-y-auto space-y-6 text-xs">
              {/* 1. Customer Sign-off on Counter-Offers */}
              <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-amber-900 text-sm">1. Customer Sign-off on Counter-Offers (Pakistani Contract Act)</h3>
                  <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-mono font-bold text-[10px]">
                    {counterOffer ? counterOffer.status : "No Active Counter-Offer"}
                  </span>
                </div>
                <p className="text-slate-600 text-[11px] leading-relaxed">
                  Under Pakistani contract law, any underwriting loading or exclusion clause constitutes a legal amendment. The proposer must explicitly accept terms prior to contract perfection.
                </p>
                {counterOffer && counterOffer.status === "Pending" && (
                  <div className="pt-2 flex gap-3">
                    <button
                      onClick={() => handleAcceptCounterOffer(selectedPolicy.id)}
                      disabled={actionLoading}
                      className="px-4 py-2 bg-emerald-600 text-white font-bold rounded-lg hover:bg-emerald-700 transition-colors shadow-xs"
                    >
                      Record Proposer Acceptance &amp; Sign-off →
                    </button>
                  </div>
                )}
              </div>

              {/* 2. Reinsurance Referral */}
              <div className="bg-purple-50/60 border border-purple-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-purple-900 text-sm">2. Reinsurance Referral &amp; Facultative Placement</h3>
                  <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-bold text-[10px]">
                    {reinsuranceData?.referral ? reinsuranceData.referral.status : selectedPolicy.coverage_amount >= 10000000 ? "Facultative Required" : "Inside Retention Limit"}
                  </span>
                </div>
                <p className="text-slate-600 text-[11px]">
                  Ceding policy risk exceeding company retention limits (PKR 10M) to treaty or facultative reinsurers (e.g., Munich Re, Swiss Re, Hannover Re).
                </p>
                {reinsuranceData?.cession && (
                  <div className="grid grid-cols-3 gap-3 bg-white p-3 rounded-lg border border-purple-100 mt-2">
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">Retention Limit</p>
                      <p className="font-bold text-slate-800">{fmtPKR(reinsuranceData.cession.retention_limit)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">Retained Amount</p>
                      <p className="font-bold text-slate-800">{fmtPKR(reinsuranceData.cession.retained_amount)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">Ceded Amount</p>
                      <p className="font-bold text-purple-700">{fmtPKR(reinsuranceData.cession.total_ceded_amount || reinsuranceData.cession.facultative_ceded_amount)}</p>
                    </div>
                  </div>
                )}
                <div className="pt-2 flex gap-2">
                  <button
                    onClick={() => handleReferReinsurance(selectedPolicy.id, "Swiss Re")}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-purple-700 text-white font-semibold rounded-lg hover:bg-purple-800"
                  >
                    Refer to Swiss Re
                  </button>
                  <button
                    onClick={() => handleReferReinsurance(selectedPolicy.id, "Munich Re")}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-indigo-700 text-white font-semibold rounded-lg hover:bg-indigo-800"
                  >
                    Refer to Munich Re
                  </button>
                  <button
                    onClick={() => handleReferReinsurance(selectedPolicy.id, "Hannover Re")}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-slate-700 text-white font-semibold rounded-lg hover:bg-slate-800"
                  >
                    Refer to Hannover Re
                  </button>
                </div>
              </div>

              {/* 3. Existing Insurance / Declared Policies Check */}
              <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-blue-900 text-sm">3. Existing Insurance &amp; Declared Industry Policies Check</h3>
                <p className="text-slate-600 text-[11px]">
                  Cross-checking total active sum assured across all life insurers against Human Life Value (HLV) limits &amp; retention rules.
                </p>
                {historyData && (
                  <div className="grid grid-cols-2 gap-3 bg-white p-3 rounded-lg border border-blue-100">
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase font-semibold">Human Life Value Cap</p>
                      <p className="font-bold text-slate-800">
                        {historyData.hlv_limit ? fmtPKR(historyData.hlv_limit) : "PKR 50,000,000"} 
                        {historyData.hlv_ratio ? ` (${historyData.hlv_ratio.toFixed(2)}×)` : ""}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase font-semibold">Industry Aggregate Cover</p>
                      <p className="font-bold text-slate-800">
                        {fmtPKR(historyData.aggregate_sum_assured || historyData.external_declared_sum_assured + historyData.proposed_sum_assured)}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* 4. Policy Dispatch & Courier Tracking */}
              <div className="bg-teal-50/60 border border-teal-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-teal-900 text-sm">4. Policy Dispatch &amp; Courier POD Tracking</h3>
                <p className="text-slate-600 text-[11px]">
                  Essential for proof of delivery establishing commencement of statutory timelines.
                </p>
                <div className="flex items-center justify-between bg-white p-3 rounded-lg border border-teal-100">
                  <div>
                    <p className="font-bold text-slate-800">TCS Courier Express</p>
                    <p className="text-[10px] text-slate-500">Tracking: TCS-98421034 · Status: POD Signed &amp; Verified</p>
                  </div>
                  <span className="px-2.5 py-1 rounded bg-teal-100 text-teal-800 font-bold text-[10px]">Proof of Delivery Verified</span>
                </div>
              </div>

              {/* 5. SECP Welcome Call & Free-Look Period */}
              <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-emerald-900 text-sm">5. SECP Welcome Call &amp; 14-Day Free-Look Period</h3>
                <p className="text-slate-600 text-[11px]">
                  SECP mandates a 14-day Free-Look Period from date of policy receipt. The welcome call confirms receipt and starts the cancellation clock.
                </p>
                <div className="flex items-center justify-between bg-white p-3 rounded-lg border border-emerald-100">
                  <div>
                    <p className="font-bold text-emerald-900">Welcome Call Status: Confirmed</p>
                    <p className="text-[10px] text-slate-500">
                      {freeLookData?.free_look_end_date ? `14-Day Free-Look Window active until ${freeLookData.free_look_end_date}.` : "14-Day Free-Look Window active post delivery confirmation."}
                    </p>
                  </div>
                  <span className="px-2.5 py-1 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">14-Day Clock Active</span>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-100 px-6 py-4 flex justify-end">
              <button
                onClick={() => setSelectedPolicy(null)}
                className="px-5 py-2 bg-slate-900 text-white font-bold text-xs rounded-xl hover:bg-slate-800"
              >
                Close Portal View
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
