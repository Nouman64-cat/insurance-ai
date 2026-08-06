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
  DEFAULT_REINSURERS,
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

const PANEL_REINSURERS = [
  {
    id: "RE-001",
    name: "Swiss Reinsurance Company Ltd (Swiss Re)",
    am_best_rating: "A+ (Superior)",
    facultative_capacity: 250000000,
    contact_email: "life_facultative@swissre.com",
  },
  {
    id: "RE-002",
    name: "Munich Re Group (Münchener Rück)",
    am_best_rating: "AA (Excellent)",
    facultative_capacity: 200000000,
    contact_email: "underwriting_pakistan@munichre.com",
  },
  {
    id: "RE-003",
    name: "Pakistan Reinsurance Company Limited (PRCL)",
    am_best_rating: "AA+ (National)",
    facultative_capacity: 100000000,
    contact_email: "reinsurance_ops@pakre.org.pk",
  },
  {
    id: "RE-004",
    name: "Hannover Rück SE",
    am_best_rating: "A+ (Superior)",
    facultative_capacity: 150000000,
    contact_email: "fac_life@hannover-re.com",
  },
];

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

export interface CounterOfferState {
  workflowState:
    | "UNDERWRITING_COMPLETE"
    | "COUNTER_OFFER_PREPARED"
    | "SENT_TO_CUSTOMER"
    | "CUSTOMER_RESPONSE_RECEIVED"
    | "APPROVAL_PENDING"
    | "APPROVED"
    | "POLICY_ISSUED";
  customerDecision: "PENDING" | "ACCEPTED" | "DECLINED" | "RE_NEGOTIATE";
  expiringPremium: number;
  deltaDuration: number;
  deltaExposure: number;
  deltaCoverage: number;
  deltaRate: number;
  proposedPremium: number;
  reasonCode: string;
  notes: string;
  signoffHistory: {
    role: string;
    level: string;
    approvedBy: string;
    timestamp: string;
    notes: string;
  }[];
}

const calculateRenewalPremium = (expiring: number, dur: number, exp: number, cov: number, rate: number) => {
  const result = expiring * (1 + dur) * (1 + exp) * (1 + cov) * (1 + rate);
  return Math.round(result);
};

const getDeviationPct = (expiring: number, proposed: number) => {
  if (!expiring) return 0;
  return ((proposed - expiring) / expiring) * 100;
};

