"use client";

import { displayDate } from '../../lib/dateDisplay';
import { useEffect, useMemo, useState } from "react";
import { SegmentDropdown, SegmentFilter } from "@/components/SegmentDropdown";
import { useNotify } from "@/components/NotificationContext";
import {
  getPolicyStats,
  listPolicies,
  issuePolicy,
  getIssuancePreview,
  initiatePayment,
  confirmPayment,
  getPrepaid,
  applyPrepaid,
  type PrepaidStatus,
  listPolicyDocuments,
  downloadDocument,
  PolicyListItem,
  PolicyStats,
  IssuanceResult,
  IssuancePreview,
  PaymentMethod,
  PaymentConfirmResult,
  fmtPKR,
} from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";

import { PolicyLifecycleDrawer } from "@/components/policy/PolicyLifecycleDrawer";
import { LifecycleStepper } from "@/components/policy/LifecycleStepper";
import { MetricCard } from "@/components/MetricCard";
import FiltersPanel from "@/components/FiltersPanel";

const STATUS_BADGE: Record<string, string> = {
  APPROVED: "bg-blue-50 text-blue-700 border-blue-200",
  ACCEPTEDWITHLOADINGS: "bg-amber-50 text-amber-700 border-amber-200",
  PENDINGPAYMENT: "bg-blue-50 text-blue-700 border-blue-200",
  ACTIVE: "bg-blue-50 text-blue-700 border-blue-200",
  ISSUED: "bg-blue-50 text-blue-700 border-blue-200",
  QUOTED: "bg-slate-50 text-slate-600 border-slate-200",
  LAPSED: "bg-red-50 text-red-700 border-red-200",
  CANCELLED: "bg-red-50 text-red-700 border-red-200",
  POSTPONED: "bg-amber-50 text-amber-700 border-amber-200",
  REINSURERREFERRED: "bg-blue-50 text-blue-700 border-blue-200",
  NOTTAKENUP: "bg-slate-50 text-red-700 border-slate-200",
};

// ── Shared issuance stepper ──────────────────────────────────────────────────
const ISSUE_STEPS = ["Review", "Bind & Pay", "Policy Pack"] as const;

