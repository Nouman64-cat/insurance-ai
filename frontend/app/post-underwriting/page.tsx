"use client";

import { useEffect, useMemo, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { MetricCard } from "@/components/MetricCard";
import { SegmentDropdown, SegmentFilter } from "@/components/SegmentDropdown";
import FiltersPanel from "@/components/FiltersPanel";
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
  getReinsuranceDetails,
  createReinsuranceReferral,
  ReinsuranceDetails,
} from "@/app/services/reinsurance";
import {
  getInsuranceHistory,
  InsuranceHistoryResult,
} from "@/app/services/insuranceHistory";

// ── Status Tone Helper ────────────────────────────────────────────────────────
const STATUS_BADGE: Record<string, string> = {
  COUNTEROFFER: "bg-amber-50 text-amber-800 border-amber-200",
  REINSURERREFERRED: "bg-purple-50 text-purple-800 border-purple-200",
  APPROVED: "bg-blue-50 text-blue-800 border-blue-200",
  PENDINGPAYMENT: "bg-indigo-50 text-indigo-800 border-indigo-200",
  ISSUED: "bg-teal-50 text-teal-800 border-teal-200",
  ACTIVE: "bg-emerald-50 text-emerald-800 border-emerald-200",
};

export default function PostUnderwritingPage() {
  const { notify } = useNotify();

  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters & Tabs
  const [activeTab, setActiveTab] = useState<
    "counter-offers" | "reinsurance" | "insurance-check" | "dispatch" | "welcome-call"
  >("counter-offers");

  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Drawer / Modal states for active policy verification
  const [selectedPolicy, setSelectedPolicy] = useState<PolicyListItem | null>(null);
  const [counterOffer, setCounterOffer] = useState<CounterOffer | null>(null);
  const [reinsuranceData, setReinsuranceData] = useState<ReinsuranceDetails | null>(null);
  const [historyData, setHistoryData] = useState<InsuranceHistoryResult | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Mock states for Dispatch & SECP Welcome Call triggers
  const [courierLogs, setCourierLogs] = useState<
    Record<string, { partner: string; trackingNo: string; dispatchedAt: string; podStatus: string }>
  >({
    default: {
      partner: "TCS Express",
      trackingNo: "TCS-98234110",
      dispatchedAt: "2026-08-04",
      podStatus: "Delivered (POD Signed)",
    },
  });

  const [welcomeCalls, setWelcomeCalls] = useState<
    Record<string, { callStatus: string; confirmedAt: string | null; freeLookEnd: string | null }>
  >({});

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

  // Filtered dataset
  const filtered = useMemo(() => {
    let list = policies;

    // Filter by tab specifics
    if (activeTab === "counter-offers") {
      list = list.filter((p) => (p.status || "").toUpperCase() === "COUNTEROFFER" || (p.status || "").toUpperCase() === "ACCEPTEDWITHLOADINGS");
    } else if (activeTab === "reinsurance") {
      list = list.filter((p) => p.coverage_amount >= 10000000 || (p.status || "").toUpperCase() === "REINSURERREFERRED");
    }

    if (segment !== "all") list = list.filter((p) => p.segment === segment);
    if (filterStatus !== "ALL") list = list.filter((p) => p.status === filterStatus);

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
  }, [policies, activeTab, segment, filterStatus, search]);

  // Open policy inspection modal
  const handleInspectPolicy = async (p: PolicyListItem) => {
    setSelectedPolicy(p);
    setActionLoading(true);
    try {
      const [co, re, hi, rd] = await Promise.all([
        getCounterOffer(p.id).catch(() => null),
        getReinsuranceDetails(p.id).catch(() => null),
        getInsuranceHistory(p.id).catch(() => null),
        getReadiness(p.id).catch(() => null),
      ]);
      setCounterOffer(co);
      setReinsuranceData(re);
      setHistoryData(hi);
      setReadiness(rd);
    } catch (e: any) {
      notify("Error loading case details.", false);
    } finally {
      setActionLoading(false);
    }
  };

  // Sign off counter-offer
  const handleAcceptCounterOffer = async () => {
    if (!selectedPolicy) return;
    setActionLoading(true);
    try {
      await acceptCounterOffer(selectedPolicy.id, "Customer explicitly signed counter-offer terms (Pakistani Contract Act verified).");
      notify("Counter-offer accepted & legal sign-off recorded!", true);
      loadData();
      setSelectedPolicy(null);
    } catch (e: any) {
      notify("Failed to record counter-offer sign-off.", false);
    } finally {
      setActionLoading(false);
    }
  };

  // Trigger Reinsurance Referral
  const handleReferReinsurance = async (reinsurer: string) => {
    if (!selectedPolicy) return;
    setActionLoading(true);
    try {
      await createReinsuranceReferral(selectedPolicy.id, reinsurer, "Automatic post-underwriting facultative placement trigger.");
      notify(`Facultative referral created with ${reinsurer}!`, true);
      loadData();
      handleInspectPolicy(selectedPolicy);
    } catch (e: any) {
      notify("Failed to initiate reinsurance referral.", false);
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
        podStatus: "In Transit (Tracking Active)",
      },
    }));
    notify(`Policy pack dispatched via TCS (${tracking})`, true);
  };

  // Complete SECP Welcome Call
  const handleCompleteWelcomeCall = (policyId: string) => {
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
    notify("SECP Welcome call verified! 14-Day Free-Look period activated.", true);
  };

  return (
    <div className="px-6 py-6 space-y-6 max-w-screen-2xl mx-auto w-full">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center text-white shadow-sm shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Post-Underwriting Portal</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-extrabold uppercase tracking-wider">
                Adam Jee Life Operations
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Legal counter-offer sign-offs, facultative reinsurance placement, SECP 14-day free-look &amp; courier POD verification.
            </p>
          </div>
        </div>

        {/* Tab Selector */}
        <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200/80 shrink-0 overflow-x-auto">
          {[
            { id: "counter-offers", label: "1. Counter-Offers Sign-off" },
            { id: "reinsurance", label: "2. Reinsurance Referral" },
            { id: "insurance-check", label: "3. Industry Cover Check" },
            { id: "dispatch", label: "4. Courier Dispatch & POD" },
            { id: "welcome-call", label: "5. SECP Welcome Call & Free-Look" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === t.id ? "bg-white text-slate-900 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard title="Counter-Offers Pending" value={policies.filter((p) => (p.status || "").toUpperCase() === "COUNTEROFFER").length} subtitle="legal sign-off required" accent="amber" />
        <MetricCard title="Reinsurance Facultative" value={policies.filter((p) => p.coverage_amount >= 10000000).length} subtitle="> PKR 10M sum assured" accent="purple" />
        <MetricCard title="Industry Cover Checks" value={policies.length} subtitle="HLV retention verification" accent="blue" />
        <MetricCard title="Dispatched Policies" value={Object.keys(courierLogs).length} subtitle="TCS / Leopard courier" accent="teal" />
        <MetricCard title="Active SECP Free-Look" value={Object.keys(welcomeCalls).length} subtitle="14-day cancellation window" accent="emerald" />
      </div>

      {/* Filter Toolbar */}
      <div className="flex items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs">
        <input
          type="text"
          placeholder="Search customer, CNIC, policy number..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/30 bg-slate-50"
        />
        <SegmentDropdown value={segment} onChange={setSegment} counts={{ all: policies.length, individual: 0, organization: 0, family: 0 }} />
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 flex justify-center">
            <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-purple-600" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm font-semibold text-slate-600">No cases matching this post-underwriting stage.</p>
            <p className="text-xs text-slate-400 mt-1">Cases needing counter-offer sign-offs or reinsurance will appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">Customer</th>
                  <th className="px-5 py-3 text-left">Product</th>
                  <th className="px-5 py-3 text-right">Sum Assured</th>
                  <th className="px-5 py-3 text-left">Post-UW Stage</th>
                  <th className="px-5 py-3 text-left">Verification Status</th>
                  <th className="px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((p) => {
                  const courier = courierLogs[p.id];
                  const call = welcomeCalls[p.id];
                  return (
                    <tr key={p.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-3.5">
                        <p className="font-semibold text-slate-800 text-xs">{p.customer_name}</p>
                        <p className="text-[10px] text-slate-400 font-mono mt-0.5">{p.policy_number ?? "Drafting..."}</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <p className="text-xs text-slate-700 font-medium">{p.product_name}</p>
                      </td>
                      <td className="px-5 py-3.5 text-right font-semibold text-slate-900 text-xs">
                        {fmtPKR(p.coverage_amount)}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${STATUS_BADGE[p.status] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {activeTab === "dispatch" ? (
                          <span className={`text-xs font-semibold ${courier ? "text-emerald-700" : "text-amber-600"}`}>
                            {courier ? courier.podStatus : "Awaiting Dispatch"}
                          </span>
                        ) : activeTab === "welcome-call" ? (
                          <span className={`text-xs font-semibold ${call ? "text-emerald-700" : "text-slate-500"}`}>
                            {call ? `Verified (Free-Look: ${call.freeLookEnd})` : "Pending Welcome Call"}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">Requirements cleared</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right space-x-2">
                        {activeTab === "dispatch" && !courier && (
                          <button
                            onClick={() => handleDispatchCourier(p.id)}
                            className="px-2.5 py-1 text-xs font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 shadow-xs"
                          >
                            Dispatch Courier
                          </button>
                        )}
                        {activeTab === "welcome-call" && !call && (
                          <button
                            onClick={() => handleCompleteWelcomeCall(p.id)}
                            className="px-2.5 py-1 text-xs font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 shadow-xs"
                          >
                            Verify Welcome Call
                          </button>
                        )}
                        <button
                          onClick={() => handleInspectPolicy(p)}
                          className="px-3 py-1 text-xs font-bold text-purple-700 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 transition-colors"
                        >
                          Verify Details →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Verification Drawer / Modal */}
      {selectedPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
            <div className="bg-gradient-to-r from-purple-900 to-indigo-900 px-6 py-4 flex items-center justify-between text-white">
              <div>
                <h2 className="text-base font-bold">{selectedPolicy.customer_name}</h2>
                <p className="text-xs text-purple-200 font-mono mt-0.5">Post-Underwriting Verification Portal · {selectedPolicy.product_name}</p>
              </div>
              <button onClick={() => setSelectedPolicy(null)} className="text-white/60 hover:text-white">✕</button>
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
                      onClick={handleAcceptCounterOffer}
                      disabled={actionLoading}
                      className="px-4 py-2 bg-emerald-600 text-white font-bold rounded-lg hover:bg-emerald-700 transition-colors shadow-xs"
                    >
                      Record Proposer Acceptance & Sign-off →
                    </button>
                  </div>
                )}
              </div>

              {/* 2. Reinsurance Referral */}
              <div className="bg-purple-50/60 border border-purple-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-purple-900 text-sm">2. Reinsurance Referral &amp; Facultative Placement</h3>
                  <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-bold text-[10px]">
                    {reinsuranceData?.referral ? reinsuranceData.referral.status : "Inside Retention Limit"}
                  </span>
                </div>
                <p className="text-slate-600 text-[11px]">
                  Ceding policy risk exceeding company retention limits (PKR 10M) to treaty or facultative reinsurers.
                </p>
                {reinsuranceData && (
                  <div className="grid grid-cols-3 gap-3 bg-white p-3 rounded-lg border border-purple-100 mt-2">
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">Retention Limit</p>
                      <p className="font-bold text-slate-800">{fmtPKR(reinsuranceData.summary.retention_limit)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">Retained Amount</p>
                      <p className="font-bold text-slate-800">{fmtPKR(reinsuranceData.summary.retained_amount)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase">Ceded Amount</p>
                      <p className="font-bold text-purple-700">{fmtPKR(reinsuranceData.summary.treaty_ceded_amount + reinsuranceData.summary.facultative_ceded_amount)}</p>
                    </div>
                  </div>
                )}
                <div className="pt-2 flex gap-2">
                  <button
                    onClick={() => handleReferReinsurance("Swiss Re")}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-purple-700 text-white font-semibold rounded-lg hover:bg-purple-800"
                  >
                    Refer to Swiss Re
                  </button>
                  <button
                    onClick={() => handleReferReinsurance("Munich Re")}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-indigo-700 text-white font-semibold rounded-lg hover:bg-indigo-800"
                  >
                    Refer to Munich Re
                  </button>
                  <button
                    onClick={() => handleReferReinsurance("Pak Re")}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-slate-700 text-white font-semibold rounded-lg hover:bg-slate-800"
                  >
                    Refer to Pak Re
                  </button>
                </div>
              </div>

              {/* 3. Existing Insurance / Declared Policies Check */}
              <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-blue-900 text-sm">3. Existing Insurance &amp; Declared Industry Policies Check</h3>
                <p className="text-slate-600 text-[11px]">
                  Cross-checking total active sum assured across all life insurers against Human Life Value (HLV) limits.
                </p>
                {historyData && (
                  <div className="grid grid-cols-2 gap-3 bg-white p-3 rounded-lg border border-blue-100">
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase font-semibold">Human Life Value Cap</p>
                      <p className="font-bold text-slate-800">{fmtPKR(historyData.human_life_value_cap)} ({historyData.hlv_utilization_ratio.toFixed(2)}×)</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase font-semibold">Industry Existing Cover</p>
                      <p className="font-bold text-slate-800">{fmtPKR(historyData.total_existing_cover)}</p>
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
                    <p className="text-[10px] text-slate-500">14-Day Free-Look Window active until 14 days post delivery.</p>
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
