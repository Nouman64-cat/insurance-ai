"use client";
import { displayDate } from "../../lib/dateDisplay";

import { useEffect, useState } from "react";
import { issuePolicy, initiatePayment, confirmPayment, listPolicyDocuments, downloadDocument, getPrepaid, applyPrepaid, PolicyListItem, IssuanceResult, PaymentMethod, PaymentConfirmResult, PrepaidStatus, fmtPKR } from "@/app/services/policies";
import { getReadiness } from "@/app/services/preIssuance";

// Need to copy fmtCoverage from mock-data
const fmtCoverage = (n: number | null | undefined) => n == null ? "—" : `PKR ${(n / 1000000).toFixed(1)}M`;

export interface IssuanceModalProps {
  policy: PolicyListItem;
  onClose: () => void;
  onIssued: (result: IssuanceResult, policyId: string) => void;
}

export function IssuanceModal({ policy, onClose, onIssued }: IssuanceModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const [checkingReadiness, setCheckingReadiness] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getReadiness(policy.id);
        if (alive) setWarnings(r.warnings ?? []);
      } catch {
      } finally {
        if (alive) setCheckingReadiness(false);
      }
    })();
    return () => { alive = false; };
  }, [policy.id]);

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

  // Demo bypasses are no longer shown as a pop-up before issuing: the policy is issued straight away.
  const showWarningsGate = false;

  const baseRate = 3.5;
  const basePremium = (baseRate / 1000) * (policy.coverage_amount || 0) * (policy.term_years || 10);
  const fee = 500;
  const tax = (basePremium + fee) * 0.01;
  const total = basePremium + fee + tax;

  if (checkingReadiness) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-slate-200 p-8 flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-500 text-sm">Checking issuance readiness…</p>
        </div>
      </div>
    );
  }

  if (showWarningsGate) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-amber-200 overflow-hidden">
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-5 flex items-start gap-3">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6 text-white flex-shrink-0 mt-0.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <div>
              <p className="text-amber-100 text-xs font-medium uppercase tracking-widest">Demo Mode</p>
              <h2 className="text-white text-lg font-bold mt-0.5">Issuance Warnings</h2>
            </div>
          </div>
          <div className="px-6 py-5 space-y-4 text-slate-800">
            <p className="text-sm text-slate-700">
              The following checks are <strong>required in a production environment</strong> but are being bypassed for this demo:
            </p>
            <div className="space-y-2">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <p className="text-xs text-amber-800 leading-relaxed">{w}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5">
              ⚠️ In a live deployment, this issuance would be <strong>blocked</strong> until all the above are resolved. Proceeding only because this is a demo environment.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => setWarningsAcknowledged(true)}
                className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl hover:from-amber-600 hover:to-orange-600 transition-all shadow-sm"
              >
                I Understand, Proceed →
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden text-slate-800">
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
          <div className="bg-slate-50 rounded-xl p-4 space-y-1.5">
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Policy to be Bound</p>
            <p className="text-sm font-bold text-slate-900">{policy.customer_name}</p>
            <p className="text-xs text-slate-500">{policy.product_name} · {policy.term_years} year{policy.term_years > 1 ? "s" : ""} · Sum Assured {fmtCoverage(policy.coverage_amount)}</p>
            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200`}>
              {policy.status}
            </span>
          </div>

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

export interface SuccessModalProps {
  result: IssuanceResult;
  policyName: string;
  onClose: () => void;
  /** A drafted policy awaiting its first premium: go straight on to choosing the payment channel, as the portal does. */
  onContinueToPayment?: () => void;
}

export function SuccessModal({ result, policyName, onClose, onContinueToPayment }: SuccessModalProps) {
  const isPending = (result.status || "").toUpperCase().replace(/[^A-Z]/g, "") === "PENDINGPAYMENT";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden text-slate-800">
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
            { label: "Effective Date", value: displayDate(result.effective_date) },
            { label: "Expiry Date", value: displayDate(result.expiry_date) },
            { label: isPending ? "Amount Due" : "Total Annual Premium", value: fmtPKR(result.amount_due ?? result.premium_breakdown?.total_premium ?? result.payment?.amount ?? 0) },
            ...(isPending && result.payment ? [{ label: "Payment Reference", value: result.payment.reference }] : []),
            { label: "Documents Generated", value: `${result.documents_generated} documents (stubbed)` },
          ].map(row => (
            <div key={row.label} className="flex justify-between items-center py-1.5 border-b border-slate-50 last:border-0">
              <p className="text-xs text-slate-500">{row.label}</p>
              <p className="text-xs font-bold text-slate-900">{row.value}</p>
            </div>
          ))}
          {isPending && onContinueToPayment ? (
            <button onClick={onContinueToPayment} className="w-full mt-2 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl hover:from-blue-700 hover:to-blue-800 transition-all">
              Continue to payment →
            </button>
          ) : <button onClick={onClose} className="w-full mt-2 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl hover:from-emerald-700 hover:to-teal-700 transition-all shadow-sm">
            Done
          </button>}
        </div>
      </div>
    </div>
  );
}

export interface PaymentModalProps {
  policy: PolicyListItem;
  onClose: () => void;
  onConfirmed: (result: PaymentConfirmResult, policyId: string) => void;
}

// The same first-premium window as the portal's policy issuance (frontend/app/policy-issuance/page.tsx):
// prepaid and part-paid premiums, the payment channels and the receipt. Keep the two in step.
const tx = (s: string, _v?: Record<string, unknown>) => s;

function PartPaymentSummary({ paid, pct, quotedTotal, plannedRemaining, finalTotal }: Readonly<{
  paid: number; pct?: number | null; quotedTotal: number; plannedRemaining: number; finalTotal: number;
}>) {
  const balance = Math.max(finalTotal - paid, 0);
  const added = Math.round((balance - plannedRemaining) * 100) / 100;
  const Row = ({ k, v, strong, tone }: { k: React.ReactNode; v: string; strong?: boolean; tone?: string }) => (
    <div className={`flex items-start justify-between gap-4 py-1.5 ${strong ? "font-bold text-slate-900" : "text-slate-600"}`}>
      <dt>{k}</dt><dd className={`tabular-nums whitespace-nowrap ${tone ?? ""}`}>{v}</dd>
    </div>
  );
  return (
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-white text-xs">
      <div className="bg-amber-50 px-3.5 py-2 font-semibold uppercase tracking-wide text-[10px] text-amber-800">{tx("What you pay now")}</div>
      <dl className="divide-y divide-slate-100 px-3.5 py-1">
        <Row k={tx("Final annual premium (after underwriting)")} v={fmtPKR(finalTotal)} strong />
        <Row k={<>{tx("Already paid before underwriting")}{pct ? <span className="text-slate-400"> ({pct}% {tx("of")} {fmtPKR(quotedTotal)})</span> : null}</>} v={`− ${fmtPKR(paid)}`} tone="text-emerald-700" />
        <Row k={tx("Balance to pay now")} v={fmtPKR(balance)} strong tone="text-blue-700" />
      </dl>
      <div className="space-y-1 border-t border-slate-100 bg-slate-50/70 px-3.5 py-2.5 text-slate-600">
        <p>{tx("This balance is made up of:")}</p>
        <ul className="list-disc space-y-0.5 ps-5">
          <li>{tx("the remaining part of your quoted premium")} — <b>{fmtPKR(plannedRemaining)}</b></li>
          <li>{tx("the loading charged by underwriting, added now")} — <b className={added > 0.5 ? "text-amber-700" : ""}>{fmtPKR(Math.max(added, 0))}</b></li>
        </ul>
        <p className="pt-1 text-[11px] text-slate-500">{tx("Only the loading is added at issuance. The policy fee, stamp duty and sales tax were already included in the premium quoted at the proposal.")}</p>
      </div>
    </div>
  );
}

export function PaymentModal({ policy, onClose, onConfirmed }: PaymentModalProps) {
  // The chat has no toast here: the result is shown in the success window and the conversation.
  const notify = (_m: string, _ok: boolean) => {};
  const userRole = typeof window !== "undefined" ? localStorage.getItem("user_role") : null;
  const onStale = undefined as (() => void) | undefined;
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [amountDue, setAmountDue] = useState<number | null>(null);
  const [reference, setReference] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [premiumNoticeId, setPremiumNoticeId] = useState<string | null>(null);
  // The first premium is collected once, at the proposal. When it has been received this window only reports it.
  const [prepaid, setPrepaid] = useState<PrepaidStatus | null>(null);
  // Part of the premium was paid at the proposal (split rule): this window collects the rest.
  const [paidBefore, setPaidBefore] = useState<PrepaidStatus | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pre = await getPrepaid(policy.id).catch(() => ({ received: false }) as PrepaidStatus);
        if (!alive) return;
        if (pre.received && (pre.remaining_due ?? 0) > 0) setPaidBefore(pre);
        if (pre.received && !((pre.remaining_due ?? 0) > 0)) {
          setPrepaid(pre);
          const docs = await listPolicyDocuments(policy.id).catch(() => []);
          const notice = docs.find((d) => d.document_type === "PremiumNotice");
          if (notice && alive) setPremiumNoticeId(notice.id);
          return;
        }
        const [res, docs] = await Promise.all([
          initiatePayment(policy.id),
          listPolicyDocuments(policy.id),
        ]);
        if (!alive) return;
        setMethods(res.available_payment_methods);
        setSelected(res.payment.method);
        setAmountDue(res.amount_due);
        setReference(res.payment.reference);

        const notice = docs.find((d) => d.document_type === "PremiumNotice");
        if (notice) setPremiumNoticeId(notice.id);
      } catch (e: any) {
        if (alive) {
          // The shared client turns the server's reason into the error message.
          const reason: string = e?.message ?? "";
          setError(
            /not awaiting payment/i.test(reason)
              ? tx("This premium has already been paid and the policy is no longer awaiting payment. Close this window; the list will refresh.")
              : reason || tx("Failed to load payment details."),
          );
          if (/not awaiting payment/i.test(reason)) onStale?.();
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [policy.id]);

  const handleConfirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      const result = prepaid
        ? await applyPrepaid(policy.id)
        : await confirmPayment(policy.id, { method: selected, reference });
      notify(tx("Payment confirmed successfully!"), true);
      onConfirmed(result, policy.id);
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? "Payment confirmation failed.";
      setError(msg);
      notify(msg, false);
    } finally {
      setConfirming(false);
    }
  };

  const handleDownloadNotice = async () => {
    if (!premiumNoticeId) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadDocument(policy.id, premiumNoticeId);
      notify(tx("Notice downloaded successfully."), true);
    } catch (e: any) {
      setError(tx("Failed to download Initial Premium Receipt."));
      notify(tx("Failed to download Initial Premium Receipt."), false);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
        <div className="shrink-0 bg-blue-600 px-8 py-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-blue-100 text-xs font-medium uppercase tracking-widest">
                {tx("First Premium")}
              </p>
              <h2 className="text-white text-lg font-bold mt-0.5">
                {prepaid ? tx("Payment already received") : tx("Confirm Payment")}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="text-white/60 hover:text-white transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="w-5 h-5"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-8 py-6 space-y-6 overflow-y-auto">
          <div className="bg-slate-50 rounded-xl p-5 space-y-1.5">
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
              {prepaid ? tx("Policy awaiting activation") : tx("Policy Awaiting Payment")}
            </p>
            <p className="text-sm font-bold text-slate-900">
              {policy.customer_name}
            </p>
            <p className="text-xs text-slate-500 font-mono">
              {policy.policy_number ?? "—"} · {policy.product_name}
            </p>
          </div>

          {prepaid ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800">
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                {tx("Collected at the proposal stage. Nothing more to pay.")}
              </div>
              <dl className="divide-y divide-slate-100 text-sm">
                <div className="flex justify-between py-2"><dt className="text-slate-500">{tx("Amount collected")}</dt><dd className="font-bold text-blue-700">{fmtPKR(prepaid.amount ?? 0)}</dd></div>
                {prepaid.method && <div className="flex justify-between py-2"><dt className="text-slate-500">{tx("Paid by")}</dt><dd className="font-medium text-slate-800">{prepaid.method}</dd></div>}
                {prepaid.reference && <div className="flex justify-between py-2"><dt className="text-slate-500">{tx("Reference")}</dt><dd className="font-mono text-xs text-slate-800">{prepaid.reference}</dd></div>}
                {prepaid.received_at && <div className="flex justify-between py-2"><dt className="text-slate-500">{tx("Received")}</dt><dd className="text-slate-800">{new Date(prepaid.received_at).toLocaleDateString()}</dd></div>}
              </dl>
              <p className="text-xs text-slate-500">{tx("Press “Activate cover” to bind the policy with this payment.")}</p>
            </div>
          ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
          {paidBefore && (
            <PartPaymentSummary paid={paidBefore.amount ?? 0} pct={paidBefore.split?.upfront_pct} quotedTotal={paidBefore.split?.total ?? 0}
              plannedRemaining={paidBefore.split?.remaining_amount ?? 0} finalTotal={(paidBefore.amount ?? 0) + (paidBefore.remaining_due ?? 0)} />
          )}
          </div>
          <div className="space-y-6 lg:col-span-2">
          <div className="flex items-center justify-between rounded-xl border border-blue-100 bg-blue-50/50 px-4 py-3.5">
            <p className="text-sm font-semibold text-slate-700">
              {paidBefore ? tx("Remaining balance due now") : tx("Amount Due")}
            </p>
            <p className="text-2xl font-bold text-blue-700 tabular-nums">
              {loading ? "…" : amountDue != null ? fmtPKR(amountDue) : "—"}
            </p>
          </div>

          <div>
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
              {tx("Payment Channel")}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {methods.map((m) => (
                <button
                  key={m.code}
                  onClick={() => setSelected(m.code)}
                  className={`px-3 py-3 rounded-lg text-sm font-semibold border transition-all ${selected === m.code ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}
                >
                  {tx(m.label)}
                </button>
              ))}
            </div>
          </div>

          {reference && (
            <p className="text-[11px] text-slate-400 font-mono">
              {tx("Reference:")} {reference}
            </p>
          )}

          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="text-xs text-blue-700">
              {tx(
                "Settlement is simulated via a mock gateway. Confirming realizes the first premium and activates coverage.",
              )}
            </p>
          </div>

          </div>
          </div>
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {premiumNoticeId && (
            <button
              onClick={handleDownloadNotice}
              disabled={downloading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-slate-700 bg-white border-2 border-slate-200 rounded-xl hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50 transition-all"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="w-4 h-4"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {downloading
                ? tx("Downloading...")
                : tx("Download Initial Premium Receipt (PDF)")}
            </button>
          )}

        </div>

        <div className="shrink-0 border-t border-slate-100 bg-white px-8 py-4 flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="px-5 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors"
            >
              {tx("Cancel")}
            </button>
            <button
              onClick={handleConfirm}
              disabled={
                loading || confirming || (!prepaid && !selected) || userRole === "Agent"
              }
              title={
                userRole === "Agent"
                  ? tx(
                      "Currently, you have no access to do this, ask your manager",
                    )
                  : undefined
              }
              className="min-w-56 px-6 py-2.5 text-sm font-bold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm"
            >
              {confirming ? tx("Confirming…") : prepaid ? tx("Activate cover") : tx("Confirm & Activate")}
            </button>
        </div>
      </div>
    </div>
  );
}
