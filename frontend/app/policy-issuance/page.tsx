"use client";

import { useEffect, useMemo, useState } from "react";
import { SegmentDropdown, SegmentFilter } from "@/components/SegmentDropdown";
import {
  getPolicyStats,
  listPolicies,
  issuePolicy,
  initiatePayment,
  confirmPayment,
  PolicyListItem,
  PolicyStats,
  IssuanceResult,
  PaymentMethod,
  PaymentConfirmResult,
  fmtPKR,
} from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";
import { PolicyProcessRail } from "@/components/policy/PolicyProcessRail";
import { PolicyLifecycleDrawer } from "@/components/policy/PolicyLifecycleDrawer";
import { LifecycleStepper } from "@/components/policy/LifecycleStepper";

const STATUS_BADGE: Record<string, string> = {
  APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  ACCEPTEDWITHLOADINGS: "bg-amber-50 text-amber-700 border-amber-200",
  PENDINGPAYMENT: "bg-violet-50 text-violet-700 border-violet-200",
  ACTIVE: "bg-blue-50 text-blue-700 border-blue-200",
  ISSUED: "bg-blue-50 text-blue-700 border-blue-200",
  QUOTED: "bg-slate-50 text-slate-600 border-slate-200",
  LAPSED: "bg-red-50 text-red-700 border-red-200",
  CANCELLED: "bg-red-50 text-red-700 border-red-200",
  POSTPONED: "bg-amber-50 text-amber-700 border-amber-200",
  REINSURERREFERRED: "bg-indigo-50 text-indigo-700 border-indigo-200",
  NOTTAKENUP: "bg-slate-50 text-red-700 border-slate-200",
};

interface IssuanceModalProps {
  policy: PolicyListItem;
  onClose: () => void;
  onIssued: (result: IssuanceResult, policyId: string) => void;
}

function IssuanceModal({ policy, onClose, onIssued }: IssuanceModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleIssue = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await issuePolicy(policy.id);
      onIssued(result, policy.id);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Failed to issue policy.");
    } finally {
      setLoading(false);
    }
  };

  // Rough estimate for modal display
  const baseRate = 3.5;
  const basePremium = (baseRate / 1000) * policy.coverage_amount * policy.term_years;
  const fee = 500;
  const tax = (basePremium + fee) * 0.01;
  const total = basePremium + fee + tax;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-emerald-100 text-xs font-medium uppercase tracking-widest">Contract Factory</p>
              <h2 className="text-white text-lg font-bold mt-0.5">Issue Policy</h2>
            </div>
            <button onClick={onClose} className="text-white/60 hover:text-white transition-colors">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Policy Summary */}
          <div className="bg-slate-50 rounded-xl p-4 space-y-1.5">
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Policy to be Bound</p>
            <p className="text-sm font-bold text-slate-900">{policy.customer_name}</p>
            <p className="text-xs text-slate-500">{policy.product_name} · {policy.term_years} year{policy.term_years > 1 ? "s" : ""} · Sum Assured {fmtCoverage(policy.coverage_amount)}</p>
            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_BADGE[(policy.status || "").toUpperCase()] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
              {policy.status}
            </span>
          </div>

          {/* Premium Breakdown */}
          <div>
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-3">Estimated Premium Breakdown</p>
            <div className="space-y-2">
              {[
                { label: "Base Premium", value: basePremium, sub: "Rate × Sum Assured × Term" },
                { label: "Loading Applied", value: 0, sub: "From underwriting decision" },
                { label: "Policy Fee", value: fee, sub: "Flat PKR 500" },
                { label: "Stamp Duty (1%)", value: tax, sub: "Federal tax" },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-slate-700">{row.label}</p>
                    <p className="text-[10px] text-slate-400">{row.sub}</p>
                  </div>
                  <p className="text-sm font-semibold text-slate-800">{fmtPKR(row.value)}</p>
                </div>
              ))}
              <div className="border-t border-slate-200 pt-2 flex items-center justify-between">
                <p className="text-sm font-bold text-slate-900">Total Annual Premium</p>
                <p className="text-base font-bold text-emerald-700">{fmtPKR(total)}</p>
              </div>
            </div>
          </div>

          {/* Payment-gate notice */}
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="text-xs text-amber-700">Issuing drafts the contract and generates the policy number, then moves it to <span className="font-semibold">Pending Payment</span>. Coverage only activates once the first premium is confirmed.</p>
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
              Cancel
            </button>
            <button
              onClick={handleIssue}
              disabled={loading}
              className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50 transition-all shadow-sm"
            >
              {loading ? "Drafting…" : "Draft & Send to Payment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SuccessModalProps {
  result: IssuanceResult;
  policyName: string;
  onClose: () => void;
}

