"use client";

import { displayDate } from '../../lib/dateDisplay';
import { useEffect, useMemo, useState } from "react";
import type { SegmentFilter } from "@/components/SegmentDropdown";
import { useNotify } from "@/components/NotificationContext";
import {
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
  IssuanceResult,
  IssuancePreview,
  PaymentMethod,
  PaymentConfirmResult,
  fmtPKR,
} from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";

import { PolicyLifecycleDrawer } from "@/components/policy/PolicyLifecycleDrawer";
import { LifecycleStepper } from "@/components/policy/LifecycleStepper";
import FiltersPanel from "@/components/FiltersPanel";

const STATUS_BADGE: Record<string, string> = {
  APPROVED: "bg-blue-50 text-blue-700 ring-blue-600/15",
  ACCEPTEDWITHLOADINGS: "bg-blue-50 text-blue-700 ring-blue-600/15",
  PENDINGPAYMENT: "bg-amber-50 text-amber-800 ring-amber-600/20",
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  ISSUED: "bg-blue-50 text-blue-700 ring-blue-600/15",
  QUOTED: "bg-slate-50 text-slate-600 ring-slate-500/15",
  LAPSED: "bg-rose-50 text-rose-700 ring-rose-600/15",
  CANCELLED: "bg-rose-50 text-rose-700 ring-rose-600/15",
  POSTPONED: "bg-amber-50 text-amber-800 ring-amber-600/20",
  REINSURERREFERRED: "bg-blue-50 text-blue-700 ring-blue-600/15",
  NOTTAKENUP: "bg-slate-50 text-rose-700 ring-slate-500/15",
};

// ── Shared issuance stepper ──────────────────────────────────────────────────
const ISSUE_STEPS = ["Review", "Bind & Pay", "Policy Pack"] as const;

