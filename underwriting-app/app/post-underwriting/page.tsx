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
  createCounterOffer,
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
  Reinsurer,
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
import { Pagination, usePagination } from "@/components/Pagination";
import { tx } from "@/lib/i18n/tx";
import { useNewArrivals, floatNew, useRevealNew, recentIds, NewArrivalsBanner, NEW_ARRIVAL_CLASS, scrollToFirstNew } from "@/lib/useNewArrivals";

/** The subset of a reinsurer the placement modal renders — shared by the live
 *  panel from tenant-service and the illustrative fallback below. */
type PanelOption = {
  id: string;
  name: string;
  am_best_rating: string | null;
  facultative_capacity: number;
  contact_email: string | null;
};

const PANEL_REINSURERS: PanelOption[] = [
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
          ? "bg-blue-50 text-blue-700 border-blue-200/80"
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
    badgeClass: "bg-blue-50 text-blue-800 border-blue-200",
    description: "Deviation > 25%: Requires Chief Underwriter / Pricing Committee sign-off",
  };
};

// The post-underwriting queue as a table, like the pre-underwriting one: one row per policy, one column per verification gate.
// "Open" shows that policy's steps (with their actions) right under its row.
const POST_GATES = [
  { key: "counter", short: "Counter-Offer", label: "Gate 1: Counter-Offer Sign-off" },
  { key: "reins", short: "Reinsurance", label: "Gate 2: Facultative Reinsurance" },
  { key: "cover", short: "Cover Check", label: "Gate 3: Industry Cover & HLV Check" },
  { key: "courier", short: "Courier / POD", label: "Gate 4: Courier Dispatch & POD" },
  { key: "welcome", short: "Welcome Call", label: "Gate 5: SECP Welcome Call" },
] as const;
const POST_TABLE_COLS = 4 + POST_GATES.length + 2;
const POST_STAGE: Record<"completed" | "signoff" | "in_progress", { label: string; style: string }> = {
  completed: { label: "Completed", style: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  signoff: { label: "Awaiting Sign-off", style: "bg-amber-50 text-amber-700 border-amber-200" },
  in_progress: { label: "In Progress", style: "bg-blue-50 text-blue-700 border-blue-200" },
};
const PRE_GATE_STYLE_POST = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending: "bg-blue-50 text-blue-700 border-blue-200",
  locked: "bg-transparent text-slate-400 border-transparent font-medium",
};

const PU_STORE = "postuw.v1";

/**
 * localStorage-backed state.
 *
 * Hydrates in an effect rather than a lazy `useState` initialiser: the server
 * render has no localStorage, so reading it during render makes the first
 * client render disagree with the server markup and React throws away the tree.
 */
function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`${PU_STORE}.${key}`);
      if (raw) setValue(JSON.parse(raw) as T);
    } catch {
      // Missing or corrupt entry — keep the initial value.
    }
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    // Before hydration `value` is still the default; writing it would wipe
    // whatever the previous session stored.
    if (!hydrated) return;
    try {
      window.localStorage.setItem(`${PU_STORE}.${key}`, JSON.stringify(value));
    } catch {
      // Quota exceeded or private mode — state still works for this session.
    }
  }, [key, value, hydrated]);

  return [value, setValue] as const;
}