function SuccessModal({ result, policyName, onClose }: SuccessModalProps) {
  const isPending = (result.status || "").toUpperCase().replace(/[^A-Z]/g, "") === "PENDINGPAYMENT";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden">
        <div className={`px-6 py-5 text-center bg-gradient-to-r ${isPending ? "from-amber-500 to-orange-500" : "from-emerald-500 to-teal-500"}`}>
          <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-3">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-7 h-7">
              {isPending
                ? <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>
                : <polyline points="20 6 9 17 4 12" />}
            </svg>
          </div>
          <h2 className="text-white text-xl font-bold">{isPending ? "Policy Drafted" : "Policy Issued!"}</h2>
          <p className={`text-sm mt-1 ${isPending ? "text-amber-100" : "text-emerald-100"}`}>
            {isPending ? `${policyName} — awaiting first premium` : policyName}
          </p>
        </div>
        <div className="px-6 py-5 space-y-3">
          {[
            { label: "Policy Number", value: result.policy_number },
            { label: "Status", value: result.status },
            { label: "Effective Date", value: result.effective_date },
            { label: "Expiry Date", value: result.expiry_date },
            { label: isPending ? "Amount Due" : "Total Annual Premium", value: fmtPKR(result.amount_due ?? result.premium_breakdown.total_premium) },
            ...(isPending && result.payment ? [{ label: "Payment Reference", value: result.payment.reference }] : []),
            { label: "Documents Generated", value: `${result.documents_generated} documents (stubbed)` },
          ].map(row => (
            <div key={row.label} className="flex justify-between items-center py-1.5 border-b border-slate-50 last:border-0">
              <p className="text-xs text-slate-500">{row.label}</p>
              <p className="text-xs font-bold text-slate-900">{row.value}</p>
            </div>
          ))}
          <button onClick={onClose} className="w-full mt-2 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl hover:from-emerald-700 hover:to-teal-700 transition-all shadow-sm">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

interface PaymentModalProps {
  policy: PolicyListItem;
  onClose: () => void;
  onConfirmed: (result: PaymentConfirmResult, policyId: string) => void;
}

function PaymentModal({ policy, onClose, onConfirmed }: PaymentModalProps) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [amountDue, setAmountDue] = useState<number | null>(null);
  const [reference, setReference] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await initiatePayment(policy.id);
        if (!alive) return;
        setMethods(res.available_payment_methods);
        setSelected(res.payment.method);
        setAmountDue(res.amount_due);
        setReference(res.payment.reference);
      } catch (e: any) {
        if (alive) setError(e?.response?.data?.detail ?? "Failed to load payment details.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [policy.id]);

  const handleConfirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      const result = await confirmPayment(policy.id, { method: selected, reference });
      onConfirmed(result, policy.id);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Payment confirmation failed.");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden">
        <div className="bg-gradient-to-r from-amber-600 to-orange-600 px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-amber-100 text-xs font-medium uppercase tracking-widest">First Premium Collection</p>
              <h2 className="text-white text-lg font-bold mt-0.5">Confirm Payment</h2>
            </div>
            <button onClick={onClose} className="text-white/60 hover:text-white transition-colors">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div className="bg-slate-50 rounded-xl p-4 space-y-1.5">
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Policy Awaiting Payment</p>
            <p className="text-sm font-bold text-slate-900">{policy.customer_name}</p>
            <p className="text-xs text-slate-500 font-mono">{policy.policy_number ?? "—"} · {policy.product_name}</p>
          </div>

          <div className="flex items-center justify-between border-y border-slate-100 py-3">
            <p className="text-sm font-semibold text-slate-700">Amount Due</p>
            <p className="text-lg font-bold text-amber-700">
              {loading ? "…" : amountDue != null ? fmtPKR(amountDue) : "—"}
            </p>
          </div>

          <div>
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">Payment Channel</p>
            <div className="grid grid-cols-2 gap-2">
              {methods.map(m => (
                <button
                  key={m.code}
                  onClick={() => setSelected(m.code)}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${selected === m.code ? "bg-amber-50 border-amber-300 text-amber-800" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {reference && (
            <p className="text-[11px] text-slate-400 font-mono">Reference: {reference}</p>
          )}

          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="text-xs text-blue-700">Settlement is simulated via a mock gateway. Confirming realizes the first premium and activates coverage.</p>
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading || confirming || !selected}
              className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-amber-600 to-orange-600 rounded-xl hover:from-amber-700 hover:to-orange-700 disabled:opacity-50 transition-all shadow-sm"
            >
              {confirming ? "Confirming…" : "Confirm & Activate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PolicyIssuancePage() {
  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"queue" | "active">("queue");
  const [selectedPolicy, setSelectedPolicy] = useState<PolicyListItem | null>(null);
  const [paymentPolicy, setPaymentPolicy] = useState<PolicyListItem | null>(null);
  const [viewPolicy, setViewPolicy] = useState<PolicyListItem | null>(null);
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [issuanceResult, setIssuanceResult] = useState<{ result: IssuanceResult, policyName: string } | null>(null);
  const [activatedMsg, setActivatedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [s, p] = await Promise.all([getPolicyStats(), listPolicies()]);
      setStats(s);
      setPolicies(p);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const queue = useMemo(() =>
    policies.filter(p => {
      const status = (p.status || "").toUpperCase();
      const caseStatus = (p.case_status || "").toUpperCase();
      if (status === "APPROVED") return caseStatus === "APPROVED";
      return ["ACCEPTEDWITHLOADINGS", "PENDINGPAYMENT", "ISSUED"].includes(status);
    }),
    [policies]);

  const active = useMemo(() =>
    policies.filter(p => (p.status || "").toUpperCase() === "ACTIVE"),
    [policies]);

  const filtered = useMemo(() => {
    let list = tab === "queue" ? queue : active;

    // Segment filter
    if (segment !== "all") {
      list = list.filter(p => p.segment === segment);
    }

    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(p =>
      p.customer_name.toLowerCase().includes(q) ||
      (p.policy_number ?? "").toLowerCase().includes(q) ||
      p.product_name.toLowerCase().includes(q)
    );
  }, [tab, queue, active, search, segment]);

  const segmentCounts = useMemo(() => {
    const list = tab === "queue" ? queue : active;
    return {
      all: list.length,
      individual: list.filter(p => p.segment === "individual").length,
      organization: list.filter(p => p.segment === "organization").length,
      family: list.filter(p => p.segment === "family").length,
    };
  }, [tab, queue, active]);

  const pendingPaymentCount = useMemo(
    () => policies.filter(p => (p.status || "").toUpperCase().replace(/[^A-Z]/g, "") === "PENDINGPAYMENT").length,
    [policies]);

  const handleIssued = (result: IssuanceResult, policyId: string) => {
    const pol = policies.find(p => p.id === policyId);
    setSelectedPolicy(null);
    setIssuanceResult({ result, policyName: pol?.customer_name ?? "Policy" });
    load();
  };

  const handleConfirmed = (result: PaymentConfirmResult, policyId: string) => {
    const pol = policies.find(p => p.id === policyId);
    setPaymentPolicy(null);
    setActivatedMsg(`${pol?.customer_name ?? "Policy"} — ${result.policy_number} is now Active.`);
    load();
    setTimeout(() => setActivatedMsg(null), 6000);
  };

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Policy Issuance</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Bind approved proposals into active insurance contracts — calculate premiums, generate policy numbers, and issue legal documents.
        </p>
      </div>

      {errorMsg && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg border border-red-200">
          <p className="font-bold">Error loading data:</p>
          <p>{errorMsg}</p>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { title: "Pending Issuance", value: stats?.pending_issuance ?? "—", sub: "approved, not yet bound", color: "amber" },
          { title: "Pending Payment", value: loading ? "—" : pendingPaymentCount, sub: "awaiting first premium", color: "violet" },
          { title: "Active Policies", value: stats?.active ?? "—", sub: "in-force coverage", color: "emerald" },
          { title: "Expiring (30d)", value: stats?.expiring_30d ?? "—", sub: "renewal due soon", color: "blue" },
          { title: "Lapsed", value: stats?.lapsed ?? "—", sub: "coverage terminated", color: "red" },
        ].map(k => (
          <div key={k.title} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{k.title}</p>
            <p className={`text-3xl font-bold mt-1 ${k.color === "amber" ? "text-amber-600" : k.color === "emerald" ? "text-emerald-600" : k.color === "red" ? "text-red-600" : k.color === "violet" ? "text-violet-600" : "text-blue-600"}`}>
              {loading ? <span className="text-slate-300">—</span> : k.value}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Process explainer rail */}
      {!loading && <PolicyProcessRail policies={policies} />}

      {/* Tab Bar + Search */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
          <input
            type="text"
            placeholder="Search customer, policy, product…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400"
          />
          <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-slate-100/80 p-1 rounded-xl border border-slate-200/60 shrink-0">
            {(["queue", "active"] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
              >
                {t === "queue" ? `Issuance Queue (${queue.length})` : `Active Policies (${active.length})`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 flex justify-center"><div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-emerald-500" /></div>
        ) : filtered.length === 0 ? (
          <div className="py-20 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <span className="text-2xl">📋</span>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {tab === "queue" ? "No policies awaiting issuance" : "No active policies"}
            </p>
            <p className="text-xs text-slate-400 mt-1 max-w-xs">
              {tab === "queue" ? "Approved cases from underwriting will appear here." : "Issued policies will appear here once bound."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">Customer</th>
                  {tab === "queue" && <th className="px-5 py-3 text-left">Case No</th>}
                  {tab === "active" && <th className="px-5 py-3 text-left">Policy No</th>}
                  <th className="px-5 py-3 text-left">Product</th>
                  <th className="px-5 py-3 text-right">Sum Assured</th>
                  <th className="px-5 py-3 text-left">Status</th>
                  {tab === "queue" && <th className="px-5 py-3 text-left w-56">Stage</th>}
                  {tab === "active" && <th className="px-5 py-3 text-left">Expiry</th>}
                  <th className="px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map(p => (
                  <tr
                    key={p.id}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => setViewPolicy(p)}
                  >
                    <td className="px-5 py-3">
                      <div>
                        <p className="font-semibold text-slate-800 text-xs">{p.customer_name}</p>
                        {tab === "queue" && (
                          <p className="text-[10px] text-slate-400 mt-0.5">{p.term_years}yr term</p>
                        )}
                      </div>
                    </td>
                    {tab === "queue" && (
                      <td className="px-5 py-3">
                        {p.case_number ? (
                          <p className="font-mono text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded font-semibold inline-block">{p.case_number}</p>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )}
                    {tab === "active" && (
                      <td className="px-5 py-3">
                        <p className="font-mono text-[10px] text-emerald-700 font-bold inline-block">{p.policy_number ?? "—"}</p>
                      </td>
                    )}
                    <td className="px-5 py-3 text-xs text-slate-600">{p.product_name}</td>
                    <td className="px-5 py-3 text-right font-semibold text-slate-700 text-xs">{fmtCoverage(p.coverage_amount)}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_BADGE[(p.status || "").toUpperCase()] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                        {p.status}
                      </span>
                    </td>
                    {tab === "queue" && (
                      <td className="px-5 py-3">
                        <div className="max-w-[190px]">
                          <LifecycleStepper status={p.status} compact />
                        </div>
                      </td>
                    )}
                    {tab === "active" && (
                      <td className="px-5 py-3 text-xs text-slate-500">{p.expiry_date ?? "—"}</td>
                    )}
                    <td className="px-5 py-3 text-right">
                      {tab === "queue" ? (
                        (p.status || "").toUpperCase().replace(/[^A-Z]/g, "") === "PENDINGPAYMENT" ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPaymentPolicy(p);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-colors shadow-sm"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                              <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
                            </svg>
                            Confirm Payment
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedPolicy(p);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition-colors shadow-sm"
                          >
                            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                              <polygon points="5 3 19 12 5 21" />
                            </svg>
                            Issue Policy
                          </button>
                        )
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setViewPolicy(p);
                          }}
                          className="text-xs font-semibold text-emerald-600 hover:text-emerald-800 transition-colors"
                        >
                          View Details
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Activation toast */}
      {activatedMsg && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-emerald-600 text-white text-sm font-semibold px-4 py-3 rounded-xl shadow-lg animate-in slide-in-from-bottom-4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {activatedMsg}
        </div>
      )}

      {/* Modals */}
      {selectedPolicy && (
        <IssuanceModal
          policy={selectedPolicy}
          onClose={() => setSelectedPolicy(null)}
          onIssued={handleIssued}
        />
      )}
      {paymentPolicy && (
        <PaymentModal
          policy={paymentPolicy}
          onClose={() => setPaymentPolicy(null)}
          onConfirmed={handleConfirmed}
        />
      )}
      {viewPolicy && (
        <PolicyLifecycleDrawer
          policyId={viewPolicy.id}
          fallbackName={viewPolicy.customer_name}
          onClose={() => setViewPolicy(null)}
        />
      )}
      {issuanceResult && (
        <SuccessModal
          result={issuanceResult.result}
          policyName={issuanceResult.policyName}
          onClose={() => setIssuanceResult(null)}
        />
      )}
    </div>
  );
}