function IssueStepper({ current, prepaid = false }: Readonly<{ current: number; prepaid?: boolean }>) {
  return (
    <div className="flex items-center gap-2">
      {ISSUE_STEPS.map((step, i) => {
        // The first premium is collected at the proposal, so there is nothing to "pay" in this flow.
        const s = prepaid && step === "Bind & Pay" ? "Bind" : step;
        const done = i < current,
          active = i === current;
        return (
          <div key={s} className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span
                className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${done ? "bg-white text-blue-600" : active ? "bg-white/90 text-blue-700" : "bg-white/25 text-white"}`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={`text-[11px] font-semibold ${active || done ? "text-white" : "text-white/60"}`}
              >
                {s}
              </span>
            </div>
            {i < ISSUE_STEPS.length - 1 && (
              <span className="w-5 h-px bg-white/30" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  value,
}: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
        {label}
      </p>
      <p className="text-sm font-semibold text-slate-800 mt-0.5">{value}</p>
    </div>
  );
}

interface IssuanceModalProps {
  policy: PolicyListItem;
  onClose: () => void;
  onIssued: (result: IssuanceResult, policyId: string) => void;
  userRole?: string | null;
}

// Step 1 — Review & confirm the contract before binding.
function IssuanceModal({
  policy,
  onClose,
  onIssued,
  userRole,
}: IssuanceModalProps) {
  const { notify } = useNotify();
  const [preview, setPreview] = useState<IssuancePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepaid, setPrepaid] = useState<PrepaidStatus | null>(null);   // the initial premium collected at the proposal, if any

  useEffect(() => {
    let alive = true;
    getPrepaid(policy.id).then((r) => { if (alive && r.received) setPrepaid(r); }).catch(() => undefined);
    (async () => {
      try {
        const p = await getIssuancePreview(policy.id);
        if (alive) setPreview(p);
      } catch (e: any) {
        if (alive)
          setError(
            e?.response?.data?.detail ?? tx("Failed to load issuance preview."),
          );
      } finally {
        if (alive) setLoadingPreview(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [policy.id]);

  const handleIssue = async () => {
    setIssuing(true);
    setError(null);
    try {
      const result = await issuePolicy(policy.id);
      notify(tx("Policy issued successfully!"), true);
      onIssued(result, policy.id);
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? "Failed to issue policy.";
      setError(msg);
      notify(msg, false);
    } finally {
      setIssuing(false);
    }
  };

  const pb = preview?.premium_breakdown;
  const ready = preview?.readiness.ready_to_issue ?? false;
  const blockers = preview?.readiness.blockers ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header + stepper */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-600 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-white text-lg font-bold">
              {tx("Issue Policy")}
            </h2>
            <div className="mt-2">
              <IssueStepper current={0} prepaid={!!prepaid} />
            </div>
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

        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          {loadingPreview ? (
            <div className="py-12 flex justify-center">
              <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : !preview ? (
            <p className="text-sm text-red-600">
              {error ?? tx("Preview unavailable.")}
            </p>
          ) : (
            <>
              {/* Readiness banner */}
              {ready ? (
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-semibold text-blue-700">
                  {tx("✓ All pre-issuance gates cleared — ready to bind.")}
                </div>
              ) : (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                  <p className="text-xs font-bold text-red-700">
                    {blockers.length} {tx("gate(s) block issuance")}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {blockers.map((b) => (
                      <li key={b} className="text-[11px] text-red-600">
                        • {b}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* Insured */}
              <div>
                <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
                  {tx("Insured")}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-50 rounded-xl p-4">
                  <Field label={tx("Name")} value={preview.insured.name} />
                  <Field
                    label={tx("CNIC")}
                    value={preview.insured.cnic ?? "—"}
                  />
                  <Field
                    label={tx("Date of birth")}
                    value={displayDate(preview.insured.dob ?? "—")}
                  />
                </div>
              </div>

              {/* Contract terms */}
              <div>
                <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
                  {tx("Contract terms")}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 bg-slate-50 rounded-xl p-4">
                  <Field
                    label={tx("Product")}
                    value={preview.contract.product_name}
                  />
                  <Field
                    label={tx("Sum assured")}
                    value={fmtCoverage(preview.contract.coverage_amount)}
                  />
                  <Field
                    label={tx("Insurance Terms")}
                    value={`${preview.contract.term_years} years`}
                  />
                  <Field
                    label={tx("Start date")}
                    value={displayDate(preview.contract.effective_date)}
                  />
                  <Field
                    label={tx("Maturity date")}
                    value={
                      <span className="text-blue-700">
                        {displayDate(preview.contract.maturity_date)}
                      </span>
                    }
                  />
                  <Field
                    label={tx("Billing")}
                    value={preview.contract.billing_frequency}
                  />
                </div>
              </div>

              {/* Premium breakdown: only when nothing has been collected yet. A premium already received (before underwriting) is
                  shown in the payment box below, with its breakdown on the receipt, so it is not repeated here. */}
              {pb && !prepaid && (
                <div>
                  <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
                    {tx("Premium breakdown")}
                  </p>
                  <div className="rounded-xl border border-slate-200 divide-y divide-slate-50">
                    {[
                      ["Base premium", pb.base_premium],
                      ["Loading", pb.loading_amount],
                      ["Policy fee", pb.policy_fee],
                      ["Stamp duty", pb.stamp_duty_amount ?? 0],
                      ["Sales tax", pb.tax_amount],
                    ].map(([l, v]) => (
                      <div
                        key={l as string}
                        className="flex justify-between px-4 py-2"
                      >
                        <span className="text-xs text-slate-600">{l}</span>
                        <span className="text-xs font-semibold text-slate-800">
                          {fmtPKR(v as number)}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between px-4 py-2.5 bg-blue-50/50">
                      <span className="text-sm font-bold text-slate-900">
                        {tx("Total annual premium")}
                      </span>
                      <span className="text-sm font-bold text-blue-700">
                        {fmtPKR(pb.total_premium)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Beneficiaries */}
              <div>
                <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
                  {tx("Beneficiaries")}
                </p>
                {preview.beneficiaries.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">
                    {tx("None captured.")}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {preview.beneficiaries.map((b) => (
                      <span
                        key={b.name}
                        className="text-xs bg-slate-100 border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700"
                      >
                        {b.name}{" "}
                        <span className="text-slate-400">
                          · {b.relationship} · {b.share_pct}%
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {prepaid ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-900 space-y-1">
                  <p className="font-semibold">{tx("Payment received")} · {fmtPKR(prepaid.amount ?? 0)}</p>
                  <p>
                    {tx("The first premium was collected at the proposal stage")}
                    {prepaid.method ? ` (${prepaid.method}${prepaid.reference ? `, ${prepaid.reference}` : ""})` : ""}.{" "}
                    {tx("Issuing starts cover straight away with this payment. You will not be asked to pay again.")}
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  {tx("Issuing mints the policy number and drafts the contract, then moves to")}{" "}
                  <b>{tx("Pending Payment")}</b>
                  {tx(". Cover activates once the first premium is confirmed.")}
                </p>
              )}
            </>
          )}

          {error && !loadingPreview && preview && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer actions */}
        <div className="border-t border-slate-100 px-6 py-4 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors"
          >
            {tx("Cancel")}
          </button>
          <button
            onClick={handleIssue}
            disabled={
              issuing || loadingPreview || !ready || userRole === "Agent"
            }
            title={
              userRole === "Agent"
                ? tx(
                    "Currently, you have no access to do this, ask your manager",
                  )
                : !ready
                  ? tx("Clear the blocking gates first")
                  : undefined
            }
            className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-blue-600 rounded-xl hover:from-blue-700 hover:to-blue-700 disabled:opacity-50 transition-all shadow-sm"
          >
            {issuing ? tx("Binding…") : prepaid ? tx("Issue & activate →") : tx("Issue & bind →")}
          </button>
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
  const isPending =
    (result.status || "").toUpperCase().replace(/[^A-Z]/g, "") ===
    "PENDINGPAYMENT";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden">
        <div className="px-6 py-5 bg-gradient-to-r from-blue-600 to-blue-600">
          <div className="flex justify-center mb-3">
            <IssueStepper current={1} prepaid={((result as any).initial_premium_credited ?? 0) > 0} />
          </div>
          <div className="text-center">
            <h2 className="text-white text-xl font-bold">
              {isPending
                ? tx("Policy Drafted & Number Assigned")
                : tx("Policy Issued!")}
            </h2>
            <p className="text-sm mt-1 text-blue-100">
              {policyName}
              {isPending ? " " + tx("— next: collect the remaining balance") : ""}
            </p>
          </div>
        </div>
        <div className="px-6 py-5 space-y-3">
          {[
            { label: "Policy Number", value: result.policy_number },
            { label: "Status", value: result.status },
            { label: "Effective Date", value: result.effective_date },
            {
              label: "Maturity Date",
              value: result.maturity_date ?? result.expiry_date,
            },
            ...((result as any).initial_premium_credited > 0
              ? [{ label: "Already paid at proposal", value: fmtPKR((result as any).initial_premium_credited) }]
              : []),
            {
              label: isPending ? "Balance Due" : "Total Annual Premium",
              value: fmtPKR(
                result.amount_due ?? result.premium_breakdown.total_premium,
              ),
            },
            ...(isPending && result.payment
              ? [
                  {
                    label: "Payment Reference",
                    value: result.payment.reference,
                  },
                ]
              : []),
          ].map((row) => (
            <div
              key={row.label}
              className="flex justify-between items-center py-1.5 border-b border-slate-50 last:border-0"
            >
              <p className="text-xs text-slate-500">{tx(row.label)}</p>
              <p className="text-xs font-bold text-slate-900">{row.value}</p>
            </div>
          ))}
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5 mt-1">
            <span aria-hidden>📄</span>
            <p className="text-[11px] text-blue-800">
              {tx(
                "The Policy Schedule, Certificate & Wording are generated and become downloadable once the first premium is confirmed (Bind & Pay).",
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-full mt-1 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-blue-600 rounded-xl hover:from-blue-700 hover:to-blue-700 transition-all shadow-sm"
          >
            {isPending ? tx("Continue to payment →") : tx("Done")}
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
  onStale?: () => void;
  userRole?: string | null;
}

const isPendingPayment = (status: string | null | undefined) => (status || "").toUpperCase().replace(/[^A-Z]/g, "") === "PENDINGPAYMENT";

function PaymentModal({
  policy,
  onClose,
  onConfirmed,
  onStale,
  userRole,
}: PaymentModalProps) {
  const { notify } = useNotify();
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

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pre = await getPrepaid(policy.id).catch(() => ({ received: false }) as PrepaidStatus);
        if (!alive) return;
        if (pre.received) {
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
      await downloadDocument(policy.id, premiumNoticeId, `Initial Premium Receipt – ${policy.policy_number ?? ""}`.trim());
      notify(tx("Notice downloaded successfully."), true);
    } catch (e: any) {
      setError(tx("Failed to download Initial Premium Receipt."));
      notify(tx("Failed to download Initial Premium Receipt."), false);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden">
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-5">
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

        <div className="px-6 py-5 space-y-5">
          <div className="bg-slate-50 rounded-xl p-4 space-y-1.5">
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
          <>
          <div className="flex items-center justify-between border-y border-slate-100 py-3">
            <p className="text-sm font-semibold text-slate-700">
              {tx("Amount Due")}
            </p>
            <p className="text-lg font-bold text-blue-700">
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
                  className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${selected === m.code ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}
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

          </>
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

          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors"
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
              className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl hover:from-blue-700 hover:to-blue-800 disabled:opacity-50 transition-all shadow-sm"
            >
              {confirming ? tx("Confirming…") : prepaid ? tx("Activate cover") : tx("Confirm & Activate")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Pagination, usePagination } from "@/components/Pagination";
import { tx } from "@/lib/i18n/tx";

function PolicyIssuanceContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialTab = searchParams.get("tab") === "active" ? "active" : "queue";

  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"queue" | "active">(initialTab);

  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "active" || t === "queue") {
      setTab(t);
    }
  }, [searchParams]);

  const [selectedPolicy, setSelectedPolicy] = useState<PolicyListItem | null>(
    null,
  );
  const [paymentPolicy, setPaymentPolicy] = useState<PolicyListItem | null>(
    null,
  );
  const [viewPolicy, setViewPolicy] = useState<PolicyListItem | null>(null);
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [issuanceResult, setIssuanceResult] = useState<{
    result: IssuanceResult;
    policyName: string;
  } | null>(null);
  const [activatedMsg, setActivatedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);

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

  useEffect(() => {
    if (typeof window !== "undefined") {
      setUserRole(localStorage.getItem("user_role"));
    }
    load();
  }, []);

  const queue = useMemo(
    () =>
      policies.filter((p) => {
        const status = (p.status || "").toUpperCase();
        if (status === "ACTIVE") return false;

        const isPuCleared =
          typeof window !== "undefined"
            ? localStorage.getItem("pu_cleared_" + p.id) === "true"
            : false;
        if (isPuCleared) return true;

        const caseStatus = (p.case_status || "").toUpperCase();
        if (status === "APPROVED") return caseStatus === "APPROVED";
        return [
          "ACCEPTEDWITHLOADINGS",
          "COUNTEROFFER",
          "PENDINGPAYMENT",
          "ISSUED",
        ].includes(status);
      }),
    [policies],
  );

  const active = useMemo(
    () => policies.filter((p) => (p.status || "").toUpperCase() === "ACTIVE"),
    [policies],
  );

  const clearFilters = () => {
    setFilterStatus("ALL");
    setDateFrom("");
    setDateTo("");
  };

  const structuredFilterCount = [
    filterStatus !== "ALL",
    dateFrom || dateTo,
  ].filter(Boolean).length;

  const activeFilterChips: {
    key: string;
    label: string;
    onRemove: () => void;
  }[] = [];
  if (filterStatus !== "ALL")
    activeFilterChips.push({
      key: "status",
      label: filterStatus,
      onRemove: () => setFilterStatus("ALL"),
    });
  if (dateFrom || dateTo) {
    const label =
      dateFrom && dateTo
        ? dateFrom === dateTo
          ? `On ${dateFrom}`
          : `${dateFrom} → ${dateTo}`
        : dateFrom
          ? `From ${dateFrom}`
          : `Until ${dateTo}`;
    activeFilterChips.push({
      key: "date",
      label,
      onRemove: () => {
        setDateFrom("");
        setDateTo("");
      },
    });
  }

  const filtered = useMemo(() => {
    let list = tab === "queue" ? queue : active;

    // Segment filter
    if (segment !== "all") {
      list = list.filter((p) => p.segment === segment);
    }
    if (filterStatus !== "ALL") {
      list = list.filter((p) => p.status === filterStatus);
    }
    if (dateFrom || dateTo) {
      list = list.filter((p) => {
        const d = new Date(p.created_at || new Date()).getTime();
        const start = dateFrom ? new Date(dateFrom).getTime() : 0;
        const end = dateTo ? new Date(dateTo).getTime() + 86400000 : Infinity;
        return d >= start && d <= end;
      });
    }

    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (p) =>
        p.customer_name.toLowerCase().includes(q) ||
        (p.policy_number ?? "").toLowerCase().includes(q) ||
        p.product_name.toLowerCase().includes(q),
    );
  }, [tab, queue, active, search, segment, filterStatus, dateFrom, dateTo]);

  const { pageItems: pagedPolicies, pagination } = usePagination(
    filtered,
    12,
    tab,
  );

  const segmentCounts = useMemo(() => {
    const list = tab === "queue" ? queue : active;
    return {
      all: list.length,
      individual: list.filter((p) => p.segment === "individual").length,
      organization: list.filter((p) => p.segment === "organization").length,
      family: list.filter((p) => p.segment === "family").length,
    };
  }, [tab, queue, active]);

  const pendingPaymentCount = useMemo(
    () =>
      policies.filter(
        (p) =>
          (p.status || "").toUpperCase().replace(/[^A-Z]/g, "") ===
          "PENDINGPAYMENT",
      ).length,
    [policies],
  );

  const handleIssued = (result: IssuanceResult, policyId: string) => {
    const pol = policies.find((p) => p.id === policyId);
    setSelectedPolicy(null);
    setIssuanceResult({ result, policyName: pol?.customer_name ?? "Policy" });
    load();
  };

  // Pre-issuance is finished once the policy is Active; it then lives in the Post-Issuance Queue, so go there
  // (the URL carries the tab, which also moves the sidebar highlight).
  const goToPostIssuance = () => {
    setTab("active");
    router.replace("/policy-issuance?tab=active");
  };

  const handleConfirmed = (result: PaymentConfirmResult, policyId: string) => {
    const pol = policies.find((p) => p.id === policyId);
    setPaymentPolicy(null);
    setActivatedMsg(
      tx("{0} — {1} is now Active.", {
        0: pol?.customer_name ?? "Policy",
        1: result.policy_number,
      }),
    );
    load();
    goToPostIssuance();
    setTimeout(() => setActivatedMsg(null), 6000);
  };

  return (
    <div className="px-6 py-4 space-y-4 max-w-screen-2xl mx-auto w-full">
      {/* Sleek Compact Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200/80">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-xs shrink-0">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="w-4 h-4"
            >
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M9 15l2 2 4-4" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 tracking-tight">
                {tx("Policy Issuance Hub")}
              </h1>
              <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 text-[10px] font-semibold uppercase tracking-wider">
                {tx("Unified Portal")}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              {tx(
                "Bind approved proposals, verify pre-issuance gates, collect premiums & manage active contracts.",
              )}
            </p>
          </div>
        </div>

        {/* Segmented Switcher removed as sidebar handles navigation */}
      </div>

      {errorMsg && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg border border-red-200">
          <p className="font-bold">{tx("Error loading data:")}</p>
          <p>{errorMsg}</p>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          {
            title: "Pending Issuance",
            value: stats?.pending_issuance ?? "—",
            sub: "approved, not yet bound",
            color: "blue" as const,
          },
          {
            title: "Pending Payment",
            value: loading ? "—" : pendingPaymentCount,
            sub: "awaiting payment or activation",
            color: "blue" as const,
          },
          {
            title: "Active Policies",
            value: stats?.active ?? "—",
            sub: "in-force coverage",
            color: "blue" as const,
          },
          {
            title: "Expiring (30d)",
            value: stats?.expiring_30d ?? "—",
            sub: "renewal due soon",
            color: "blue" as const,
          },
          {
            title: "Lapsed",
            value: stats?.lapsed ?? "—",
            sub: "coverage terminated",
            color: "blue" as const,
          },
        ].map((k) => (
          <MetricCard
            key={k.title}
            title={k.title}
            value={loading ? "—" : k.value}
            subtitle={k.sub}
            accent={k.color}
          />
        ))}
      </div>

      {/* Search & Filters */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
          <input
            type="text"
            placeholder={tx("Search customer, policy, product…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-xs px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 bg-slate-50"
          />
          <SegmentDropdown
            value={segment}
            onChange={setSegment}
            counts={segmentCounts}
          />

          <FiltersPanel
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
            statusFilter={filterStatus}
            onStatusChange={setFilterStatus}
            statusOptions={[
              { value: "PendingPayment", label: "Pending Payment" },
              { value: "Approved", label: "Approved" },
              { value: "Active", label: "Active" },
              { value: "Issued", label: "Issued" },
              { value: "Quoted", label: "Quoted" },
            ]}
            activeCount={structuredFilterCount}
            onClearAll={clearFilters}
          />
        </div>
      </div>
      {activeFilterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-2">
          {activeFilterChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-blue-50 border border-blue-100 text-blue-700 text-xs font-medium"
            >
              {tx(chip.label)}
              <button
                onClick={chip.onRemove}
                className="w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-blue-100 text-blue-400 hover:text-blue-700"
              >
                ✕
              </button>
            </span>
          ))}
          <button
            onClick={clearFilters}
            className="text-xs font-semibold text-slate-400 hover:text-blue-600 hover:underline ml-1"
          >
            {tx("Clear all")}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 flex justify-center">
            <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-20 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <span className="text-2xl">📋</span>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {tab === "queue"
                ? tx("No policies awaiting issuance")
                : tx("No active policies")}
            </p>
            <p className="text-xs text-slate-400 mt-1 max-w-xs">
              {tab === "queue"
                ? tx("Approved cases from underwriting will appear here.")
                : tx("Issued policies will appear here once bound.")}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    <th className="px-5 py-3 text-left">{tx("Customer")}</th>
                    {tab === "queue" && (
                      <th className="px-5 py-3 text-left">{tx("Case No")}</th>
                    )}
                    {tab === "active" && (
                      <th className="px-5 py-3 text-left">{tx("Policy No")}</th>
                    )}
                    <th className="px-5 py-3 text-left">{tx("Product")}</th>
                    <th className="px-5 py-3 text-right">
                      {tx("Sum Assured")}
                    </th>
                    <th className="px-5 py-3 text-left">{tx("Status")}</th>
                    {tab === "queue" && (
                      <th className="px-5 py-3 text-left w-56">
                        {tx("Stage")}
                      </th>
                    )}
                    {tab === "active" && (
                      <th className="px-5 py-3 text-left">{tx("Expiry")}</th>
                    )}
                    <th className="px-5 py-3 text-right">{tx("Action")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {pagedPolicies.map((p) => (
                    <tr
                      key={p.id}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                      onClick={() => setViewPolicy(p)}
                    >
                      <td className="px-5 py-3">
                        <div>
                          <p className="font-semibold text-slate-800 text-xs">
                            {p.customer_name}
                          </p>
                          {tab === "queue" && (
                            <p className="text-[10px] text-slate-400 mt-0.5">
                              {p.term_years}
                              {tx("yr term")}
                            </p>
                          )}
                        </div>
                      </td>
                      {tab === "queue" && (
                        <td className="px-5 py-3">
                          {p.case_number ? (
                            <p className="font-mono text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded font-semibold inline-block">
                              {p.case_number}
                            </p>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      )}
                      {tab === "active" && (
                        <td className="px-5 py-3">
                          <p className="font-mono text-[10px] text-blue-700 font-bold inline-block">
                            {p.policy_number ?? "—"}
                          </p>
                        </td>
                      )}
                      <td className="px-5 py-3 text-xs text-slate-600">
                        {p.product_name}
                      </td>
                      <td className="px-5 py-3 text-right font-semibold text-slate-700 text-xs">
                        {fmtCoverage(p.coverage_amount)}
                      </td>
                      <td className="px-5 py-3">
                        {(() => {
                          // Money in, cover not yet bound: say so, instead of "pending payment".
                          const paidAwaitingActivation = isPendingPayment(p.status) && (p.initial_premium_received ?? 0) > 0;
                          return (
                            <>
                              <span
                                className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${paidAwaitingActivation ? "bg-emerald-50 text-emerald-700 border-emerald-200" : (STATUS_BADGE[(p.status || "").toUpperCase()] ?? "bg-slate-100 text-slate-600 border-slate-200")}`}
                              >
                                {paidAwaitingActivation
                                  ? tx("Payment received")
                                  : p.status === "Approved" || p.status === "AcceptedWithLoadings"
                                    ? tx("Pending Issuance")
                                    : isPendingPayment(p.status) ? tx("Pending Payment") : p.status}
                              </span>
                              {paidAwaitingActivation && (
                                <p className="mt-0.5 text-[10px] text-slate-500">{tx("{0} collected · ready to activate", { 0: fmtPKR(p.initial_premium_received ?? 0) })}</p>
                              )}
                            </>
                          );
                        })()}
                      </td>
                      {tab === "queue" && (
                        <td className="px-5 py-3">
                          <div className="max-w-[190px]">
                            <LifecycleStepper status={p.status} compact />
                          </div>
                        </td>
                      )}
                      {tab === "active" && (
                        <td className="px-5 py-3 text-xs text-slate-500">
                          {displayDate(p.expiry_date ?? "—")}
                        </td>
                      )}
                      <td className="px-5 py-3 text-right">
                        {tab === "queue" ? (
                          (p.status || "")
                            .toUpperCase()
                            .replace(/[^A-Z]/g, "") === "PENDINGPAYMENT" ? (
                            <button
                              disabled={userRole === "Agent"}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (userRole === "Agent") return;
                                setPaymentPolicy(p);
                              }}
                              title={
                                userRole === "Agent"
                                  ? tx(
                                      "Currently, you have no access to do this, ask your manager",
                                    )
                                  : undefined
                              }
                              className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white rounded-lg shadow-sm whitespace-nowrap transition-all ${
                                userRole === "Agent"
                                  ? "bg-slate-400 opacity-50 cursor-not-allowed"
                                  : "bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 active:scale-95"
                              }`}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                className="w-3 h-3"
                              >
                                <rect
                                  x="1"
                                  y="4"
                                  width="22"
                                  height="16"
                                  rx="2"
                                />
                                <line x1="1" y1="10" x2="23" y2="10" />
                              </svg>
                              {(p.initial_premium_received ?? 0) > 0 ? tx("Activate Cover") : tx("Confirm Payment")}
                            </button>
                          ) : (
                            <button
                              disabled={userRole === "Agent"}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (userRole === "Agent") return;
                                setSelectedPolicy(p);
                              }}
                              title={
                                userRole === "Agent"
                                  ? tx(
                                      "Currently, you have no access to do this, ask your manager",
                                    )
                                  : undefined
                              }
                              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-bold shadow-sm transition-colors ${
                                userRole === "Agent"
                                  ? "bg-slate-400 opacity-50 cursor-not-allowed"
                                  : "bg-blue-600 hover:bg-blue-700"
                              }`}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                className="w-3 h-3"
                              >
                                <polygon points="5 3 19 12 5 21" />
                              </svg>
                              {tx("Issue Policy")}
                            </button>
                          )
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setViewPolicy(p);
                            }}
                            className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                          >
                            {tx("View Details")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={pagination} noun={tx("policies")} inline />
          </>
        )}
      </div>

      {/* Activation toast */}
      {activatedMsg && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-4 py-3 rounded-xl shadow-lg animate-in slide-in-from-bottom-4">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="w-4 h-4"
          >
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
          userRole={userRole}
        />
      )}
      {paymentPolicy && (
        <PaymentModal
          policy={paymentPolicy}
          onClose={() => setPaymentPolicy(null)}
          onConfirmed={handleConfirmed}
          onStale={() => load()}
          userRole={userRole}
        />
      )}
      {viewPolicy && (
        <PolicyLifecycleDrawer
          policyId={viewPolicy.id}
          fallbackName={viewPolicy.customer_name}
          onClose={() => setViewPolicy(null)}
          primaryAction={(() => {
            // Same next step as the row's action button, for the same statuses.
            const st = (viewPolicy.status || "")
              .toUpperCase()
              .replace(/[^A-Z]/g, "");
            const noAccess =
              userRole === "Agent"
                ? tx(
                    "Currently, you have no access to do this, ask your manager",
                  )
                : undefined;
            if (st === "PENDINGPAYMENT")
              return {
                label: (viewPolicy.initial_premium_received ?? 0) > 0 ? tx("Activate Cover") : tx("Confirm Payment"),
                disabled: userRole === "Agent",
                title: noAccess,
                onClick: () => {
                  setViewPolicy(null);
                  setPaymentPolicy(viewPolicy);
                },
              };
            if (st === "APPROVED" || st === "ACCEPTEDWITHLOADINGS")
              return {
                label: tx("Issue Policy"),
                disabled: userRole === "Agent",
                title: noAccess,
                icon: (
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="h-3.5 w-3.5"
                    aria-hidden
                  >
                    <polygon points="5 3 19 12 5 21" />
                  </svg>
                ),
                onClick: () => {
                  setViewPolicy(null);
                  setSelectedPolicy(viewPolicy);
                },
              };
            return undefined;
          })()}
        />
      )}
      {issuanceResult && (
        <SuccessModal
          result={issuanceResult.result}
          policyName={issuanceResult.policyName}
          onClose={() => {
            // Issued with nothing left to pay (already Active): the pre-issuance work is done too.
            const pending =
              (issuanceResult.result.status || "")
                .toUpperCase()
                .replace(/[^A-Z]/g, "") === "PENDINGPAYMENT";
            setIssuanceResult(null);
            if (!pending) goToPostIssuance();
          }}
        />
      )}
    </div>
  );
}

export default function PolicyIssuancePage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-slate-500">
          {tx("Loading Policy Issuance Hub…")}
        </div>
      }
    >
      <PolicyIssuanceContent />
    </Suspense>
  );
}