/** How the balance is worked out when only part of the premium was paid at the proposal: the final premium, less what was paid,
 *  with the part of the balance that is new (loading and other changes made in underwriting) named separately. */
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
  // Only part may have been paid at the proposal (the split rule): then the rest is collected after issuing.
  const partialPrepaid = !!prepaid && (prepaid.remaining_due ?? 0) > 0;
  const fullyPrepaid = !!prepaid && !partialPrepaid;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header + stepper */}
        <div className="shrink-0 bg-blue-600 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-white text-lg font-bold">
              {tx("Issue Policy")}
            </h2>
            <div className="mt-2">
              <IssueStepper current={0} prepaid={fullyPrepaid} />
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
              <div className="space-y-6">
              <div className="space-y-6">
              {/* Insured */}
              <div>
                <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
                  {tx("Insured")}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-slate-50 rounded-xl p-5">
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
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-5 bg-slate-50 rounded-xl p-5">
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

              <div>
              <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
                {tx("Payment")}
              </p>
              {partialPrepaid ? (
                <div className="space-y-3">
                  <PartPaymentSummary paid={prepaid!.amount ?? 0} pct={prepaid!.split?.upfront_pct} quotedTotal={prepaid!.split?.total ?? 0}
                    plannedRemaining={prepaid!.split?.remaining_amount ?? 0} finalTotal={pb?.total_premium ?? ((prepaid!.amount ?? 0) + (prepaid!.remaining_due ?? 0))} />
                  <ol className="list-decimal space-y-0.5 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 ps-8 text-xs text-slate-600">
                    <li>{tx("Press “Issue & bind” — the policy number is created.")}</li>
                    <li>{tx("Pay the balance shown above.")}</li>
                    <li>{tx("Cover starts as soon as the balance is paid.")}</li>
                  </ol>
                </div>
              ) : prepaid ? (
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
              </div>
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

              </div>
              <div className="space-y-6">
              {/* Premium breakdown: only when nothing has been collected yet. A premium already received (before underwriting) is
                  shown in the payment box below, with its breakdown on the receipt, so it is not repeated here. */}
              {pb && !fullyPrepaid && (
                <div>
                  <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">
                    {tx("Premium breakdown")}
                  </p>
                  <div className="rounded-xl border border-slate-200 divide-y divide-slate-50">
                    {(preview!.split_pricing
                      // Part was paid at the proposal: policy fee, stamp duty and sales tax are already inside the quoted premium,
                      // so issuing shows that premium and the loading added now — nothing is charged twice.
                      ? [
                          ["Premium quoted at the proposal (policy fee, stamp duty and sales tax included)", preview!.split_pricing.quoted_total],
                          ["Loading added by underwriting", preview!.split_pricing.loading],
                        ]
                      : [
                          ["Base premium", pb.base_premium],
                          ["Loading", pb.loading_amount],
                          ["Policy fee", pb.policy_fee],
                          ["Stamp duty", pb.stamp_duty_amount ?? 0],
                          ["Sales tax", pb.tax_amount],
                        ]
                    ).map(([l, v]) => (
                      <div
                        key={l as string}
                        className="flex justify-between px-4 py-2"
                      >
                        <span className="text-xs text-slate-600">{tx(l as string)}</span>
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

              </div>
              </div>
            </>
          )}

          {error && !loadingPreview && preview && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer actions */}
        <div className="shrink-0 border-t border-slate-100 bg-white px-8 py-4 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors"
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
            className="min-w-56 px-6 py-2.5 text-sm font-bold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm"
          >
            {issuing ? tx("Binding…") : fullyPrepaid ? tx("Issue & activate →") : tx("Issue & bind →")}
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
        <div className="px-6 py-5 bg-blue-600">
          <div className="flex justify-center mb-3">
            <IssueStepper current={1} prepaid={((result as any).initial_premium_credited ?? 0) > 0 && !((result as any).amount_due > 0)} />
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
            className="w-full mt-1 px-4 py-2.5 text-sm font-bold text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-all shadow-sm"
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

/** What the list shows as a policy's status: Approved and AcceptedWithLoadings both read
 *  "Pending Issuance", so they are one filter pill, not two. */
const statusKey = (status: string | null | undefined) => {
  const st = (status || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (st === "APPROVED" || st === "ACCEPTEDWITHLOADINGS") return "PENDINGISSUANCE";
  return st || "UNKNOWN";
};

const STATUS_KEY_LABEL: Record<string, string> = {
  PENDINGISSUANCE: "Pending Issuance",
  PENDINGPAYMENT: "Pending Payment",
  COUNTEROFFER: "Counter Offer",
  ISSUED: "Issued",
  ACTIVE: "Active",
  LAPSED: "Lapsed",
  CANCELLED: "Cancelled",
  GRACEPERIOD: "Grace Period",
  MATURED: "Matured",
  SURRENDERED: "Surrendered",
  TERMINATED: "Terminated",
  EXPIRED: "Expired",
  REINSTATED: "Reinstated",
  PAIDUP: "Paid Up",
};

const STATUS_KEY_DOT: Record<string, string> = {
  PENDINGISSUANCE: "bg-blue-500",
  PENDINGPAYMENT: "bg-amber-400",
  COUNTEROFFER: "bg-amber-400",
  ISSUED: "bg-blue-500",
  ACTIVE: "bg-emerald-500",
  LAPSED: "bg-rose-500",
  CANCELLED: "bg-rose-500",
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "?";

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

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Pagination, usePagination } from "@/components/Pagination";
import { tx } from "@/lib/i18n/tx";
import { useNewArrivals, floatNew, recentIds, NewArrivalsBanner, NEW_ARRIVAL_CLASS, scrollToFirstNew } from "@/lib/useNewArrivals";

function PolicyIssuanceContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Both legacy queue URLs now open the same policy list.
  useEffect(() => {
    if (searchParams.has("tab")) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("tab");
      router.replace(`/policy-issuance${params.size ? `?${params}` : ""}`, { scroll: false });
    }
  }, [router, searchParams]);

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
    policyId: string;
  } | null>(null);
  const [activatedMsg, setActivatedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      setPolicies(await listPolicies());
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

  const managedPolicies = useMemo(() => {
    const readyIds = new Set(queue.map((p) => p.id));
    return policies.filter((p) => readyIds.has(p.id) || p.policy_number || [
      "ACTIVE", "GRACEPERIOD", "LAPSED", "CANCELLED", "MATURED", "SURRENDERED",
      "TERMINATED", "EXPIRED", "REINSTATED", "PAIDUP",
    ].includes((p.status || "").toUpperCase().replace(/[^A-Z]/g, "")));
  }, [policies, queue]);

  // Only policies this page actually lists can be new. A policy is "new" when it reaches this page and again each time it moves to its next stage (issuance, payment, in force).
  const arrivalKey = (p: PolicyListItem) => `${p.id}|${statusKey(p.status)}`;
  const arrivalIds = useMemo(() => managedPolicies.map(arrivalKey), [managedPolicies]);
  const arrivals = useNewArrivals("policy-issuance", arrivalIds, !loading, recentIds(managedPolicies, arrivalKey, (p) => p.updated_at));

  const clearFilters = () => {
    setDateFrom("");
    setDateTo("");
  };

  const structuredFilterCount = [dateFrom || dateTo].filter(Boolean).length;


  // Queue + segment + dates + search — everything but the status pill, so each pill can show its count.
  const scoped = useMemo(() => {
    // Newest first across every policy status.
    let list = [...managedPolicies].sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
    );
    list = floatNew(list, arrivalKey, arrivals.newIds);   // the policy that just arrived sits at the top
    if (segment !== "all") {
      list = list.filter((p) => p.segment === segment);
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
        (p.case_number ?? "").toLowerCase().includes(q) ||
        p.product_name.toLowerCase().includes(q),
    );
  }, [managedPolicies, search, segment, dateFrom, dateTo, arrivals.newIds]);

  const statusPills = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of scoped) counts.set(statusKey(p.status), (counts.get(statusKey(p.status)) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [scoped]);

  const filtered = useMemo(
    () => (filterStatus === "ALL" ? scoped : scoped.filter((p) => statusKey(p.status) === filterStatus)),
    [scoped, filterStatus],
  );

  const { pageItems: pagedPolicies, pagination } = usePagination(
    filtered,
    12,
    `${segment}:${filterStatus}:${search}:${dateFrom}:${dateTo}`,
  );

  // "Show" on the new-policy banner: clear anything that hides the policy, go to its page, then scroll to it.
  const [revealPending, setRevealPending] = useState(false);
  const revealNew = () => {
    const idx = filtered.findIndex((p) => arrivals.newIds.has(arrivalKey(p)));
    if (idx >= 0) { pagination.setPage(Math.floor(idx / 12) + 1); scrollToFirstNew(); return; }
    setSearch(""); setSegment("all"); setFilterStatus("ALL"); setDateFrom(""); setDateTo("");
    setRevealPending(true);
  };
  useEffect(() => {
    if (!revealPending) return;
    const idx = filtered.findIndex((p) => arrivals.newIds.has(arrivalKey(p)));
    if (idx >= 0) { pagination.setPage(Math.floor(idx / 12) + 1); scrollToFirstNew(); }
    setRevealPending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPending, filtered]);

  const segmentCounts = useMemo(() => {
    const list = managedPolicies;
    return {
      all: list.length,
      individual: list.filter((p) => p.segment === "individual").length,
      organization: list.filter((p) => p.segment === "organization").length,
      family: list.filter((p) => p.segment === "family").length,
    };
  }, [managedPolicies]);

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
    setIssuanceResult({ result, policyName: pol?.customer_name ?? "Policy", policyId });
    load();
  };

  const showAllPolicies = () => setFilterStatus("ALL");

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
    showAllPolicies();
    setTimeout(() => setActivatedMsg(null), 6000);
  };

  return (
    <div className="px-6 py-5 space-y-4 max-w-screen-2xl mx-auto w-full">
      <NewArrivalsBanner count={arrivals.newIds.size} noun="policy" onShow={revealNew} onDismiss={arrivals.markAllSeen} />
      {/* Header — same shape as the Leads page; the title follows the queue */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            {tx("Policies")}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {tx("Issue, activate and manage policies in one place. Filter by status to find the next action.")}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 self-start px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          {tx("Refresh")}
        </button>
      </div>

      {errorMsg && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg border border-red-200">
          <p className="font-bold">{tx("Error loading data:")}</p>
          <p>{errorMsg}</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/* Toolbar: segment tabs with counts, search, date filters — every control 42px tall */}
        <div className="flex flex-wrap items-center gap-3 w-full">
          <div className="inline-flex h-[42px] items-stretch bg-white p-1 rounded-xl shadow-sm border border-slate-200 shrink-0">
            {([["all", "All"], ["individual", "Individual"], ["family", "Family"], ["organization", "Corporate"]] as [SegmentFilter, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setSegment(value)}
                className={`inline-flex items-center gap-2 px-3.5 rounded-lg text-sm font-semibold transition-colors ${segment === value
                  ? "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  }`}
              >
                {tx(label)}
                <span className={`min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${segment === value ? "bg-white text-blue-700 ring-1 ring-inset ring-blue-100" : "bg-slate-100 text-slate-500"}`}>
                  {loading ? "—" : segmentCounts[value as keyof typeof segmentCounts] ?? 0}
                </span>
              </button>
            ))}
          </div>

          <div className="relative w-full max-w-[320px] shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              type="text"
              placeholder={tx("Search customer, policy, application or product…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-[42px] pl-9 pr-8 text-sm border border-slate-200 rounded-xl bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-shadow"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                ✕
              </button>
            )}
          </div>

          <div className="shrink-0">
            <FiltersPanel
              dateFrom={dateFrom}
              dateTo={dateTo}
              onDateFromChange={setDateFrom}
              onDateToChange={setDateTo}
              activeCount={structuredFilterCount}
              onClearAll={clearFilters}
            />
          </div>
        </div>

        {/* Status: quiet pills from what's in this queue; the old KPI cards as one line on the right */}
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={tx("Status")}>
          {[["ALL", scoped.length] as [string, number], ...statusPills].map(([key, count]) => {
            const on = filterStatus === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilterStatus(key)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {key !== "ALL" && <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-white" : STATUS_KEY_DOT[key] ?? "bg-slate-400"}`} />}
                {key === "ALL" ? tx("All") : tx(STATUS_KEY_LABEL[key] ?? key.charAt(0) + key.slice(1).toLowerCase())}
                <span className={`tabular-nums ${on ? "text-slate-300" : "text-slate-400"}`}>{loading ? "—" : count}</span>
              </button>
            );
          })}
          {!loading && (
            <div className="ml-auto flex items-center gap-4 text-xs text-slate-500">
              {[[tx("Pending issuance"), managedPolicies.filter((p) => statusKey(p.status) === "PENDINGISSUANCE").length], [tx("Pending payment"), pendingPaymentCount], [tx("Active"), managedPolicies.filter((p) => statusKey(p.status) === "ACTIVE").length], [tx("Lapsed"), managedPolicies.filter((p) => statusKey(p.status) === "LAPSED").length]].map(([label, value]) => (
                <span key={String(label)} className="whitespace-nowrap">
                  {label} <span className="font-semibold text-slate-800 tabular-nums">{value ?? "—"}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 flex justify-center">
            <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-20 flex flex-col items-center text-center px-6">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-slate-400">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {managedPolicies.length > 0 ? tx("No policies match your search and filters") : tx("No policies yet")}
            </p>
            <p className="text-xs text-slate-400 mt-1 max-w-xs">
              {managedPolicies.length > 0 ? tx("Try a different segment, status or search.") : tx("Approved applications and issued policies will appear here.")}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left whitespace-nowrap">
                <thead className="bg-white border-b border-slate-200">
                  <tr className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    <th className="pl-6 pr-4 py-3">{tx("Customer")}</th>
                    <th className="px-4 py-3">{tx("Policy / Application")}</th>
                    <th className="px-4 py-3">{tx("Product")}</th>
                    <th className="px-4 py-3 text-right">{tx("Sum Assured")}</th>
                    <th className="px-4 py-3">{tx("Status")}</th>
                    <th className="px-4 py-3 w-56">{tx("Stage")}</th>
                    <th className="px-4 py-3">{tx("Expiry")}</th>
                    <th className="pl-4 pr-6 py-3 text-right"><span className="sr-only">{tx("Action")}</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pagedPolicies.map((p) => {
                    // Money in, cover not yet bound: say so, instead of "pending payment".
                    const paidAwaitingActivation = isPendingPayment(p.status) && (p.initial_premium_received ?? 0) > 0 && !((p.initial_premium_balance ?? 0) > 0);
                    const noAccess = userRole === "Agent";
                    const noAccessTitle = noAccess ? tx("Currently, you have no access to do this, ask your manager") : undefined;
                    return (
                      <tr
                        key={p.id}
                        className={`group hover:bg-slate-50/70 transition-colors cursor-pointer ${arrivals.newIds.has(arrivalKey(p)) ? NEW_ARRIVAL_CLASS : ""}`}
                        onClick={() => { arrivals.markSeen(arrivalKey(p)); setViewPolicy(p); }}
                      >
                        <td className="pl-6 pr-4 py-3.5">
                          <div className="flex items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-100">
                              {initials(p.customer_name)}
                            </span>
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">{p.customer_name}</div>
                              <div className="text-[11px] text-slate-400 mt-0.5">{tx("{0}-year term", { 0: p.term_years })}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 font-mono text-xs text-slate-500">
                          <div>{p.policy_number || tx("Not yet issued")}</div>
                          {p.case_number && <div className="mt-1 text-[11px] text-slate-400">{p.case_number.replace(/^CASE-/, "APP-")}</div>}
                        </td>
                        <td className="px-4 py-3.5 text-[13px] text-slate-600">{p.product_name}</td>
                        <td className="px-4 py-3.5 text-right text-[13px] font-semibold text-slate-900 tabular-nums">{fmtCoverage(p.coverage_amount)}</td>
                        <td className="px-4 py-3.5">
                          <span
                            className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${paidAwaitingActivation ? "bg-emerald-50 text-emerald-700 ring-emerald-600/15" : (STATUS_BADGE[(p.status || "").toUpperCase().replace(/[^A-Z]/g, "")] ?? "bg-slate-50 text-slate-600 ring-slate-500/15")}`}
                          >
                            {paidAwaitingActivation
                              ? tx("Payment received")
                              : p.status === "Approved" || p.status === "AcceptedWithLoadings"
                                ? tx("Pending Issuance")
                                : isPendingPayment(p.status) ? tx("Pending Payment") : p.status}
                          </span>
                          {isPendingPayment(p.status) && (p.initial_premium_balance ?? 0) > 0 && (
                            <p className="mt-1 text-[11px] text-amber-700">{tx("{0} paid · {1} balance due", { 0: fmtPKR(p.initial_premium_received ?? 0), 1: fmtPKR(p.initial_premium_balance ?? 0) })}</p>
                          )}
                          {paidAwaitingActivation && (
                            <p className="mt-1 text-[11px] text-slate-500">{tx("{0} collected · ready to activate", { 0: fmtPKR(p.initial_premium_received ?? 0) })}</p>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {["PENDINGISSUANCE", "PENDINGPAYMENT", "ISSUED", "COUNTEROFFER"].includes(statusKey(p.status))
                            ? <div className="max-w-[190px]"><LifecycleStepper status={p.status} compact /></div>
                            : <span className="text-xs text-slate-500">{tx("Policy servicing")}</span>}
                        </td>
                        <td className="px-4 py-3.5 text-xs text-slate-500">{p.expiry_date ? displayDate(p.expiry_date) : "—"}</td>
                        <td className="pl-4 pr-6 py-3.5 text-right">
                          {["APPROVED", "ACCEPTEDWITHLOADINGS", "PENDINGPAYMENT"].includes((p.status || "").toUpperCase().replace(/[^A-Z]/g, "")) ? (
                            <button
                              disabled={noAccess}
                              title={noAccessTitle}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (noAccess) return;
                                if (isPendingPayment(p.status)) setPaymentPolicy(p);
                                else setSelectedPolicy(p);
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 shadow-sm transition-colors hover:bg-blue-700 active:scale-95 disabled:bg-slate-300 disabled:cursor-not-allowed disabled:active:scale-100"
                            >
                              {isPendingPayment(p.status) ? (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3"><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>
                              ) : (
                                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><polygon points="5 3 19 12 5 21" /></svg>
                              )}
                              {isPendingPayment(p.status)
                                ? paidAwaitingActivation ? tx("Activate Cover") : tx("Confirm Payment")
                                : tx("Issue Policy")}
                            </button>
                          ) : (
                            <button
                              type="button"
                              title={tx("View Details")}
                              onClick={(e) => { e.stopPropagation(); arrivals.markSeen(arrivalKey(p)); setViewPolicy(p); }}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors group-hover:text-blue-600 hover:bg-white hover:ring-1 hover:ring-slate-200"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><polyline points="9 18 15 12 9 6" /></svg>
                              <span className="sr-only">{tx("View Details")}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
                label: (viewPolicy.initial_premium_received ?? 0) > 0 && !((viewPolicy.initial_premium_balance ?? 0) > 0) ? tx("Activate Cover") : tx("Confirm Payment"),
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
            const issuedId = issuanceResult.policyId;
            setIssuanceResult(null);
            if (!pending) { showAllPolicies(); return; }
            // "Continue to payment": open Confirm Payment straight away on the freshly issued policy.
            void (async () => {
              try {
                const fresh = await listPolicies();
                setPolicies(fresh);
                const issued = fresh.find((p) => p.id === issuedId);
                if (issued) setPaymentPolicy(issued);
              } catch { /* the list refresh below still runs */ }
            })();
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
          {tx("Loading policies…")}
        </div>
      }
    >
      <PolicyIssuanceContent />
    </Suspense>
  );
}