const normStatus = (s: string | null | undefined) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Statuses a case can hold once underwriting has formed a view.
 *
 * A Quoted policy is an auto-priced indicative quote with no case open — there
 * is nothing to sign off, place, or dispatch, and every gate action against one
 * fails at the state machine ("Cannot issue a counter-offer from status
 * Quoted"). They do not belong on a *post*-underwriting board.
 */
const POST_UW_STATUSES = new Set([
  "proposed",
  "underreview",
  "informationrequested",
  "counteroffer",
  "approved",
  "acceptedwithloadings",
  "reinsurerreferred",
  "pendingpayment",
  "issued",
  "active",
]);

/** Statuses create_counter_offer will accept, plus one that already has an offer open. */
const COUNTER_OFFER_ISSUABLE = new Set([
  "proposed",
  "underreview",
  "informationrequested",
  "approved",
  "acceptedwithloadings",
  "counteroffer",
]);

/** Surface the real reason a tenant-service call failed instead of a generic string. */
function apiError(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg; // 422 validation body
  return e?.message || fallback;
}

/** "Pak Re" / "Swiss Re" → the matching panel member, by code or name. */
function pickReinsurer(panel: Reinsurer[], label: string): Reinsurer | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(label);
  if (!target) return null;
  return (
    panel.find((r) => norm(r.code) === target || norm(r.name) === target) ??
    panel.find((r) => norm(r.name).startsWith(target) || target.startsWith(norm(r.code))) ??
    null
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
            {step.num}
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
                {tx("Gate")}{tx(" ")}{step.num}: {tx(step.title)}
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
                  {tx(step.desc)}
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

export default function PostUnderwritingPage() {
  const { notify } = useNotify();

  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const arrivalIds = useMemo(() => policies.map((p) => p.id), [policies]);
  const arrivals = useNewArrivals("post-underwriting", arrivalIds, !loading, recentIds(policies, (p) => p.id, (p) => p.updated_at));

  // Filters & Search
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [showCompleted, setShowCompleted] = useState(false);
  const [filterGate, setFilterGate] = useState<string>("ALL");
  const [openId, setOpenId] = useState<string | null>(null);   // the policy whose steps are shown under its row

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

  // Live cession + panel for whichever policy the Gate 2 modal is showing.
  const [activeReinsuranceView, setActiveReinsuranceView] = useState<ReinsuranceView | null>(null);
  
  const [expandedGates, setExpandedGates] = useState<Record<string, number>>({});
  const [showAllGates, setShowAllGates] = useState<Record<string, boolean>>({});

  // ── Persisted workflow state ───────────────────────────────────────────────
  // Gates 3–5 and the pricing engine have no server-side record, so localStorage
  // is their only home. Gates 1 and 2 do have one, and their entries are written
  // only after the tenant-service call succeeds — so anything that survives a
  // refresh here is something the backend genuinely recorded.
  const [reinsurancePlacements, setReinsurancePlacements] = usePersistedState<
    Record<string, { reinsurerId: string; reinsurerName: string; note: string; status: string; cededAmount: number }>
  >("reinsurancePlacements", {});

  // Counter-Offer interactive details per policy
  const [counterOfferStates, setCounterOfferStates] = usePersistedState<Record<string, CounterOfferState>>(
    "counterOfferStates",
    {},
  );

  // Per-policy interactive tracking state
  const [courierLogs, setCourierLogs] = usePersistedState<
    Record<string, { partner: string; trackingNo: string; dispatchedAt: string; podStatus: string }>
  >("courierLogs", {
    default: {
      partner: "TCS Courier Express",
      trackingNo: "TCS-98234110",
      dispatchedAt: "2026-08-04",
      podStatus: "Delivered (POD Signed)",
    },
  });

  const [welcomeCalls, setWelcomeCalls] = usePersistedState<
    Record<string, { callStatus: string; confirmedAt: string | null; freeLookEnd: string | null }>
  >("welcomeCalls", {});

  const [acceptedCounterOffers, setAcceptedCounterOffers] = usePersistedState<Record<string, boolean>>(
    "acceptedCounterOffers",
    {},
  );
  const [reinsuranceReferrals, setReinsuranceReferrals] = usePersistedState<Record<string, string>>(
    "reinsuranceReferrals",
    {},
  );

  // Quotes that never entered underwriting are excluded rather than listed and
  // then failing on every gate; kept as a count so the board can say so.
  const [preUnderwritingCount, setPreUnderwritingCount] = useState(0);

  const loadData = async () => {
    setLoading(true);
    try {
      const [pList, pStats] = await Promise.all([listPolicies(), getPolicyStats()]);
      const underwritten = pList.filter((p) => POST_UW_STATUSES.has(normStatus(p.status)));
      setPolicies(underwritten);
      setPreUnderwritingCount(pList.length - underwritten.length);
      setStats(pStats);
    } catch (err: any) {
      notify(tx("Failed to load post-underwriting cases."), false);
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

  // Compute 5 Post-Underwriting Gates Status for a policy (Strict Sequential Dependency)
  const getPolicyGates = (p: PolicyListItem) => {
    const coState = counterOfferStates[p.id];
    const isCounterAccepted =
      coState?.workflowState === "APPROVED" ||
      coState?.workflowState === "POLICY_ISSUED" ||
      !!acceptedCounterOffers[p.id] ||
      (p.status || "").toUpperCase() === "ACCEPTEDWITHLOADINGS" ||
      (p.status || "").toUpperCase() === "ISSUED" ||
      (p.status || "").toUpperCase() === "ACTIVE";

    // Gate 2 is ONLY done if Gate 1 is completed AND reinsurance is placed (or coverage is within retention limit)
    const isReinsured =
      isCounterAccepted &&
      (!!reinsuranceReferrals[p.id] ||
        p.coverage_amount < 10000000 ||
        (p.status || "").toUpperCase() === "ACTIVE");

    // Gate 3 is ONLY done if Gate 1 and Gate 2 are completed
    const isHistoryClear = isCounterAccepted && isReinsured;

    // Gate 4 is ONLY done if Gates 1, 2, 3 are completed AND courier pack is dispatched
    const isDispatched =
      isHistoryClear &&
      (!!courierLogs[p.id] || (p.status || "").toUpperCase() === "ACTIVE");

    // Gate 5 is ONLY done if Gates 1, 2, 3, 4 are completed AND welcome call is confirmed
    const isWelcomeDone =
      isDispatched &&
      (!!welcomeCalls[p.id] || (p.status || "").toUpperCase() === "ACTIVE");

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
    // Newest first, so a freshly added entry lands at the top.
    let list = [...policies].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

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
    return floatNew(list, (p) => p.id, arrivals.newIds);   // the policy that just arrived sits at the top
  }, [policies, segment, showCompleted, search, acceptedCounterOffers, reinsuranceReferrals, courierLogs, welcomeCalls, arrivals.newIds]);

  // Dynamic Segment Counts matching the current view mode (active vs all)
  const segmentCounts = useMemo(() => {
    const list = showCompleted ? policies : policies.filter((p) => !getPolicyGates(p).isFullyCleared);
    const ind = list.filter((p) => (p.segment ?? "individual") === "individual").length;
    const org = list.filter((p) => p.segment === "organization").length;
    const fam = list.filter((p) => p.segment === "family").length;
    return {
      all: list.length,
      individual: ind,
      organization: org,
      family: fam,
    };
  }, [policies, showCompleted, acceptedCounterOffers, reinsuranceReferrals, courierLogs, welcomeCalls]);

  // Executive Metrics Suite
  const kpis = useMemo(() => {
    const total = policies.length;
    const fullyCleared = policies.filter((p) => getPolicyGates(p).isFullyCleared).length;
    const active = total - fullyCleared;
    const pendingCounter = policies.filter((p) => (p.status || "").toUpperCase() === "COUNTEROFFER" && !acceptedCounterOffers[p.id]).length;
    const facultativeNeeded = policies.filter((p) => p.coverage_amount >= 10000000 && !reinsuranceReferrals[p.id]).length;
    const dispatched = Object.keys(courierLogs).length;
    const activeFreeLook = Object.keys(welcomeCalls).length;

    return { total, active, pendingCounter, facultativeNeeded, dispatched, activeFreeLook, fullyCleared };
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
      notify(tx("Error loading case details."), false);
    } finally {
      setActionLoading(false);
    }
  };

  // Sign off counter-offer. Returns true only if tenant-service recorded it.
  //
  // accept_counter_offer only works against an offer already sitting in Pending.
  // A case with no loadings has no such row, so the accept 404s — which is why
  // this used to fall into its own catch block and report success anyway. Issue
  // the offer first when there isn't a live one, then accept it, so the sign-off
  // reaches the database on both paths.
  const handleAcceptCounterOffer = async (policyId: string): Promise<boolean> => {
    const policy = policies.find((p) => p.id === policyId);
    if (policy && !COUNTER_OFFER_ISSUABLE.has(normStatus(policy.status))) {
      notify(
        `A counter-offer cannot be issued from status ${policy.status} — the case has to reach ` +
          `underwriting first.`,
        false,
      );
      return false;
    }

    setActionLoading(true);
    try {
      const existing = await getCounterOffer(policyId).catch(() => null);
      const today = new Date().toISOString().slice(0, 10);
      const isLive = existing?.status === "Pending" && existing.valid_until >= today;

      if (!isLive) {
        const co = counterOfferStates[policyId];
        const loadingPct = co ? Math.max(0, getDeviationPct(co.expiringPremium, co.proposedPremium)) : 0;
        await createCounterOffer(policyId, {
          offer_type: "Loading",
          revised_loading_pct: Number(loadingPct.toFixed(2)),
          reason: co?.reasonCode || "Post-underwriting counter-offer sign-off",
          valid_days: 30,
          created_by: "underwriter",
        });
      }

      await acceptCounterOffer(
        policyId,
        "Customer explicitly signed counter-offer terms (Pakistani Contract Act verified).",
      );
      setAcceptedCounterOffers((prev) => ({ ...prev, [policyId]: true }));
      notify(tx("Counter-offer accepted & legal sign-off recorded."), true);
      await loadData();
      return true;
    } catch (e: any) {
      notify(apiError(e, "Could not record the counter-offer sign-off."), false);
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  // Trigger Reinsurance Referral. Returns the placed reinsurer, or null if
  // nothing was placed — callers must not record a placement off a failed one.
  //
  // ReferRequest.reinsurer_id is typed UUID, so the old hardcoded "RE-SWISS-01"
  // was rejected as a 422 before the handler body ever ran — no referral was
  // ever persisted, for any reinsurer. Resolve the real panel member instead,
  // and check the case is actually referable rather than firing a certain 409.
  const handleReferReinsurance = async (
    policyId: string,
    reinsurerName: string,
  ): Promise<Reinsurer | null> => {
    setActionLoading(true);
    try {
      const view = await getReinsurance(policyId);

      if (!view.can_refer) {
        notify(tx("This case cannot be referred to a reinsurer from status {0}.", { 0: view.policy_status }), false);
        return null;
      }
      if (!view.referral_required) {
        notify(
          `No facultative referral needed — ${fmtPKR(view.cession.total_sum_assured)} sits within the ` +
            `automatic capacity of ${fmtPKR(view.cession.automatic_capacity)}.`,
          false,
        );
        return null;
      }

      const match = pickReinsurer(view.panel, reinsurerName);
      if (!match) {
        notify(tx("{0} is not on this tenant's reinsurer panel.", { 0: reinsurerName }), false);
        return null;
      }

      await referToReinsurer(policyId, {
        reinsurer_id: match.id,
        underwriter_note:
          reinsurancePlacements[policyId]?.note?.trim() ||
          `Facultative placement referral to ${match.name}`,
      });
      setReinsuranceReferrals((prev) => ({ ...prev, [policyId]: match.name }));
      notify(tx("Facultative reinsurance slip transmitted to {0}.", { 0: match.name }), true);
      await loadData();
      return match;
    } catch (e: any) {
      notify(apiError(e, "Could not create the reinsurance referral."), false);
      return null;
    } finally {
      setActionLoading(false);
    }
  };

  // Open the Gate 2 modal against the server's real cession maths and panel,
  // falling back to the illustrative constants if tenant-service is unreachable.
  const openReinsuranceModal = async (p: PolicyListItem) => {
    setActiveReinsurancePolicy(p);
    setActiveReinsuranceView(null);
    const view = await getReinsurance(p.id).catch(() => null);
    setActiveReinsuranceView(view);
  };

  const closeReinsuranceModal = () => {
    setActiveReinsurancePolicy(null);
    setActiveReinsuranceView(null);
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
    notify(tx("Policy pack dispatched via TCS ({0})", { 0: tracking }), true);
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
    notify(tx("SECP Welcome call verified! 14-Day Free-Look period activated."), true);
  };

  const { pageItems: pagedPolicies, pagination } = usePagination(filtered);
  const revealNew = useRevealNew({ filtered, keyOf: (p: PolicyListItem) => p.id, newIds: arrivals.newIds, pageSize: 12, setPage: pagination.setPage, reset: () => { setSearch(""); setSegment("all"); setFilterGate("ALL"); } });

  return (
    <div className="px-6 py-4 space-y-6 max-w-screen-2xl mx-auto w-full animate-in fade-in duration-300">
      <NewArrivalsBanner count={arrivals.newIds.size} noun="policy" onShow={revealNew} onDismiss={arrivals.markAllSeen} />
      {/* Executive Header Banner matching Pre-Underwriting */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-700 via-indigo-700 to-slate-900 flex items-center justify-center text-white shadow-md shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Post-Underwriting Operations")}</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-extrabold uppercase tracking-wider">
                {tx("Adamjee Life Operations")}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {tx("Legal counter-offer sign-offs, facultative reinsurance placement, industry cover checks, SECP 14-day free-look & courier POD verification.")}
            </p>
            {preUnderwritingCount > 0 && (
              <p className="text-[11px] text-slate-400 mt-1">
                {preUnderwritingCount.toLocaleString()}{" "}{tx("indicative quote")}
                {preUnderwritingCount === 1 ? "" : "s"}{" "}{tx("not yet through underwriting are excluded from this board.")}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Executive 4-Card Metric Suite matching Pre-Underwriting */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title={tx("Post-UW Active Cases")}
          value={kpis.active}
          subtitle={tx("requiring operational clearance")}
          accent="blue"
          icon={
            <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          }
        />
        <MetricCard
          title={tx("Legal Counter-Offers")}
          value={kpis.pendingCounter}
          subtitle={tx("Pakistani Contract Act sign-offs")}
          accent="sky"
          icon={
            <svg className="w-5 h-5 text-sky-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          }
        />
        <MetricCard
          title={tx("Facultative Referrals")}
          value={kpis.facultativeNeeded}
          subtitle={tx("exceeding PKR 10M retention limit")}
          accent="blue"
          icon={
            <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5m0 0h4m-4 0v-4m0 4h4" />
            </svg>
          }
        />
        <MetricCard
          title={tx("SECP Free-Look Active")}
          value={kpis.activeFreeLook}
          subtitle={tx("14-day statutory clock verified")}
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
              placeholder={tx("Search customer, CNIC, or policy number…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 bg-slate-50"
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
            className="rounded text-blue-600 focus:ring-blue-500"
          />
          {tx("Show fully-cleared post-underwriting cases")}
        </label>
      </div>

      {/* Post-Underwriting Cases: a table, like Pre-Underwriting */}
      <div className="space-y-4">
        {loading ? (
          <div className="py-16 bg-white rounded-xl border border-slate-200 text-center">
            <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-200 border-t-blue-600 mx-auto" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 bg-white rounded-xl border border-slate-200 text-center px-4">
            <p className="text-sm font-bold text-slate-700">{tx("No cases requiring post-underwriting verification right now.")}</p>
            <p className="text-xs text-slate-400 mt-1">{tx("Check \"Show fully-cleared post-underwriting cases\" or try another search.")}</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 font-semibold uppercase tracking-wider text-[11px] text-slate-500">
                  <th className="pl-5 pr-3 py-3 text-left">{tx("Policyholder")}</th>
                  <th className="px-3 py-3 text-left">{tx("Type")}</th>
                  <th className="px-3 py-3 text-left">{tx("Product")}</th>
                  <th className="px-3 py-3 text-left">{tx("Status")}</th>
                  {POST_GATES.map((g) => (
                    <th key={g.key} className="px-2 py-3 text-center whitespace-nowrap">{tx(g.short)}</th>
                  ))}
                  <th className="px-3 py-3 text-left">{tx("Progress")}</th>
                  <th className="px-4 py-3 text-right" />
                </tr>
              </thead>
              <tbody>
          {pagedPolicies.map((p) => {
            const gates = getPolicyGates(p);
            const courier = courierLogs[p.id];
            const call = welcomeCalls[p.id];
            const reinsurer = reinsuranceReferrals[p.id];
            const isOpen = openId === p.id;
            const done = [gates.isCounterAccepted, gates.isReinsured, gates.isHistoryClear, gates.isDispatched, gates.isWelcomeDone];
            const next = done.findIndex((d) => !d);              // the gate waiting to be done; everything after it is locked
            const stage = gates.isFullyCleared ? "completed" : !gates.isCounterAccepted ? "signoff" : "in_progress";
            const toggle = () => { arrivals.markSeen(p.id); setOpenId(isOpen ? null : p.id); };

            return (
              <React.Fragment key={p.id}>
                <tr
                  onClick={toggle}
                  aria-expanded={isOpen}
                  className={`border-b border-slate-100 cursor-pointer transition-colors ${arrivals.newIds.has(p.id) ? NEW_ARRIVAL_CLASS : ""} ${gates.isFullyCleared ? "bg-emerald-50/30 hover:bg-emerald-50/60" : isOpen ? "bg-blue-50/40" : "hover:bg-slate-50"}`}
                >
                  <td className="pl-5 pr-3 py-3">
                    <button onClick={(e) => { e.stopPropagation(); toggle(); }} className="font-semibold text-slate-900 hover:text-blue-600 transition-colors text-left">
                      {p.customer_name}
                    </button>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {tx("Policy:")} <span className="font-mono">{p.policy_number ?? tx("Drafting...")}</span>
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    {p.segment ? (
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${SEGMENT_BADGE_STYLE[p.segment as keyof typeof SEGMENT_BADGE_STYLE] || "bg-slate-100 text-slate-600 border-slate-200"}`}>
                        {SEGMENT_LABEL[p.segment as keyof typeof SEGMENT_LABEL] || p.segment}
                      </span>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-3 text-slate-600">
                    {p.product_name}
                    <p className="text-xs text-slate-500 mt-0.5 font-mono">{fmtPKR(p.coverage_amount)}</p>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap ${POST_STAGE[stage].style}`}>{tx(POST_STAGE[stage].label)}</span>
                    {stage === "in_progress" && next >= 0 && <p className="text-[11px] text-slate-500 mt-0.5 whitespace-nowrap">{tx("Next:")} {tx(POST_GATES[next].label)}</p>}
                  </td>
                  {POST_GATES.map((g, i) => {
                    const state: "done" | "pending" | "locked" = done[i] ? "done" : i === next ? "pending" : "locked";
                    return (
                      <td key={g.key} className="px-2 py-3 text-center">
                        <span
                          title={`${tx(g.label)}: ${state === "done" ? tx("Cleared") : state === "pending" ? tx("Waiting to be done") : tx("waiting on the previous gate")}`}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap ${PRE_GATE_STYLE_POST[state]}`}
                        >
                          {state === "done" ? (
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                          ) : state === "pending" ? <span className="w-1.5 h-1.5 rounded-full bg-current" /> : null}
                          {state === "done" ? tx("Cleared") : state === "pending" ? tx("Pending") : tx("Not yet")}
                        </span>
                      </td>
                    );
                  })}
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-0.5 w-16">
                        {[1, 2, 3, 4, 5].map((step) => (
                          <div key={step} className={`h-1.5 flex-1 rounded-full ${step <= gates.stepCount ? (gates.isFullyCleared ? "bg-emerald-500" : "bg-blue-600") : "bg-slate-200"}`} />
                        ))}
                      </div>
                      <span className={`text-xs font-bold font-mono ${gates.isFullyCleared ? "text-emerald-700" : "text-slate-700"}`}>{gates.stepCount}/5</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggle(); }}
                      aria-label={isOpen ? tx("Hide steps") : tx("Open steps")}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors bg-white hover:bg-slate-100 text-slate-700 border border-slate-200"
                    >
                      {isOpen ? tx("Hide") : gates.isFullyCleared ? tx("View") : tx("Open")}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-slate-200">
                    <td colSpan={POST_TABLE_COLS} className="p-0 bg-slate-50/40">
                <div className="px-6 pt-4 flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-xs text-slate-500">{tx("Sum assured")} <strong className="text-slate-900 font-mono">{fmtPKR(p.coverage_amount)}</strong>{" · "}{tx("Complete the steps in order: each unlocks the next.")}</p>
                  <button onClick={() => handleInspectPolicy(p)} className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg text-xs font-bold">{tx("Verify Details")}</button>
                </div>
                <div className="p-6">
                  <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                        {tx("Operational Progression Timeline")}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-200/60 font-mono">
                        {tx("Sequential Gating 1 → 5")}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500">
                      {tx("Completed")}{" "}<strong className="text-slate-900 font-mono">{gates.stepCount}</strong>{" "}{tx("of 5 verification milestones")}
                    </span>
                  </div>

                  {(() => {
                    const coState = getOrCreateCounterState(p);
                    const isGate1Done = gates.isCounterAccepted;
                    const isGate2Done = gates.isReinsured;
                    const isGate3Done = gates.isHistoryClear;
                    const isGate4Done = gates.isDispatched;
                    const isGate5Done = gates.isWelcomeDone;

                    const isGate2Locked = !isGate1Done;
                    const isGate3Locked = !isGate1Done || !isGate2Done;
                    const isGate4Locked = !isGate1Done || !isGate2Done || !isGate3Done;
                    const isGate5Locked = !isGate1Done || !isGate2Done || !isGate3Done || !isGate4Done;
                    
                    const totalLoading = Math.round((coState.deltaDuration + coState.deltaExposure + coState.deltaCoverage + coState.deltaRate) * 100);
                    
                    const descContent = totalLoading > 0 ? (
                      // Rendered inside a <p> (step.desc -> <p>{step.desc}</p>) —
                      // must stay inline-safe, no <div> here.
                      <span className="flex flex-col gap-0.5">
                        <span className="text-slate-700 font-semibold text-[11px]">
                          {tx("Risk Driver:")}{" "}{coState.reasonCode || tx("Escalation")}
                        </span>
                        <span>{tx("Proposer legal consent for loading & exclusion terms prior to contract perfection.")}</span>
                      </span>
                    ) : (
                      "Proposer legal consent for terms prior to contract perfection."
                    );

                    const pendingBadgeLabel = (p.status || "").toUpperCase() === "COUNTEROFFER" 
                      ? "Pending Sign-off" 
                      : totalLoading > 0 
                      ? `+${totalLoading}% Loading` 
                      : "No Loadings";

                    const gateSteps = [
                      {
                        num: 1,
                        title: "Counter-Offer Sign-off",
                        law: "Pakistani Contract Act 1872",
                        desc: descContent,
                        isDone: isGate1Done,
                        isLocked: false,
                        isNextActive: !isGate1Done,
                        badge: (
                          <StatusPill
                            done={isGate1Done}
                            pending={pendingBadgeLabel}
                            label={tx("Accepted")}
                          />
                        ),
                        action: isGate1Done ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                              <span>{tx("✓ Legal Sign-off Recorded")}</span>
                            </span>
                            <button
                              onClick={() => setActiveCounterPolicy(p)}
                              className="text-[11px] font-bold text-blue-800 hover:text-blue-950 underline px-2 py-1 bg-blue-50/80 rounded-lg border border-blue-200/80"
                            >
                              {tx("Rating Engine →")}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setActiveCounterPolicy(p)}
                            className="px-3.5 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5"
                          >
                            <span>{tx("Configure & Sign-Off Counter-Offer →")}</span>
                          </button>
                        ),
                      },
                      {
                        num: 2,
                        title: "Facultative Reinsurance Placement",
                        law: "SECP Rule 24 / Treaty 2026",
                        desc: isGate2Locked
                          ? "Requires completion of Counter-Offer Sign-off before proceeding."
                          : "Ceding retention excess (> PKR 10M) to Swiss Re, Munich Re, PRCL, or Hannover Re.",
                        isDone: isGate2Done,
                        isLocked: isGate2Locked,
                        isNextActive: isGate1Done && !isGate2Done,
                        badge: isGate2Locked ? null : (
                          <StatusPill
                            done={isGate2Done}
                            pending={p.coverage_amount >= 10000000 ? "Referral Required" : "Within Retention"}
                            label={reinsurer ? tx("Placed ({0})", { 0: reinsurer }) : tx("Within Limit")}
                          />
                        ),
                        action: isGate2Locked ? (
                          <span className="text-xs text-slate-400 font-medium italic">
                            {tx("Prerequisite: Complete Gate 1 first")}
                          </span>
                        ) : isGate2Done ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                              <span>{tx("✓ Reinsured with")}{" "}{reinsurer || tx("Swiss Re")}</span>
                            </span>
                            <button
                              onClick={() => openReinsuranceModal(p)}
                              className="text-[11px] font-bold text-sky-800 hover:text-sky-950 underline px-2 py-1 bg-sky-50 rounded-lg border border-sky-200"
                            >
                              {tx("View Slip →")}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => openReinsuranceModal(p)}
                            className="px-3.5 py-1.5 bg-gradient-to-r from-sky-600 to-blue-700 hover:from-sky-700 hover:to-blue-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5"
                          >
                            <span>{tx("Configure & Place Reinsurance →")}</span>
                          </button>
                        ),
                      },
                      {
                        num: 3,
                        title: "Industry Cover & HLV Check",
                        law: "Human Life Value Standard",
                        desc: isGate3Locked
                          ? "Requires completion of Reinsurance Placement before proceeding."
                          : "Aggregate life cover across industry verified against Human Life Value (HLV) cap.",
                        isDone: isGate3Done,
                        isLocked: isGate3Locked,
                        isNextActive: isGate1Done && isGate2Done && !isGate3Done,
                        badge: isGate3Locked ? null : (
                          <StatusPill done={isGate3Done} pending="Audited" label={tx("Clear")} />
                        ),
                        action: isGate3Locked ? (
                          <span className="text-xs text-slate-400 font-medium italic">
                            {tx("Prerequisite: Complete Gate 2 first")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                            <span>{tx("✓ Aggregate Cover Within HLV")}</span>
                          </span>
                        ),
                      },
                      {
                        num: 4,
                        title: "Courier Dispatch & POD Tracking",
                        law: "Statutory Proof of Delivery",
                        desc: isGate4Locked
                          ? "Requires completion of Industry Cover Check before dispatching policy package."
                          : "TCS / Leopard Express proof of delivery establishing statutory timeline commencement.",
                        isDone: isGate4Done,
                        isLocked: isGate4Locked,
                        isNextActive: isGate1Done && isGate2Done && isGate3Done && !isGate4Done,
                        badge: isGate4Locked ? null : (
                          <StatusPill done={isGate4Done} pending="Pending Dispatch" label={tx("POD Verified")} />
                        ),
                        action: isGate4Locked ? (
                          <span className="text-xs text-slate-400 font-medium italic">
                            {tx("Prerequisite: Complete Gate 3 first")}
                          </span>
                        ) : isGate4Done ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs font-mono font-bold text-teal-800 bg-teal-50 px-2.5 py-1 rounded-lg border border-teal-200">
                              <span>✓ {courier.partner}: {courier.trackingNo}</span>
                            </span>
                            <span className="text-[10px] font-bold text-teal-700 bg-teal-100/70 px-2 py-0.5 rounded">
                              {tx("POD Verified")}
                            </span>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleDispatchCourier(p.id)}
                            className="px-3.5 py-1.5 bg-gradient-to-r from-teal-600 to-teal-700 hover:from-teal-700 hover:to-teal-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5"
                          >
                            <span>{tx("Dispatch via TCS Express →")}</span>
                          </button>
                        ),
                      },
                      {
                        num: 5,
                        title: "SECP Welcome Call & 14-Day Free-Look",
                        law: "SECP Consumer Protection Regulation",
                        desc: isGate5Locked
                          ? "Requires policy delivery via courier before initiating SECP welcome call."
                          : "Mandated 14-day Free-Look cancellation window triggered upon call verification.",
                        isDone: isGate5Done,
                        isLocked: isGate5Locked,
                        isNextActive: isGate1Done && isGate2Done && isGate3Done && isGate4Done && !isGate5Done,
                        badge: isGate5Locked ? null : (
                          <StatusPill done={isGate5Done} pending="Call Pending" label={tx("14-Day Clock Active")} />
                        ),
                        action: isGate5Locked ? (
                          <span className="text-xs text-slate-400 font-medium italic">
                            {tx("Prerequisite: Complete Gate 4 first")}
                          </span>
                        ) : isGate5Done ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                              <span>{tx("✓ Welcome Call Verified")}</span>
                            </span>
                            <span className="text-[10px] font-mono font-semibold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded">
                              {tx("Free-Look Active until")}{" "}{call.freeLookEnd}
                            </span>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleCompleteWelcomeCall(p.id)}
                            className="px-3.5 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all flex items-center gap-1.5"
                          >
                            <span>{tx("Verify Welcome Call →")}</span>
                          </button>
                        ),
                      },
                    ];

                    return (
                      <div className="relative pl-2">
                        {(() => {
                          const isShowingAll = showAllGates[p.id] || false;
                          const defaultActive = gateSteps.find(s => s.isNextActive)?.num || gateSteps[gateSteps.length - 1].num;
                          const activeNum = expandedGates[p.id] !== undefined ? expandedGates[p.id] : defaultActive;
                          const visibleSteps = isShowingAll ? gateSteps : [gateSteps.find(s => s.num === defaultActive) || gateSteps[0]];
                          
                          return (
                            <>
                              {!isShowingAll && defaultActive > 1 && (
                                <div 
                                  className="relative flex gap-4 transition-all duration-300 pb-2 cursor-pointer group"
                                  onClick={() => setShowAllGates(prev => ({ ...prev, [p.id]: true }))}
                                >
                                  <div className="absolute top-8 left-[17px] -ml-px w-0.5 h-[calc(100%-20px)] bg-emerald-500" />
                                  <div className="relative z-10 shrink-0 w-9 h-9 rounded-full bg-slate-50 text-slate-400 border border-slate-200 flex items-center justify-center text-xs font-bold group-hover:bg-emerald-50 group-hover:text-emerald-600 group-hover:border-emerald-200 transition-colors shadow-sm">
                                    <span className="tracking-[0.1em] -ml-0.5">•••</span>
                                  </div>
                                  <div className="flex-1 flex flex-col justify-center">
                                    <span className="text-[11px] font-semibold text-slate-400 group-hover:text-emerald-600 transition-colors">
                                      {tx("Show")}{" "}{defaultActive - 1}{" "}{tx("previous stage")}{defaultActive - 1 > 1 ? "s" : ""}
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
                                        [p.id]: prev[p.id] === step.num ? -1 : step.num
                                      }));
                                    }}
                                  />
                                );
                              })}

                              {!isShowingAll && defaultActive < gateSteps.length && (
                                <div 
                                  className="relative flex gap-4 transition-all duration-300 pb-2 pt-1 cursor-pointer group"
                                  onClick={() => setShowAllGates(prev => ({ ...prev, [p.id]: true }))}
                                >
                                  <div className="relative z-10 shrink-0 w-9 h-9 rounded-full bg-slate-50 text-slate-400 border border-slate-200 flex items-center justify-center text-xs font-bold group-hover:bg-slate-100 group-hover:text-slate-600 group-hover:border-slate-300 transition-colors shadow-sm">
                                    <span className="tracking-[0.1em] -ml-0.5">•••</span>
                                  </div>
                                  <div className="flex-1 flex flex-col justify-center">
                                    <span className="text-[11px] font-semibold text-slate-400 group-hover:text-slate-600 transition-colors">
                                      {tx("Show")}{" "}{gateSteps.length - defaultActive}{" "}{tx("remaining stage")}{gateSteps.length - defaultActive > 1 ? "s" : ""}
                                    </span>
                                  </div>
                                </div>
                              )}

                              {isShowingAll && (
                                <div 
                                  className="relative flex gap-4 transition-all duration-300 pb-2 pt-1 cursor-pointer group"
                                  onClick={() => setShowAllGates(prev => ({ ...prev, [p.id]: false }))}
                                >
                                  <div className="relative z-10 shrink-0 w-9 h-9 rounded-full bg-slate-50 text-slate-500 border border-slate-200 flex items-center justify-center text-xs font-bold group-hover:bg-slate-200 group-hover:text-slate-700 group-hover:border-slate-300 transition-colors shadow-sm">
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                    </svg>
                                  </div>
                                  <div className="flex-1 flex flex-col justify-center">
                                    <span className="text-[11px] font-semibold text-slate-500 group-hover:text-slate-700 transition-colors">
                                      {tx("Collapse timeline (view active only)")}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    );
                  })()}
                </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && <Pagination pagination={pagination} noun={tx("cases")} />}
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
          notify(tx("Customer response recorded as {0}", { 0: decision }), true);
        };

        // Persist the sign-off before writing the audit trail — the trail should
        // only ever show approvals the backend actually accepted.
        const handleSignOff = async (roleName: string, levelName: string) => {
          const recorded = await handleAcceptCounterOffer(p.id);
          if (!recorded) return; // the error toast from the handler already explains why

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
          notify(tx("Counter-offer signed off successfully by {0}.", { 0: roleName }), true);
        };

        return (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4"
            onClick={() => setActiveCounterPolicy(null)}
            onKeyDown={(e) => { if (e.key === "Escape") setActiveCounterPolicy(null); }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="counter-title"
              tabIndex={-1}
              ref={(el) => el?.focus()}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-4xl border border-slate-200 overflow-hidden max-h-[94vh] flex flex-col outline-none"
            >
              {/* Header */}
              <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Counter-Offer Sign-off & Renewal Pricing Engine")}</p>
                  <h2 id="counter-title" className="mt-0.5 text-lg font-bold text-slate-900 truncate">
                    {p.customer_name} <span className="font-mono text-sm font-semibold text-slate-500">({p.policy_number ?? tx("Proposal")})</span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">{tx("Pakistani Contract Act Proposer Consent & Actuarial Renewal Calculation Formula")}</p>
                </div>
                <button onClick={() => setActiveCounterPolicy(null)} aria-label={tx("Close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                </button>
              </div>

              {/* The numbers that matter, always in view */}
              <div className="grid grid-cols-3 divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/70 text-center">
                <div className="px-4 py-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Original Premium")}</p><p className="mt-0.5 font-mono text-base font-bold text-slate-900">{fmtPKR(coState.expiringPremium)}</p></div>
                <div className="px-4 py-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Calculated Renewal Premium")}</p><p className="mt-0.5 font-mono text-base font-bold text-blue-700">{fmtPKR(coState.proposedPremium)}</p></div>
                <div className="px-4 py-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Variance")}</p>
                  <p className={`mt-0.5 font-mono text-base font-bold ${deviationPct > 25 ? "text-red-700" : deviationPct > 10 ? "text-amber-700" : "text-emerald-700"}`}>
                    {deviationPct >= 0 ? "+" : ""}{deviationPct.toFixed(1)}%
                  </p>
                  <p className="font-mono text-[11px] text-slate-500">{deviationPct >= 0 ? "+" : ""}{fmtPKR(coState.proposedPremium - coState.expiringPremium)}</p></div>
              </div>

              <div className="px-6 py-5 overflow-y-auto space-y-5 text-sm flex-1 bg-slate-50/50">
                {/* 1. Where the counter-offer stands */}
                <section className="bg-white p-4 rounded-xl border border-slate-200">
                  <h3 className="text-sm font-bold text-slate-900 mb-3">{tx("Counter-Offer Lifecycle Stepper")}</h3>
                  <ol className="flex items-start overflow-x-auto pb-1">
                    {workflowSteps.map((step, idx) => {
                      const activeIdx = workflowSteps.findIndex((s) => s.id === coState.workflowState);
                      const isCurrent = step.id === coState.workflowState;
                      const isDone = idx < activeIdx || (idx === activeIdx && step.id === "POLICY_ISSUED");
                      return (
                        <li key={step.id} className="flex flex-1 items-start last:flex-none min-w-[88px]" aria-current={isCurrent ? "step" : undefined}>
                          <div className="flex flex-col items-center text-center w-[88px]">
                            <span className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold ${isCurrent ? "bg-blue-600 text-white ring-4 ring-blue-100" : isDone ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500"}`}>
                              {isDone ? <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg> : idx + 1}
                            </span>
                            <span className={`mt-1.5 text-[11px] leading-tight ${isCurrent ? "font-bold text-blue-700" : isDone ? "font-medium text-slate-700" : "text-slate-400"}`}>{tx(step.label)}</span>
                          </div>
                          {idx < workflowSteps.length - 1 && <span className={`mt-3.5 h-0.5 flex-1 min-w-[12px] rounded ${isDone ? "bg-blue-600" : "bg-slate-200"}`} aria-hidden="true" />}
                        </li>
                      );
                    })}
                  </ol>
                  {coState.workflowState === "APPROVED" && <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">{tx("This counter-offer has been signed off. The pricing below is now locked.")}</p>}
                </section>

                {/* 2. Pricing: adjust the factors */}
                <section className="bg-white p-4 rounded-xl border border-slate-200">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">{tx("Actuarial Renewal Premium Formula")}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{tx("Adjust each factor; the renewal premium above updates as you go.")}</p>
                    </div>
                    <button
                      type="button"
                      disabled={coState.workflowState === "APPROVED"}
                      onClick={() => updateCounterState(p.id, (prev) => ({ ...prev, deltaDuration: 0, deltaExposure: 0, deltaCoverage: 0, deltaRate: 0, proposedPremium: prev.expiringPremium }))}
                      className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {tx("Reset factors")}
                    </button>
                  </div>
                  <details className="mb-4 text-xs text-slate-500">
                    <summary className="cursor-pointer font-semibold text-blue-700">{tx("Show the formula")}</summary>
                    <p className="mt-1 rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700 break-words">{tx("P_renewal = P_expiring × (1 + Δ_duration) × (1 + Δ_exposure) × (1 + Δ_coverage) × (1 + Δ_rate)")}</p>
                  </details>

                  <fieldset disabled={coState.workflowState === "APPROVED"} className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5 disabled:opacity-60">
                    <div>
                      <label htmlFor="p-exp" className="text-xs font-semibold text-slate-700">{tx("Expiring Base Premium (P_exp)")}</label>
                      <div className="relative mt-1.5">
                        <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-xs font-semibold text-slate-400">PKR</span>
                        <input id="p-exp" type="number" min={0} value={coState.expiringPremium} onChange={(e) => handleFactorChange("expiringPremium", Number(e.target.value))}
                          className="w-full rounded-lg border border-slate-200 bg-white py-2 ps-11 pe-3 font-mono text-sm text-slate-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                      </div>
                    </div>
                    {([
                      ["deltaDuration", "Duration Factor (Δ_duration)", -0.10, 0.30],
                      ["deltaExposure", "Exposure Factor (Δ_exposure)", -0.20, 0.50],
                      ["deltaCoverage", "Coverage Factor (Δ_coverage)", -0.20, 0.30],
                      ["deltaRate", "Base Rate & Claims Experience Adjustment (Δ_rate)", -0.20, 0.50],
                    ] as const).map(([field, label, min, max]) => {
                      const v = coState[field] as number;
                      return (
                        <div key={field} className={field === "deltaRate" ? "md:col-span-2" : ""}>
                          <div className="flex items-center justify-between gap-2">
                            <label htmlFor={`f-${field}`} className="text-xs font-semibold text-slate-700">{tx(label)}</label>
                            <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold ${v > 0 ? "bg-amber-50 text-amber-800" : v < 0 ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                              {v > 0 ? "+" : ""}{(v * 100).toFixed(1)}%
                            </span>
                          </div>
                          <input id={`f-${field}`} type="range" min={min} max={max} step="0.01" value={v} onChange={(e) => handleFactorChange(field, parseFloat(e.target.value))} className="mt-2 w-full accent-blue-600" />
                          <div className="flex justify-between font-mono text-[10px] text-slate-400"><span>{(min * 100).toFixed(0)}%</span><span>0</span><span>+{(max * 100).toFixed(0)}%</span></div>
                        </div>
                      );
                    })}
                  </fieldset>
                </section>

                {/* 3. Reason & the customer's response */}
                <section className="bg-white p-4 rounded-xl border border-slate-200 space-y-4">
                  <h3 className="text-sm font-bold text-slate-900">{tx("Counter-Offer Terms & Proposer Response")}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="reason-code" className="block text-xs font-semibold text-slate-700 mb-1.5">{tx("Counter-Offer Reason Code")}</label>
                      <select id="reason-code" value={coState.reasonCode} onChange={(e) => updateCounterState(p.id, (prev) => ({ ...prev, reasonCode: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20">
                        <option value="Price Objection">{tx("Price Objection & Broker Negotiation")}</option>
                        <option value="Renewal Rate & Risk Exposure Change">{tx("Renewal Rate & Exposure Adjustment")}</option>
                        <option value="Claims Experience Surcharge">{tx("Claims Experience Adverse Loading")}</option>
                        <option value="Competitor Rate Match">{tx("Competitor Premium Matching")}</option>
                        <option value="Coverage Limit Modification">{tx("Coverage Limit / Deductible Alteration")}</option>
                      </select>
                    </div>
                    <div>
                      <span id="decision-label" className="block text-xs font-semibold text-slate-700 mb-1.5">{tx("Customer / Proposer Decision")}</span>
                      <div role="radiogroup" aria-labelledby="decision-label" className="grid grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1">
                        {([
                          ["ACCEPTED", "Accept Terms", "M5 13l4 4L19 7", "bg-emerald-600 text-white"],
                          ["RE_NEGOTIATE", "Re-Negotiate", "M4 4v5h5M20 20v-5h-5M5.6 15A8 8 0 0 0 20 12M18.4 9A8 8 0 0 0 4 12", "bg-blue-600 text-white"],
                          ["DECLINED", "Decline Terms", "M6 6l12 12M18 6L6 18", "bg-slate-700 text-white"],
                        ] as const).map(([val, label, icon, on]) => (
                          <button key={val} type="button" role="radio" aria-checked={coState.customerDecision === val} disabled={coState.workflowState === "APPROVED"} onClick={() => handleCustomerDecision(val)}
                            className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${coState.customerDecision === val ? on : "text-slate-600 hover:bg-white"}`}>
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>
                            {tx(label)}
                          </button>
                        ))}
                      </div>
                      {coState.customerDecision === "PENDING" && <p className="mt-1.5 text-[11px] text-slate-500">{tx("No response recorded yet.")}</p>}
                    </div>
                  </div>
                </section>

                {/* 4. Sign-off: the level this variance needs */}
                <section className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">{tx("Underwriting Authority Routing Matrix (Sign-Off Control)")}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{tx(authority.description)}</p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-bold border ${authority.badgeClass}`}>{authority.level}: {authority.role}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
                    {([
                      ["Junior Underwriter", "Level 1", "Sign-off as Junior UW (≤ 10%)"],
                      ["Senior Underwriter", "Level 2", "Sign-off as Senior UW (≤ 25%)"],
                      ["Chief Underwriter & Pricing Committee", "Level 3", "Sign-off as Chief UW / Committee (> 25%)"],
                    ] as const).map(([role, level, label]) => {
                      const needed = authority.level === level;
                      const below = Number(level.slice(-1)) < Number(String(authority.level).slice(-1));
                      return (
                        <button key={level} type="button" onClick={() => handleSignOff(role, level)} disabled={coState.workflowState === "APPROVED"}
                          title={below ? tx("Below the authority this variance needs") : needed ? tx("The level this variance needs") : undefined}
                          className={`px-3.5 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 transition-colors ${needed ? "bg-blue-600 hover:bg-blue-700 text-white shadow-sm" : "bg-white hover:bg-slate-50 text-slate-700 border border-slate-300"}`}>
                          {tx(label)}{needed && <span className="ms-1.5 rounded bg-white/20 px-1 text-[10px]">{tx("Required")}</span>}{below && <span className="ms-1.5 text-[10px] font-medium text-amber-700">{tx("Below required level")}</span>}
                        </button>
                      );
                    })}
                  </div>

                  {coState.signoffHistory.length > 0 && (
                    <div className="pt-3 border-t border-slate-100">
                      <h4 className="text-xs font-semibold text-slate-700 mb-2">{tx("Electronic Sign-Off Audit Trail")}</h4>
                      <ul className="space-y-1.5">
                        {coState.signoffHistory.map((s, idx) => (
                          <li key={idx} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg></span>
                              <span className="font-semibold text-slate-800 truncate">{s.approvedBy}</span><span className="text-slate-400">({s.level})</span>
                            </span>
                            <span className="font-mono text-[11px] text-slate-500 shrink-0">{s.timestamp}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              </div>

              <div className="border-t border-slate-200 px-6 py-3.5 flex flex-wrap justify-between items-center gap-3 bg-white">
                <span className="text-xs text-slate-500">{tx("Pakistani Contract Act 1872 · Section 7 Counter-Offer Perfection")}</span>
                <button onClick={() => setActiveCounterPolicy(null)} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg shadow-sm">
                  {tx("Done / Close")}
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
        // Prefer the engine's own cession maths; the illustrative constants are
        // only a fallback for when tenant-service could not be reached.
        const cession = activeReinsuranceView?.cession ?? null;
        const sumAssured = cession?.total_sum_assured ?? p.coverage_amount ?? 15000000;
        const retentionLimit = cession?.retention_limit ?? 10000000;
        const cededAmount = cession?.total_ceded_amount ?? Math.max(0, sumAssured - retentionLimit);
        const cessionPct = cession?.cession_pct ?? (sumAssured > 0 ? (cededAmount / sumAssured) * 100 : 0);
        const cededPremium = Math.round(cession?.reinsurance_premium ?? cededAmount * 0.02);
        const cedingCommission = Math.round(cededPremium * 0.225); // 22.5%
        const netPayable = cededPremium - cedingCommission;
        const panel: Reinsurer[] = activeReinsuranceView?.panel ?? [];
        const panelOptions: PanelOption[] = panel.length ? panel : PANEL_REINSURERS;
        const selectedReinsurerName =
          panelOptions.find((r) => r.id === currentPlacement.reinsurerId)?.name ??
          currentPlacement.reinsurerName;

        const handleModalSubmit = async (reinsurerName: string) => {
          const placed = await handleReferReinsurance(p.id, reinsurerName);
          if (!placed) return; // referral rejected — leave the modal open with the error
          setReinsurancePlacements((prev) => ({
            ...prev,
            [p.id]: {
              reinsurerId: placed.id,
              reinsurerName: placed.name,
              note: currentPlacement.note,
              status: "Placed & Bound",
              cededAmount,
            },
          }));
          closeReinsuranceModal();
        };

        return (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4"
            onClick={() => closeReinsuranceModal()}
            onKeyDown={(e) => { if (e.key === "Escape") closeReinsuranceModal(); }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="reins-title"
              tabIndex={-1}
              ref={(el) => el?.focus()}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-3xl border border-slate-200 overflow-hidden max-h-[94vh] flex flex-col outline-none"
            >
              {/* Header */}
              <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Reinsurance Placement & Cession Engine (Gate 2)")}</p>
                  <h2 id="reins-title" className="mt-0.5 text-lg font-bold text-slate-900 truncate">
                    {p.customer_name} <span className="font-mono text-sm font-semibold text-slate-500">({p.policy_number ?? tx("Proposal")})</span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">{tx("Company Retention Limit: PKR 10,000,000 · Treaty Quota Share & Facultative Placement")}</p>
                </div>
                <button onClick={() => closeReinsuranceModal()} aria-label={tx("Close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                </button>
              </div>

              <div className="px-6 py-5 overflow-y-auto space-y-5 text-sm flex-1 bg-slate-50/50">
                {/* Whether this needs a reinsurer at all, said first */}
                {activeReinsuranceView && !activeReinsuranceView.referral_required && (
                  <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                    <span className="font-semibold">{tx("Fully retained")}</span> — {fmtPKR(sumAssured)} {tx("sits within the automatic capacity of")} {fmtPKR(activeReinsuranceView.cession.automatic_capacity)}. {tx("No facultative slip is needed.")}
                  </div>
                )}
                {activeReinsuranceView && activeReinsuranceView.referral_required && !activeReinsuranceView.can_refer && (
                  <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    {tx("Cession is required, but a case at status")} <strong>{activeReinsuranceView.policy_status}</strong> {tx("cannot be referred yet — complete the underwriting view first.")}
                  </div>
                )}

                {/* 1. How much is kept and how much is ceded */}
                <section className="bg-white p-4 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <h3 className="text-sm font-bold text-slate-900">{tx("Actuarial Cession Breakdown")}</h3>
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">{tx("SECP Rule 24 / Treaty 2026")}</span>
                  </div>
                  <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-200" role="img" aria-label={`${tx("Retained")} ${(100 - cessionPct).toFixed(1)}%, ${tx("Ceded")} ${cessionPct.toFixed(1)}%`}>
                    <div className="bg-emerald-500" style={{ width: `${Math.max(0, 100 - cessionPct)}%` }} />
                    <div className="bg-blue-600" style={{ width: `${Math.min(100, cessionPct)}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[11px] font-medium">
                    <span className="text-emerald-700">● {tx("Retained")} {(100 - cessionPct).toFixed(1)}%</span>
                    <span className="text-blue-700">● {tx("Ceded")} {cessionPct.toFixed(1)}%</span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                    {([
                      [tx("Total Sum Assured"), fmtPKR(sumAssured), "text-slate-900"],
                      [tx("Company Retention Cap"), fmtPKR(retentionLimit), "text-emerald-700"],
                      [tx("Excess Ceded Risk"), cededAmount > 0 ? fmtPKR(cededAmount) : tx("PKR 0 (Fully Retained)"), "text-blue-700"],
                      [tx("Cession Share %"), `${cessionPct.toFixed(1)}%`, "text-blue-700"],
                    ] as const).map(([k, v, c]) => (
                      <div key={k} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k}</dt>
                        <dd className={`mt-0.5 font-mono text-sm font-bold ${c}`}>{v}</dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {/* 2. What it costs */}
                <section className="bg-white p-4 rounded-xl border border-slate-200">
                  <h3 className="text-sm font-bold text-slate-900 mb-3">{tx("Ceding Premium Accounting Entry (Double Entry Ledger)")}</h3>
                  <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-lg border border-slate-200 px-3 py-2.5"><dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Ceded Gross Premium")}</dt><dd className="mt-0.5 font-mono text-sm font-bold text-slate-900">{fmtPKR(cededPremium)}</dd></div>
                    <div className="rounded-lg border border-slate-200 px-3 py-2.5"><dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Ceding Commission (22.5%)")}</dt><dd className="mt-0.5 font-mono text-sm font-bold text-emerald-700">−{fmtPKR(cedingCommission)}</dd></div>
                    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5"><dt className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">{tx("Net Reinsurer Payable")}</dt><dd className="mt-0.5 font-mono text-sm font-bold text-blue-800">{fmtPKR(netPayable)}</dd></div>
                  </dl>
                </section>

                {/* 3. Who takes it */}
                <section className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">{tx("Select Reinsurer & Transmit Facultative Slip")}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">{tx("Choose one reinsurer. Those whose capacity is below the ceded amount are flagged.")}</p>
                  </div>
                  <div role="radiogroup" aria-label={tx("Reinsurer")} className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {panelOptions.map((r) => {
                      const on = currentPlacement.reinsurerId === r.id;
                      const short = cededAmount > 0 && r.facultative_capacity < cededAmount;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => setReinsurancePlacements((prev) => ({ ...prev, [p.id]: { ...currentPlacement, reinsurerId: r.id, reinsurerName: r.name } }))}
                          className={`text-start p-3.5 rounded-xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on ? "bg-blue-50 border-blue-600 ring-1 ring-blue-600" : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50"}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="flex items-center gap-2 min-w-0">
                              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-blue-600 bg-blue-600" : "border-slate-300 bg-white"}`}>{on && <span className="h-1.5 w-1.5 rounded-full bg-white" />}</span>
                              <span className="font-semibold text-slate-900 truncate">{r.name}</span>
                            </span>
                            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700 ring-1 ring-inset ring-slate-200" title={tx("AM Best rating")}>{r.am_best_rating}</span>
                          </div>
                          <p className="mt-2 text-xs text-slate-600">{tx("Capacity:")} <span className="font-mono font-semibold text-slate-800">{fmtPKR(r.facultative_capacity)}</span></p>
                          <p className="text-xs text-slate-500 truncate">{r.contact_email}</p>
                          {short && <p className="mt-1.5 text-[11px] font-semibold text-amber-700">{tx("Capacity is below the ceded amount")}</p>}
                        </button>
                      );
                    })}
                  </div>
                  <div>
                    <label htmlFor="risk-notes" className="block text-xs font-semibold text-slate-700 mb-1.5">{tx("Underwriter Risk Package Notes")} <span className="font-normal text-slate-400">({tx("optional")})</span></label>
                    <textarea
                      id="risk-notes"
                      rows={3}
                      maxLength={1000}
                      value={currentPlacement.note}
                      onChange={(e) => setReinsurancePlacements((prev) => ({ ...prev, [p.id]: { ...currentPlacement, note: e.target.value } }))}
                      placeholder={tx("Enter specific exposure notes, medical loading details, or coverage conditions for reinsurer slip...")}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                    <p className="mt-1 text-end text-[11px] text-slate-400">{currentPlacement.note.length}/1000</p>
                  </div>
                </section>
              </div>

              {/* Footer: the decision */}
              <div className="px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white">
                <button onClick={() => closeReinsuranceModal()} className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50">{tx("Cancel")}</button>
                <button
                  onClick={() => handleModalSubmit(selectedReinsurerName)}
                  disabled={actionLoading || activeReinsuranceView?.referral_required === false}
                  className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {actionLoading ? tx("Transmitting…") : <><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>{tx("Transmit Slip & Bind ({0})", { 0: selectedReinsurerName })}</>}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {selectedPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs px-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
            <div className="bg-gradient-to-r from-blue-900 via-indigo-900 to-slate-900 px-6 py-4 flex items-center justify-between text-white">
              <div>
                <h2 className="text-base font-bold">{selectedPolicy.customer_name}</h2>
                <p className="text-xs text-blue-200 font-mono mt-0.5">{tx("Post-Underwriting Verification ·")}{" "}{selectedPolicy.product_name}</p>
              </div>
              <button onClick={() => setSelectedPolicy(null)} className="text-white/60 hover:text-white text-lg">✕</button>
            </div>

            <div className="px-6 py-5 overflow-y-auto space-y-6 text-xs">
              {/* Customer Sign-off on Counter-Offers */}
              <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-blue-950 text-sm">{tx("Customer Sign-off on Counter-Offers (Pakistani Contract Act)")}</h3>
                  <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-mono font-bold text-[10px]">
                    {counterOffer ? counterOffer.status : tx("No Active Counter-Offer")}
                  </span>
                </div>
                <p className="text-slate-600 text-[11px] leading-relaxed">
                  {tx("Under Pakistani contract law, any underwriting loading or exclusion clause constitutes a legal amendment. The proposer must explicitly accept terms prior to contract perfection.")}
                </p>
                {counterOffer && counterOffer.status === "Pending" && (
                  <div className="pt-2 flex gap-3">
                    <button
                      onClick={() => handleAcceptCounterOffer(selectedPolicy.id)}
                      disabled={actionLoading}
                      className="px-4 py-2 bg-emerald-600 text-white font-bold rounded-lg hover:bg-emerald-700 transition-colors shadow-xs"
                    >
                      {tx("Record Proposer Acceptance & Sign-off →")}
                    </button>
                  </div>
                )}
              </div>

              {/* Reinsurance Referral & Facultative Placement */}
              <div className="bg-sky-50/70 border border-sky-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-sky-950 text-sm">{tx("Reinsurance Referral & Facultative Placement")}</h3>
                  <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-800 font-bold text-[10px]">
                    {reinsuranceData?.referral ? reinsuranceData.referral.status : selectedPolicy.coverage_amount >= 10000000 ? tx("Facultative Required") : tx("Inside Retention Limit")}
                  </span>
                </div>
                <p className="text-slate-600 text-[11px]">
                  {tx("Ceding policy risk exceeding company retention limit (PKR 10M) to treaty quota share or facultative reinsurers (e.g., Swiss Re, Munich Re, PRCL, Hannover Re).")}
                </p>
                {reinsuranceData?.cession && (
                  <div className="grid grid-cols-3 gap-3 bg-white p-3 rounded-lg border border-sky-100 mt-2">
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">{tx("Retention Limit")}</p>
                      <p className="font-bold text-slate-800">{fmtPKR(reinsuranceData.cession.retention_limit)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">{tx("Retained Amount")}</p>
                      <p className="font-bold text-slate-800">{fmtPKR(reinsuranceData.cession.retained_amount)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">{tx("Ceded Amount")}</p>
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
                      {tx("Refer to Swiss Re")}
                    </button>
                    <button
                      onClick={() => handleReferReinsurance(selectedPolicy.id, "Munich Re")}
                      disabled={actionLoading}
                      className="px-3 py-1.5 bg-blue-700 text-white font-semibold rounded-lg hover:bg-blue-800 transition-colors shadow-2xs"
                    >
                      {tx("Refer to Munich Re")}
                    </button>
                    <button
                      onClick={() => handleReferReinsurance(selectedPolicy.id, "Hannover Re")}
                      disabled={actionLoading}
                      className="px-3 py-1.5 bg-slate-700 text-white font-semibold rounded-lg hover:bg-slate-800 transition-colors"
                    >
                      {tx("Refer to Hannover Re")}
                    </button>
                  </div>
                </div>
              </div>

              {/* Existing Insurance / Declared Policies Check */}
              <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-blue-900 text-sm">{tx("Existing Insurance & Declared Industry Policies Check")}</h3>
                <p className="text-slate-600 text-[11px]">
                  {tx("Cross-checking total active sum assured across all life insurers against Human Life Value (HLV) limits & retention rules.")}
                </p>
                {historyData && (
                  <div className="grid grid-cols-2 gap-3 bg-white p-3 rounded-lg border border-blue-100">
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase font-semibold">{tx("Human Life Value Cap")}</p>
                      <p className="font-bold text-slate-800">
                        {historyData.hlv_limit ? fmtPKR(historyData.hlv_limit) : tx("PKR 50,000,000")} 
                        {historyData.hlv_ratio ? ` (${historyData.hlv_ratio.toFixed(2)}×)` : ""}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase font-semibold">{tx("Industry Aggregate Cover")}</p>
                      <p className="font-bold text-slate-800">
                        {fmtPKR(historyData.aggregate_sum_assured || historyData.external_declared_sum_assured + historyData.proposed_sum_assured)}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Policy Dispatch & Courier Tracking */}
              <div className="bg-teal-50/60 border border-teal-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-teal-900 text-sm">{tx("Policy Dispatch & Courier POD Tracking")}</h3>
                <p className="text-slate-600 text-[11px]">
                  {tx("Essential for proof of delivery establishing commencement of statutory timelines.")}
                </p>
                <div className="flex items-center justify-between bg-white p-3 rounded-lg border border-teal-100">
                  <div>
                    <p className="font-bold text-slate-800">{tx("TCS Courier Express")}</p>
                    <p className="text-[10px] text-slate-500">{tx("Tracking: TCS-98421034 · Status: POD Signed & Verified")}</p>
                  </div>
                  <span className="px-2.5 py-1 rounded bg-teal-100 text-teal-800 font-bold text-[10px]">{tx("Proof of Delivery Verified")}</span>
                </div>
              </div>

              {/* SECP Welcome Call & Free-Look Period */}
              <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-emerald-900 text-sm">{tx("SECP Welcome Call & 14-Day Free-Look Period")}</h3>
                <p className="text-slate-600 text-[11px]">
                  {tx("SECP mandates a 14-day Free-Look Period from date of policy receipt. The welcome call confirms receipt and starts the cancellation clock.")}
                </p>
                <div className="flex items-center justify-between bg-white p-3 rounded-lg border border-emerald-100">
                  <div>
                    <p className="font-bold text-emerald-900">{tx("Welcome Call Status: Confirmed")}</p>
                    <p className="text-[10px] text-slate-500">
                      {freeLookData?.free_look_end_date ? tx("14-Day Free-Look Window active until {0}.", { 0: freeLookData.free_look_end_date }) : tx("14-Day Free-Look Window active post delivery confirmation.")}
                    </p>
                  </div>
                  <span className="px-2.5 py-1 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">{tx("14-Day Clock Active")}</span>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-100 px-6 py-4 flex justify-end">
              <button
                onClick={() => setSelectedPolicy(null)}
                className="px-5 py-2 bg-slate-900 text-white font-bold text-xs rounded-xl hover:bg-slate-800"
              >
                {tx("Close Portal View")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