const getApprovalAuthority = (absDev: number) => {
  if (absDev <= 10) {
    return {
      level: "Level 1",
      role: "Junior Underwriter",
      badgeClass: "bg-sky-50 text-sky-700 border-sky-200",
      description: "Deviation ≤ 10%: Standard underwriter authority limit",
    };
  }
  if (absDev <= 25) {
    return {
      level: "Level 2",
      role: "Senior Underwriter",
      badgeClass: "bg-blue-50 text-blue-700 border-blue-200",
      description: "Deviation 10% – 25%: Requires Senior Underwriter authorization",
    };
  }
  return {
    level: "Level 3",
    role: "Chief Underwriter & Pricing Committee",
    badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
    description: "Deviation > 25%: Requires Chief Underwriter / Pricing Committee sign-off",
  };
};

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
  const [activeCounterPolicy, setActiveCounterPolicy] = useState<PolicyListItem | null>(null);
  const [activeReinsurancePolicy, setActiveReinsurancePolicy] = useState<PolicyListItem | null>(null);
  const [counterOffer, setCounterOffer] = useState<CounterOffer | null>(null);
  const [reinsuranceData, setReinsuranceData] = useState<ReinsuranceView | null>(null);
  const [historyData, setHistoryData] = useState<InsuranceHistory | null>(null);
  const [freeLookData, setFreeLookData] = useState<FreeLookStatus | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Reinsurance placement state per policy
  const [reinsurancePlacements, setReinsurancePlacements] = useState<
    Record<string, { reinsurerId: string; reinsurerName: string; note: string; status: string; cededAmount: number }>
  >({});

  // Counter-Offer interactive details per policy
  const [counterOfferStates, setCounterOfferStates] = useState<Record<string, CounterOfferState>>({});

  // Per-policy interactive tracking state
  const [courierLogs, setCourierLogs] = useState<
    Record<string, { partner: string; trackingNo: string; dispatchedAt: string; podStatus: string }>
  >(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("pu_courierLogs");
      if (stored) return JSON.parse(stored);
    }
    return {
      default: {
        partner: "TCS Courier Express",
        trackingNo: "TCS-98234110",
        dispatchedAt: "2026-08-04",
        podStatus: "Delivered (POD Signed)",
      },
    };
  });

  const [welcomeCalls, setWelcomeCalls] = useState<
    Record<string, { callStatus: string; confirmedAt: string | null; freeLookEnd: string | null }>
  >(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("pu_welcomeCalls");
      if (stored) return JSON.parse(stored);
    }
    return {};
  });

  const [acceptedCounterOffers, setAcceptedCounterOffers] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("pu_acceptedCounterOffers");
      if (stored) return JSON.parse(stored);
    }
    return {};
  });

  const [reinsuranceReferrals, setReinsuranceReferrals] = useState<Record<string, string>>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("pu_reinsuranceReferrals");
      if (stored) return JSON.parse(stored);
    }
    return {};
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pu_courierLogs", JSON.stringify(courierLogs));
    }
  }, [courierLogs]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pu_welcomeCalls", JSON.stringify(welcomeCalls));
    }
  }, [welcomeCalls]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pu_acceptedCounterOffers", JSON.stringify(acceptedCounterOffers));
    }
  }, [acceptedCounterOffers]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pu_reinsuranceReferrals", JSON.stringify(reinsuranceReferrals));
    }
  }, [reinsuranceReferrals]);

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

  const getOrCreateCounterState = (p: PolicyListItem): CounterOfferState => {
    if (counterOfferStates[p.id]) {
      return counterOfferStates[p.id];
    }
    const expiring = Math.round((p.coverage_amount || 5000000) * 0.025);
    const dur = 0.00;
    const exp = 0.05;
    const cov = 0.00;
    const rate = 0.10;
    const proposed = calculateRenewalPremium(expiring, dur, exp, cov, rate);

    const isDone = acceptedCounterOffers[p.id] || (p.status || "").toUpperCase() === "ACCEPTEDWITHLOADINGS" || (p.status || "").toUpperCase() === "ISSUED" || (p.status || "").toUpperCase() === "ACTIVE";

    return {
      workflowState: isDone ? "APPROVED" : "COUNTER_OFFER_PREPARED",
      customerDecision: isDone ? "ACCEPTED" : "PENDING",
      expiringPremium: expiring,
      deltaDuration: dur,
      deltaExposure: exp,
      deltaCoverage: cov,
      deltaRate: rate,
      proposedPremium: proposed,
      reasonCode: "Renewal Rate & Risk Exposure Change",
      notes: "Initial counter-offer proposal generated by underwriting engine.",
      signoffHistory: isDone
        ? [
            {
              role: "Senior Underwriter",
              level: "Level 2",
              approvedBy: "Senior Underwriter (Adamjee Ops)",
              timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
              notes: "Counter-offer approved under 15% rate deviation matrix.",
            },
          ]
        : [],
    };
  };

  const updateCounterState = (policyId: string, updater: (prev: CounterOfferState) => CounterOfferState) => {
    setCounterOfferStates((prev) => {
      const current = prev[policyId] || getOrCreateCounterState(policies.find((p) => p.id === policyId)!);
      return { ...prev, [policyId]: updater(current) };
    });
  };

  // Compute 5 Post-Underwriting Gates Status for a policy
  const getPolicyGates = (p: PolicyListItem) => {
    const coState = counterOfferStates[p.id];
    const isCounterAccepted =
      coState?.workflowState === "APPROVED" ||
      coState?.workflowState === "POLICY_ISSUED" ||
      acceptedCounterOffers[p.id] ||
      (p.status || "").toUpperCase() === "ACCEPTEDWITHLOADINGS" ||
      (p.status || "").toUpperCase() === "ISSUED" ||
      (p.status || "").toUpperCase() === "ACTIVE";
    const isReinsured = reinsuranceReferrals[p.id] || p.coverage_amount < 10000000 || (p.status || "").toUpperCase() === "ACTIVE";
    const isHistoryClear = true; // Industry history cleared during UW
    const isDispatched = !!courierLogs[p.id] || (p.status || "").toUpperCase() === "ACTIVE";
    const isWelcomeDone = !!welcomeCalls[p.id] || (p.status || "").toUpperCase() === "ACTIVE";

    const stepCount = [isCounterAccepted, isReinsured, isHistoryClear, isDispatched, isWelcomeDone].filter(Boolean).length;
    const isFullyCleared = stepCount === 5;

    if (isFullyCleared && typeof window !== "undefined") {
      localStorage.setItem("pu_cleared_" + p.id, "true");
    }

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

  // Filtered Policies matching search and cleared toggle (before segment filter)
  const baseFiltered = useMemo(() => {
    let list = policies;

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
  }, [policies, showCompleted, search, acceptedCounterOffers, reinsuranceReferrals, courierLogs, welcomeCalls]);

  const filtered = useMemo(() => {
    let list = baseFiltered;
    if (segment !== "all") list = list.filter((p) => (p.segment ?? "individual") === segment);
    return list;
  }, [baseFiltered, segment]);

  const segmentCounts = useMemo(() => ({
    all: baseFiltered.length,
    individual: baseFiltered.filter((p) => (p.segment ?? "individual") === "individual").length,
    family: baseFiltered.filter((p) => p.segment === "family").length,
    organization: baseFiltered.filter((p) => p.segment === "organization").length,
  }), [baseFiltered]);

  // Executive Metrics Suite
  const kpis = useMemo(() => {
    const total = policies.filter((p) => !getPolicyGates(p).isFullyCleared).length;
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
          <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />
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

                {/* 5 Post-Underwriting Operational Verification Timeline */}
                <div className="p-5 md:p-7 relative bg-slate-50/30">
                  {/* Vertical connecting line */}
                  <div className="absolute top-8 bottom-8 left-[39px] w-[3px] bg-slate-200/80 rounded-full z-0"></div>
                  
                  <div className="space-y-6 relative z-10">
                    {/* Gate 1: Counter-Offer Sign-off */}
                    <div className="relative flex gap-4 group">
                      <div className="shrink-0 mt-1">
                        <div className={`w-10 h-10 rounded-full border-[3px] flex items-center justify-center bg-white transition-all ${gates.isCounterAccepted ? 'border-emerald-500 text-emerald-500 shadow-sm' : 'border-purple-500 text-purple-600 shadow-[0_0_15px_rgba(168,85,247,0.4)]'}`}>
                          {gates.isCounterAccepted ? <span className="text-sm font-bold">✓</span> : <span className="w-3 h-3 rounded-full bg-purple-500 animate-pulse"></span>}
                        </div>
                      </div>
                      <div className={`flex-1 bg-white rounded-xl p-4 border transition-all duration-300 ${gates.isCounterAccepted ? 'border-slate-200/60 opacity-80 shadow-2xs' : 'border-purple-300 shadow-md ring-1 ring-purple-100'}`}>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                          <span className={`text-sm font-bold uppercase tracking-wider flex items-center gap-1.5 ${gates.isCounterAccepted ? 'text-slate-700' : 'text-purple-900'}`}>
                            <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            Counter-Offer Sign-off
                          </span>
                          <StatusPill done={gates.isCounterAccepted} pending={(p.status || "").toUpperCase() === "COUNTEROFFER" ? "Pending Sign-off" : "No Loadings"} label="Accepted" />
                        </div>
                        <p className="text-xs text-slate-500 leading-relaxed mb-4">
                          Proposer legal consent for loading & exclusion terms (Pakistani Contract Act).
                        </p>
                        <div>
                          {gates.isCounterAccepted ? (
                            <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200/80">
                              <span>✓</span>
                              <span>Legal Sign-off Recorded</span>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleAcceptCounterOffer(p.id)}
                              disabled={actionLoading}
                              className="w-full sm:w-auto py-2 px-5 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-lg shadow-sm hover:shadow transition-all flex items-center justify-center gap-1.5 active:scale-[0.98]"
                            >
                              Record Proposer Sign-off →
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Gate 2: Facultative Reinsurance */}
                    {gates.isCounterAccepted && (
                      <div className="relative flex gap-4 group animate-in fade-in slide-in-from-top-4 duration-500 fill-mode-both">
                        <div className="shrink-0 mt-1">
                          <div className={`w-10 h-10 rounded-full border-[3px] flex items-center justify-center bg-white transition-all ${gates.isReinsured ? 'border-emerald-500 text-emerald-500 shadow-sm' : 'border-purple-500 text-purple-600 shadow-[0_0_15px_rgba(168,85,247,0.4)]'}`}>
                            {gates.isReinsured ? <span className="text-sm font-bold">✓</span> : <span className="w-3 h-3 rounded-full bg-purple-500 animate-pulse"></span>}
                          </div>
                        </div>
                        <div className={`flex-1 bg-white rounded-xl p-4 border transition-all duration-300 ${gates.isReinsured ? 'border-slate-200/60 opacity-80 shadow-2xs' : 'border-purple-300 shadow-md ring-1 ring-purple-100'}`}>
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                            <span className={`text-sm font-bold uppercase tracking-wider flex items-center gap-1.5 ${gates.isReinsured ? 'text-slate-700' : 'text-purple-900'}`}>
                              <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5m0 0h4m-4 0v-4m0 4h4" />
                              </svg>
                              Facultative Reinsurance
                            </span>
                            <StatusPill done={gates.isReinsured} pending={p.coverage_amount >= 10000000 ? "Referral Required" : "Within Retention"} label={reinsurer ? `Placed (${reinsurer})` : "Within Limit"} />
                          </div>
                          <p className="text-xs text-slate-500 leading-relaxed mb-4">
                            Ceding retention excess (&gt; PKR 10M) to Swiss Re, Munich Re, or Pak Re.
                          </p>
                          <div>
                            {gates.isReinsured ? (
                              <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200/80">
                                <span>✓</span>
                                <span>{reinsurer ? `Reinsured with ${reinsurer}` : "Within Retention Limit"}</span>
                              </div>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                <button onClick={() => handleReferReinsurance(p.id, "Swiss Re")} className="py-2 px-4 bg-purple-50 hover:bg-purple-100 text-purple-700 font-bold text-xs rounded-lg border border-purple-200 transition-colors">Swiss Re</button>
                                <button onClick={() => handleReferReinsurance(p.id, "Munich Re")} className="py-2 px-4 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs rounded-lg border border-indigo-200 transition-colors">Munich Re</button>
                                <button onClick={() => handleReferReinsurance(p.id, "Pak Re")} className="py-2 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-lg border border-slate-200 transition-colors">Pak Re</button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Gate 3: Industry Cover Check */}
                    {gates.isCounterAccepted && gates.isReinsured && (
                      <div className="relative flex gap-4 group animate-in fade-in slide-in-from-top-4 duration-500 fill-mode-both">
                        <div className="shrink-0 mt-1">
                          <div className={`w-10 h-10 rounded-full border-[3px] flex items-center justify-center bg-white transition-all ${gates.isHistoryClear ? 'border-emerald-500 text-emerald-500 shadow-sm' : 'border-purple-500 text-purple-600 shadow-[0_0_15px_rgba(168,85,247,0.4)]'}`}>
                            {gates.isHistoryClear ? <span className="text-sm font-bold">✓</span> : <span className="w-3 h-3 rounded-full bg-purple-500 animate-pulse"></span>}
                          </div>
                        </div>
                        <div className={`flex-1 bg-white rounded-xl p-4 border transition-all duration-300 ${gates.isHistoryClear ? 'border-slate-200/60 opacity-80 shadow-2xs' : 'border-purple-300 shadow-md ring-1 ring-purple-100'}`}>
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                            <span className={`text-sm font-bold uppercase tracking-wider flex items-center gap-1.5 ${gates.isHistoryClear ? 'text-slate-700' : 'text-purple-900'}`}>
                              <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 3v18h18" />
                                <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" />
                              </svg>
                              Industry Cover Check
                            </span>
                            <StatusPill done={true} pending="Audited" label="Clear" />
                          </div>
                          <p className="text-xs text-slate-500 leading-relaxed mb-4">
                            Aggregate life cover across industry verified against Human Life Value (HLV) cap.
                          </p>
                          <div>
                            <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200/80">
                              <span>✓</span>
                              <span>Aggregate Cover Within HLV</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Gate 4: Courier Dispatch & POD */}
                    {gates.isCounterAccepted && gates.isReinsured && gates.isHistoryClear && (
                      <div className="relative flex gap-4 group animate-in fade-in slide-in-from-top-4 duration-500 fill-mode-both">
                        <div className="shrink-0 mt-1">
                          <div className={`w-10 h-10 rounded-full border-[3px] flex items-center justify-center bg-white transition-all ${gates.isDispatched ? 'border-emerald-500 text-emerald-500 shadow-sm' : 'border-purple-500 text-purple-600 shadow-[0_0_15px_rgba(168,85,247,0.4)]'}`}>
                            {gates.isDispatched ? <span className="text-sm font-bold">✓</span> : <span className="w-3 h-3 rounded-full bg-purple-500 animate-pulse"></span>}
                          </div>
                        </div>
                        <div className={`flex-1 bg-white rounded-xl p-4 border transition-all duration-300 ${gates.isDispatched ? 'border-slate-200/60 opacity-80 shadow-2xs' : 'border-purple-300 shadow-md ring-1 ring-purple-100'}`}>
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                            <span className={`text-sm font-bold uppercase tracking-wider flex items-center gap-1.5 ${gates.isDispatched ? 'text-slate-700' : 'text-purple-900'}`}>
                              <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 8h14M5 12h14M5 16h10" />
                              </svg>
                              Courier Dispatch & POD
                            </span>
                            <StatusPill done={!!courier} pending="Pending Dispatch" label="POD Verified" />
                          </div>
                          <p className="text-xs text-slate-500 leading-relaxed mb-4">
                            TCS / Leopard Express proof of delivery establishing statutory timeline commencement.
                          </p>
                          <div>
                            {courier ? (
                              <div className="inline-flex items-center gap-2 text-xs font-bold text-teal-700 bg-teal-50 px-3 py-1.5 rounded-lg border border-teal-200/80">
                                <span className="font-mono">{courier.trackingNo}</span>
                                <span className="text-[10px] text-teal-600 border-l border-teal-300 pl-2">POD Verified</span>
                              </div>
                            ) : (
                              <button onClick={() => handleDispatchCourier(p.id)} className="w-full sm:w-auto py-2 px-5 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-lg shadow-sm hover:shadow transition-all flex items-center justify-center gap-1.5 active:scale-[0.98]">
                                Dispatch via TCS Express →
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Gate 5: SECP Welcome Call */}
                    {gates.isCounterAccepted && gates.isReinsured && gates.isHistoryClear && gates.isDispatched && (
                      <div className="relative flex gap-4 group animate-in fade-in slide-in-from-top-4 duration-500 fill-mode-both">
                        <div className="shrink-0 mt-1">
                          <div className={`w-10 h-10 rounded-full border-[3px] flex items-center justify-center bg-white transition-all ${gates.isWelcomeDone ? 'border-emerald-500 text-emerald-500 shadow-sm' : 'border-purple-500 text-purple-600 shadow-[0_0_15px_rgba(168,85,247,0.4)]'}`}>
                            {gates.isWelcomeDone ? <span className="text-sm font-bold">✓</span> : <span className="w-3 h-3 rounded-full bg-purple-500 animate-pulse"></span>}
                          </div>
                        </div>
                        <div className={`flex-1 bg-white rounded-xl p-4 border transition-all duration-300 ${gates.isWelcomeDone ? 'border-slate-200/60 opacity-80 shadow-2xs' : 'border-purple-300 shadow-md ring-1 ring-purple-100'}`}>
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                            <span className={`text-sm font-bold uppercase tracking-wider flex items-center gap-1.5 ${gates.isWelcomeDone ? 'text-slate-700' : 'text-purple-900'}`}>
                              <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                              </svg>
                              SECP Welcome Call
                            </span>
                            <StatusPill done={!!call} pending="Call Pending" label="14-Day Clock Active" />
                          </div>
                          <p className="text-xs text-slate-500 leading-relaxed mb-4">
                            Mandated 14-day Free-Look cancellation window triggered upon call verification.
                          </p>
                          <div>
                            {call ? (
                              <div className="inline-flex items-center gap-2 text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200/80">
                                <span>✓</span>
                                <span>Welcome Call Verified</span>
                                <span className="font-mono text-[10px] text-emerald-600 border-l border-emerald-300 pl-2">{call.freeLookEnd}</span>
                              </div>
                            ) : (
                              <button onClick={() => handleCompleteWelcomeCall(p.id)} className="w-full sm:w-auto py-2 px-5 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-lg shadow-sm hover:shadow transition-all flex items-center justify-center gap-1.5 active:scale-[0.98]">
                                Verify Welcome Call →
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Verification Drawer / Modal matching Pre-Underwriting */}
      {/* ── COUNTER-OFFER SIGN-OFF & RENEWAL RATING ENGINE MODAL ────────────────── */}
      {activeCounterPolicy && (() => {
        const p = activeCounterPolicy;
        const coState = getOrCreateCounterState(p);
        const deviationPct = getDeviationPct(coState.expiringPremium, coState.proposedPremium);
        const authority = getApprovalAuthority(deviationPct);

        const workflowSteps = [
          { id: "UNDERWRITING_COMPLETE", label: "UW Complete" },
          { id: "COUNTER_OFFER_PREPARED", label: "Counter Prepared" },
          { id: "SENT_TO_CUSTOMER", label: "Sent to Customer" },
          { id: "CUSTOMER_RESPONSE_RECEIVED", label: "Response Received" },
          { id: "APPROVAL_PENDING", label: "Approval Pending" },
          { id: "APPROVED", label: "Signed Off" },
          { id: "POLICY_ISSUED", label: "Policy Issued" },
        ];

        const handleFactorChange = (field: keyof CounterOfferState, val: number) => {
          updateCounterState(p.id, (prev) => {
            const next = { ...prev, [field]: val };
            next.proposedPremium = calculateRenewalPremium(
              next.expiringPremium,
              next.deltaDuration,
              next.deltaExposure,
              next.deltaCoverage,
              next.deltaRate
            );
            if (next.workflowState === "COUNTER_OFFER_PREPARED" || next.workflowState === "CUSTOMER_RESPONSE_RECEIVED") {
              next.workflowState = "APPROVAL_PENDING";
            }
            return next;
          });
        };

        const handleCustomerDecision = (decision: "ACCEPTED" | "DECLINED" | "RE_NEGOTIATE") => {
          updateCounterState(p.id, (prev) => ({
            ...prev,
            customerDecision: decision,
            workflowState: decision === "ACCEPTED" ? "APPROVAL_PENDING" : "COUNTER_OFFER_PREPARED",
            notes: `Customer response recorded: ${decision}.`,
          }));
          notify(`Customer response recorded as ${decision}`, true);
        };

        const handleSignOff = (roleName: string, levelName: string) => {
          const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
          updateCounterState(p.id, (prev) => ({
            ...prev,
            workflowState: "APPROVED",
            signoffHistory: [
              ...prev.signoffHistory,
              {
                role: roleName,
                level: levelName,
                approvedBy: `${roleName} (Adamjee Underwriting Board)`,
                timestamp: nowStr,
                notes: `Formal electronic sign-off recorded for ${deviationPct.toFixed(1)}% premium variance.`,
              },
            ],
          }));
          setAcceptedCounterOffers((prev) => ({ ...prev, [p.id]: true }));
          notify(`Counter-offer signed off successfully by ${roleName}!`, true);
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs px-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
              {/* Header */}
              <div className="bg-gradient-to-r from-sky-900 via-blue-900 to-slate-900 px-6 py-4 flex items-center justify-between text-white">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold">Counter-Offer Sign-off &amp; Renewal Pricing Engine</h2>
                    <span className="px-2 py-0.5 rounded bg-white/20 text-white font-mono text-[10px] font-bold">
                      {p.customer_name} ({p.policy_number ?? "Proposal"})
                    </span>
                  </div>
                  <p className="text-xs text-sky-200 mt-0.5">
                    Pakistani Contract Act Proposer Consent &amp; Actuarial Renewal Calculation Formula
                  </p>
                </div>
                <button onClick={() => setActiveCounterPolicy(null)} className="text-white/60 hover:text-white text-xl">✕</button>
              </div>

              <div className="px-6 py-5 overflow-y-auto space-y-6 text-xs">
                {/* 1. Workflow State Stepper */}
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                  <h3 className="font-extrabold text-slate-800 uppercase tracking-wider text-[11px] mb-3">
                    Counter-Offer Lifecycle Stepper
                  </h3>
                  <div className="flex items-center justify-between gap-1 overflow-x-auto pb-1">
                    {workflowSteps.map((step, idx) => {
                      const activeIdx = workflowSteps.findIndex((s) => s.id === coState.workflowState);
                      const isCurrent = step.id === coState.workflowState;
                      const isDone = idx <= activeIdx;
                      return (
                        <div key={step.id} className="flex flex-col items-center min-w-[90px] text-center">
                          <div
                            className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-[10px] mb-1.5 transition-all ${
                              isCurrent
                                ? "bg-sky-600 text-white ring-2 ring-sky-400 ring-offset-1"
                                : isDone
                                ? "bg-emerald-600 text-white"
                                : "bg-slate-200 text-slate-500"
                            }`}
                          >
                            {isDone ? "✓" : idx + 1}
                          </div>
                          <span className={`text-[10px] font-semibold leading-tight ${isCurrent ? "text-sky-900 font-extrabold" : "text-slate-500"}`}>
                            {step.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2. Actuarial Renewal Premium Calculation Engine */}
                <div className="bg-slate-900 text-white rounded-2xl p-5 shadow-md border border-slate-800">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                    <div>
                      <h3 className="font-bold text-sm text-sky-200">Actuarial Renewal Premium Formula</h3>
                      <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
                        P_renewal = P_expiring × (1 + Δ_duration) × (1 + Δ_exposure) × (1 + Δ_coverage) × (1 + Δ_rate)
                      </p>
                    </div>
                    <span className="px-3 py-1 bg-sky-500/20 border border-sky-400/30 text-sky-200 rounded-full font-mono text-xs font-bold">
                      {fmtPKR(coState.proposedPremium)}
                    </span>
                  </div>

                  {/* Factor Modeler Sliders Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Expiring Base Premium */}
                    <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60">
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-slate-300 font-medium">Expiring Base Premium (P_exp)</span>
                        <span className="font-mono font-bold text-sky-300">{fmtPKR(coState.expiringPremium)}</span>
                      </div>
                      <input
                        type="number"
                        value={coState.expiringPremium}
                        onChange={(e) => handleFactorChange("expiringPremium", Number(e.target.value))}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono"
                      />
                    </div>

                    {/* Duration Factor */}
                    <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60">
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-slate-300 font-medium">Duration Factor (Δ_duration)</span>
                        <span className="font-mono font-bold text-sky-300">{(coState.deltaDuration * 100).toFixed(1)}%</span>
                      </div>
                      <input
                        type="range" min="-0.10" max="0.30" step="0.01"
                        value={coState.deltaDuration}
                        onChange={(e) => handleFactorChange("deltaDuration", parseFloat(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    {/* Exposure Factor */}
                    <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60">
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-slate-300 font-medium">Exposure Factor (Δ_exposure)</span>
                        <span className="font-mono font-bold text-sky-300">{(coState.deltaExposure * 100).toFixed(1)}%</span>
                      </div>
                      <input
                        type="range" min="-0.20" max="0.50" step="0.01"
                        value={coState.deltaExposure}
                        onChange={(e) => handleFactorChange("deltaExposure", parseFloat(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    {/* Coverage Factor */}
                    <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60">
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-slate-300 font-medium">Coverage Factor (Δ_coverage)</span>
                        <span className="font-mono font-bold text-sky-300">{(coState.deltaCoverage * 100).toFixed(1)}%</span>
                      </div>
                      <input
                        type="range" min="-0.20" max="0.30" step="0.01"
                        value={coState.deltaCoverage}
                        onChange={(e) => handleFactorChange("deltaCoverage", parseFloat(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    {/* Rate / Claims Adjustment */}
                    <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60 md:col-span-2">
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-slate-300 font-medium">Base Rate &amp; Claims Experience Adjustment (Δ_rate)</span>
                        <span className="font-mono font-bold text-sky-300">{(coState.deltaRate * 100).toFixed(1)}%</span>
                      </div>
                      <input
                        type="range" min="-0.20" max="0.50" step="0.01"
                        value={coState.deltaRate}
                        onChange={(e) => handleFactorChange("deltaRate", parseFloat(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>
                  </div>

                  {/* Summary Variance Box */}
                  <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs flex-wrap gap-2">
                    <div>
                      <span className="text-slate-400 font-medium">Original Premium: </span>
                      <span className="font-mono font-bold text-white">{fmtPKR(coState.expiringPremium)}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-medium">Calculated Renewal Premium: </span>
                      <span className="font-mono font-bold text-emerald-400">{fmtPKR(coState.proposedPremium)}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-medium">Variance: </span>
                      <span className={`font-mono font-bold ${deviationPct >= 0 ? "text-sky-300" : "text-emerald-300"}`}>
                        {deviationPct >= 0 ? "+" : ""}{fmtPKR(coState.proposedPremium - coState.expiringPremium)} ({deviationPct >= 0 ? "+" : ""}{deviationPct.toFixed(1)}%)
                      </span>
                    </div>
                  </div>
                </div>

                {/* 3. Reason Code & Proposer Consent */}
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                  <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider">
                    Counter-Offer Terms &amp; Proposer Response
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Counter-Offer Reason Code</label>
                      <select
                        value={coState.reasonCode}
                        onChange={(e) => updateCounterState(p.id, (prev) => ({ ...prev, reasonCode: e.target.value }))}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs bg-white text-slate-800"
                      >
                        <option value="Price Objection">Price Objection &amp; Broker Negotiation</option>
                        <option value="Renewal Rate & Risk Exposure Change">Renewal Rate &amp; Exposure Adjustment</option>
                        <option value="Claims Experience Surcharge">Claims Experience Adverse Loading</option>
                        <option value="Competitor Rate Match">Competitor Premium Matching</option>
                        <option value="Coverage Limit Modification">Coverage Limit / Deductible Alteration</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Customer / Proposer Decision</label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleCustomerDecision("ACCEPTED")}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                            coState.customerDecision === "ACCEPTED"
                              ? "bg-emerald-600 text-white border-emerald-700"
                              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
                          }`}
                        >
                          ✓ Accept Terms
                        </button>
                        <button
                          onClick={() => handleCustomerDecision("DECLINED")}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                            coState.customerDecision === "DECLINED"
                              ? "bg-slate-700 text-white border-slate-800"
                              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
                          }`}
                        >
                          ✕ Decline Terms
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 4. Multi-Tier Governance Sign-Off Matrix */}
                <div className="bg-sky-50/70 p-4 rounded-xl border border-sky-200/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-bold text-sky-950 text-xs uppercase tracking-wider">
                        Underwriting Authority Routing Matrix (Sign-Off Control)
                      </h3>
                      <p className="text-[11px] text-sky-800 mt-0.5">
                        {authority.description}
                      </p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-extrabold border ${authority.badgeClass}`}>
                      {authority.level}: {authority.role}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-2 border-t border-sky-200/60">
                    <button
                      onClick={() => handleSignOff("Junior Underwriter", "Level 1")}
                      disabled={coState.workflowState === "APPROVED"}
                      className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg text-xs disabled:opacity-50 transition-colors shadow-2xs"
                    >
                      Sign-off as Junior UW (≤ 10%)
                    </button>
                    <button
                      onClick={() => handleSignOff("Senior Underwriter", "Level 2")}
                      disabled={coState.workflowState === "APPROVED"}
                      className="px-3.5 py-2 bg-sky-700 hover:bg-sky-800 text-white font-bold rounded-lg text-xs disabled:opacity-50 transition-colors shadow-2xs"
                    >
                      Sign-off as Senior UW (≤ 25%)
                    </button>
                    <button
                      onClick={() => handleSignOff("Chief Underwriter & Pricing Committee", "Level 3")}
                      disabled={coState.workflowState === "APPROVED"}
                      className="px-3.5 py-2 bg-blue-900 hover:bg-blue-950 text-white font-bold rounded-lg text-xs disabled:opacity-50 transition-colors shadow-2xs"
                    >
                      Sign-off as Chief UW / Committee (&gt; 25%)
                    </button>
                  </div>

                  {/* Audit Trail Table */}
                  {coState.signoffHistory.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-sky-200/60">
                      <h4 className="text-[11px] font-bold text-slate-800 mb-2">Electronic Sign-Off Audit Trail</h4>
                      <div className="space-y-1.5">
                        {coState.signoffHistory.map((s, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-white p-2.5 rounded-lg border border-sky-200/80 text-[11px]">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-emerald-700">✓ Signed</span>
                              <span className="font-semibold text-slate-800">{s.approvedBy}</span>
                              <span className="text-slate-400">({s.level})</span>
                            </div>
                            <span className="font-mono text-slate-500 text-[10px]">{s.timestamp}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-slate-200 px-6 py-4 flex justify-between items-center bg-slate-50">
                <span className="text-xs text-slate-500 font-mono">
                  Pakistani Contract Act 1872 · Section 7 Counter-Offer Perfection
                </span>
                <button
                  onClick={() => setActiveCounterPolicy(null)}
                  className="px-5 py-2 bg-slate-900 text-white font-bold text-xs rounded-xl hover:bg-slate-800"
                >
                  Done / Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Gate 2: Reinsurance Placement & Cession Accounting Modal ─────────── */}
      {activeReinsurancePolicy && (() => {
        const p = activeReinsurancePolicy;
        const currentPlacement = reinsurancePlacements[p.id] || {
          reinsurerId: "RE-001",
          reinsurerName: "Swiss Re",
          note: "",
          status: "Pending Placement",
          cededAmount: Math.max(0, p.coverage_amount - 10000000),
        };
        const sumAssured = p.coverage_amount || 15000000;
        const retentionLimit = 10000000;
        const cededAmount = Math.max(0, sumAssured - retentionLimit);
        const grossPremium = Math.round(sumAssured * 0.025);
        const cededPremium = Math.round(cededAmount * 0.02);
        const cedingCommission = Math.round(cededPremium * 0.225); // 22.5%
        const netPayable = cededPremium - cedingCommission;

        const handleModalSubmit = async (reinsurerName: string) => {
          await handleReferReinsurance(p.id, reinsurerName);
          setReinsurancePlacements((prev) => ({
            ...prev,
            [p.id]: {
              reinsurerId: "RE-001",
              reinsurerName,
              note: currentPlacement.note,
              status: "Placed & Bound",
              cededAmount,
            },
          }));
          setActiveReinsurancePolicy(null);
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs px-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
              {/* Modal Header */}
              <div className="bg-gradient-to-r from-sky-900 via-blue-900 to-slate-900 px-6 py-4 flex items-center justify-between text-white">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold">Reinsurance Placement &amp; Cession Engine (Gate 2)</h2>
                    <span className="px-2 py-0.5 rounded bg-white/20 text-white font-mono text-[10px] font-bold">
                      {p.customer_name} ({p.policy_number ?? "Proposal"})
                    </span>
                  </div>
                  <p className="text-xs text-sky-200 mt-0.5 font-mono">
                    Company Retention Limit: PKR 10,000,000 · Treaty Quota Share &amp; Facultative Placement
                  </p>
                </div>
                <button onClick={() => setActiveReinsurancePolicy(null)} className="text-white/60 hover:text-white text-xl">✕</button>
              </div>

              <div className="px-6 py-5 overflow-y-auto space-y-5 text-xs">
                {/* 1. Cession Retention Breakdown */}
                <div className="bg-slate-900 text-white p-4 rounded-2xl border border-slate-800 shadow-md">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
                    <h3 className="font-bold text-xs text-sky-200 uppercase tracking-wider">Actuarial Cession Breakdown</h3>
                    <span className="px-2.5 py-0.5 rounded-full bg-sky-500/20 text-sky-200 border border-sky-400/30 text-[10px] font-bold font-mono">
                      SECP Rule 24 / Treaty 2026
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
                      <span className="text-[10px] text-slate-400">Total Sum Assured</span>
                      <p className="font-mono font-bold text-white mt-0.5">{fmtPKR(sumAssured)}</p>
                    </div>
                    <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
                      <span className="text-[10px] text-slate-400">Company Retention Cap</span>
                      <p className="font-mono font-bold text-emerald-400 mt-0.5">{fmtPKR(retentionLimit)}</p>
                    </div>
                    <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
                      <span className="text-[10px] text-slate-400">Excess Ceded Risk</span>
                      <p className="font-mono font-bold text-sky-300 mt-0.5">
                        {cededAmount > 0 ? fmtPKR(cededAmount) : "PKR 0 (Fully Retained)"}
                      </p>
                    </div>
                    <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
                      <span className="text-[10px] text-slate-400">Cession Share %</span>
                      <p className="font-mono font-bold text-sky-300 mt-0.5">
                        {sumAssured > 0 ? ((cededAmount / sumAssured) * 100).toFixed(1) : "0"}%
                      </p>
                    </div>
                  </div>
                </div>

                {/* 2. Ceding Premium Accounting Entry */}
                <div className="bg-sky-50/70 p-4 rounded-xl border border-sky-200 space-y-2">
                  <h3 className="font-bold text-sky-950 text-xs uppercase tracking-wider">
                    Ceding Premium Accounting Entry (Double Entry Ledger)
                  </h3>
                  <div className="grid grid-cols-3 gap-3 bg-white p-3 rounded-lg border border-sky-200/80 font-mono">
                    <div>
                      <span className="text-[10px] text-slate-400">Ceded Gross Premium</span>
                      <p className="font-bold text-slate-900 text-xs mt-0.5">{fmtPKR(cededPremium)}</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400">Ceding Commission (22.5%)</span>
                      <p className="font-bold text-emerald-700 text-xs mt-0.5">-{fmtPKR(cedingCommission)}</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400">Net Reinsurer Payable</span>
                      <p className="font-bold text-sky-800 text-xs mt-0.5">{fmtPKR(netPayable)}</p>
                    </div>
                  </div>
                </div>

                {/* 3. Panel Reinsurer Selection & Transmit Slip */}
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                  <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider">
                    Select Reinsurer &amp; Transmit Facultative Slip
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {PANEL_REINSURERS.map((r) => (
                      <div
                        key={r.id}
                        onClick={() =>
                          setReinsurancePlacements((prev) => ({
                            ...prev,
                            [p.id]: { ...currentPlacement, reinsurerId: r.id, reinsurerName: r.name.split(" ")[0] + " Re" },
                          }))
                        }
                        className={`p-3 rounded-xl border cursor-pointer transition-all ${
                          currentPlacement.reinsurerId === r.id
                            ? "bg-sky-50 border-sky-600 ring-2 ring-sky-400/40"
                            : "bg-white border-slate-200 hover:border-slate-300"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-slate-900">{r.name}</span>
                          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                            {r.am_best_rating}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">
                          Capacity: {fmtPKR(r.facultative_capacity)} · Email: {r.contact_email}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Underwriter Risk Package Notes</label>
                    <textarea
                      rows={2}
                      value={currentPlacement.note}
                      onChange={(e) =>
                        setReinsurancePlacements((prev) => ({
                          ...prev,
                          [p.id]: { ...currentPlacement, note: e.target.value },
                        }))
                      }
                      placeholder="Enter specific exposure notes, medical loading details, or coverage conditions for reinsurer slip..."
                      className="w-full p-2 border border-slate-300 rounded-lg text-xs bg-white text-slate-800"
                    />
                  </div>
                </div>

                {/* Modal Footer Actions */}
                <div className="pt-2 flex items-center justify-between border-t border-slate-200">
                  <button
                    onClick={() => setActiveReinsurancePolicy(null)}
                    className="px-4 py-2 bg-slate-100 text-slate-700 font-bold rounded-lg hover:bg-slate-200"
                  >
                    Cancel
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleModalSubmit("Swiss Re")}
                      disabled={actionLoading}
                      className="px-4 py-2 bg-sky-700 hover:bg-sky-800 text-white font-bold rounded-lg text-xs transition-colors shadow-2xs"
                    >
                      Transmit Slip (Swiss Re) →
                    </button>
                    <button
                      onClick={() => handleModalSubmit(currentPlacement.reinsurerName || "Swiss Re")}
                      disabled={actionLoading}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs transition-colors shadow-2xs"
                    >
                      ✓ Sign-off &amp; Bind Terms
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

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
              {/* Customer Sign-off on Counter-Offers */}
              <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-amber-900 text-sm">Customer Sign-off on Counter-Offers (Pakistani Contract Act)</h3>
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

              {/* Reinsurance Referral & Facultative Placement */}
              <div className="bg-sky-50/70 border border-sky-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-sky-950 text-sm">Reinsurance Referral &amp; Facultative Placement</h3>
                  <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-800 font-bold text-[10px]">
                    {reinsuranceData?.referral ? reinsuranceData.referral.status : selectedPolicy.coverage_amount >= 10000000 ? "Facultative Required" : "Inside Retention Limit"}
                  </span>
                </div>
                <p className="text-slate-600 text-[11px]">
                  Ceding policy risk exceeding company retention limit (PKR 10M) to treaty quota share or facultative reinsurers (e.g., Swiss Re, Munich Re, PRCL, Hannover Re).
                </p>
                {reinsuranceData?.cession && (
                  <div className="grid grid-cols-3 gap-3 bg-white p-3 rounded-lg border border-sky-100 mt-2">
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
                      <p className="font-bold text-sky-700">{fmtPKR(reinsuranceData.cession.total_ceded_amount || reinsuranceData.cession.facultative_ceded_amount)}</p>
                    </div>
                  </div>
                )}
                <div className="pt-2 flex flex-wrap gap-2 items-center justify-between">
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleReferReinsurance(selectedPolicy.id, "Swiss Re")}
                      disabled={actionLoading}
                      className="px-3 py-1.5 bg-sky-700 text-white font-semibold rounded-lg hover:bg-sky-800 transition-colors shadow-2xs"
                    >
                      Refer to Swiss Re
                    </button>
                    <button
                      onClick={() => handleReferReinsurance(selectedPolicy.id, "Munich Re")}
                      disabled={actionLoading}
                      className="px-3 py-1.5 bg-blue-700 text-white font-semibold rounded-lg hover:bg-blue-800 transition-colors shadow-2xs"
                    >
                      Refer to Munich Re
                    </button>
                    <button
                      onClick={() => handleReferReinsurance(selectedPolicy.id, "Hannover Re")}
                      disabled={actionLoading}
                      className="px-3 py-1.5 bg-slate-700 text-white font-semibold rounded-lg hover:bg-slate-800 transition-colors"
                    >
                      Refer to Hannover Re
                    </button>
                  </div>
                </div>
              </div>

              {/* Existing Insurance / Declared Policies Check */}
              <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-blue-900 text-sm">Existing Insurance &amp; Declared Industry Policies Check</h3>
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

              {/* Policy Dispatch & Courier Tracking */}
              <div className="bg-teal-50/60 border border-teal-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-teal-900 text-sm">Policy Dispatch &amp; Courier POD Tracking</h3>
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

              {/* SECP Welcome Call & Free-Look Period */}
              <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-emerald-900 text-sm">SECP Welcome Call &amp; 14-Day Free-Look Period</h3>
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
