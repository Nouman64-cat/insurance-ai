"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useRouter } from "next/navigation";
import { useNotify } from "@/components/NotificationContext";

import { getPolicyDetail, getPolicyEvents, fmtPKR, downloadDocument, getIssuancePreview, type PolicyDetail, type PolicyDocument, type PolicyEvent, type IssuancePreview } from "@/app/services/policies";
import {
  getFreeLookStatus, cancelWithinFreeLook, sendIssuanceEmail,
  getOnboarding, assignPolicyholderId, generateWelcomeKit, welcomeKitDownloadUrl,
  provisionPortal, sendWelcome, acknowledgeOnboarding, setOnboardingContact, resetOnboarding,
  getBilling, collectInstallment, bulkCollectInstallments, remindInstallment, waiveInstallment, runBillingMonitor, setAutopay, demoSeedPremiums,
  restructurePlan, getReminderHistory, downloadReceipt, downloadLapseWarning,
  getEndorsements, endorseNominees, endorseAddress, endorseSumAssured, endorseRider, endorsementDocUrl,
  getEndorsementQuote, endorseContact, emailEndorsement,
  REMINDER_CHANNELS, REMINDER_TEMPLATES, BILLING_FREQUENCIES,
  type ReminderLog,
  type FreeLookStatus, type OnboardingStatus, type PortalCredentials,
  type BillingLedger, type Installment, type EndorsementsOverview, type EndorsementQuote,
} from "@/app/services/postIssuance";
import { fmtCoverage } from "@/lib/mock-data";

// ─────────────────────────────────────────────────────────────────────────────
// Stage B roadmap — the canonical post-issuance journey. `live` steps are wired;
// the rest render a clean "coming soon" panel. Adding a future step = flip `live`
// and drop its panel into the switch in <StepPanel>.
// ─────────────────────────────────────────────────────────────────────────────

type StepId =
  | "free-look" | "onboarding" | "premiums" | "endorsements"
  | "servicing" | "reinstatement" | "renewals" | "claims" | "exit";

interface StageBStep {
  id: StepId;
  n: number;
  title: string;
  blurb: string;
  live: boolean;
}

const STAGE_B_STEPS: StageBStep[] = [
  { id: "free-look", n: 1, title: "Deliver Policy & Free-Look", blurb: "Documents delivered; 14-day cancel-for-refund window.", live: true },
  { id: "onboarding", n: 2, title: "Welcome & Onboarding", blurb: "Welcome kit, portal login, policyholder ID.", live: true },
  { id: "premiums", n: 3, title: "Premium Collection Status", blurb: "Reminders, collection, grace-period monitoring.", live: true },
  { id: "endorsements", n: 4, title: "Policy Issuance", blurb: "Issuance record, contract dates & the policy document pack.", live: true },
  { id: "servicing", n: 5, title: "Policy Servicing & Endorsements", blurb: "Nominee, address, sum-assured & rider changes.", live: true },
  { id: "reinstatement", n: 6, title: "Reinstatement", blurb: "Revive a lapsed policy after arrears + underwriting.", live: false },
  { id: "renewals", n: 7, title: "Renewals", blurb: "Annual renewal via STP or manual referral.", live: false },
  { id: "claims", n: 8, title: "Claims Management", blurb: "Death, health and reimbursement claims.", live: false },
  { id: "exit", n: 9, title: "Policy Maturity & Exit", blurb: "Maturity, surrender or death-benefit payout.", live: false },
];

const STATUS_TONE: Record<string, string> = {
  Active: "bg-blue-50 text-blue-700 border-blue-200",
  GracePeriod: "bg-amber-50 text-amber-700 border-amber-200",
  Lapsed: "bg-red-50 text-red-700 border-red-200",
  Cancelled: "bg-slate-100 text-slate-600 border-slate-300",
};

// ── Live countdown ───────────────────────────────────────────────────────────
// Free-look end is a calendar date; the window closes at end-of-day. Ticks every
// second so the UI reads as genuinely live.

interface Remaining { total: number; days: number; hours: number; mins: number; secs: number; }

function useCountdown(endDate: string | null): Remaining | null {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!endDate) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endDate]);

  return useMemo(() => {
    if (!endDate) return null;
    const end = new Date(`${endDate}T23:59:59`).getTime();
    const total = Math.max(0, end - now);
    return {
      total,
      days: Math.floor(total / 86_400_000),
      hours: Math.floor((total / 3_600_000) % 24),
      mins: Math.floor((total / 60_000) % 60),
      secs: Math.floor((total / 1000) % 60),
    };
  }, [endDate, now]);
}

// ── Small presentational helpers ─────────────────────────────────────────────

function Badge({ status }: Readonly<{ status: string }>) {
  return (
    <span className={`inline-flex px-3 py-1 rounded-full text-xs font-semibold border ${STATUS_TONE[status] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
      {status}
    </span>
  );
}

function StatCard({ label, value, hint, accent }: Readonly<{ label: string; value: string; hint?: string; accent?: boolean }>) {
  return (
    <div className={`group relative overflow-hidden rounded-2xl border p-6 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 ${accent
      ? "border-blue-200 bg-gradient-to-br from-blue-50 to-white shadow-blue-100/40"
      : "border-slate-200 bg-white shadow-sm hover:border-blue-300"
      }`}>
      <div className={`absolute top-0 left-0 w-full h-1 transition-all duration-300 ${accent ? "bg-blue-400" : "bg-transparent group-hover:bg-blue-400"}`}></div>
      <p className={`text-[11px] uppercase tracking-widest font-bold mb-2 transition-colors duration-300 ${accent ? "text-blue-600" : "text-slate-400 group-hover:text-blue-600"
        }`}>{label}</p>
      <p className={`text-2xl font-black tracking-tight ${accent ? "text-blue-900" : "text-slate-800"
        }`}>{value}</p>
      {hint && <p className="text-[12px] font-medium text-slate-500 mt-2">{hint}</p>}
    </div>
  );
}

function CountdownUnit({ value, label }: Readonly<{ value: number; label: string }>) {
  return (
    <div className="flex flex-col items-center">
      <span className="tabular-nums text-3xl font-bold text-blue-700 bg-white border border-blue-200 rounded-xl w-16 py-2 text-center shadow-sm">
        {String(value).padStart(2, "0")}
      </span>
      <span className="text-[10px] uppercase tracking-wider font-semibold text-blue-600/70 mt-1.5">{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const PAY_CHANNELS = ["JazzCash", "Easypaisa", "Card", "BankTransfer", "Manual (offline)"];

const STATE_CHIP: Record<string, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  waived: { label: "Waived", cls: "bg-slate-100 text-slate-500 border-slate-200" },
  upcoming: { label: "Upcoming", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  due_soon: { label: "Due soon", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  due_today: { label: "Due today", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  grace: { label: "Overdue · grace", cls: "bg-orange-50 text-orange-700 border-orange-200" },
  past_grace: { label: "Past grace", cls: "bg-red-50 text-red-700 border-red-200" },
};

function Field({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">{label}</p>
      <p className="text-sm font-semibold text-slate-800 mt-0.5">{value}</p>
    </div>
  );
}

function getPaymentMethodName(method?: string, ref?: string) {
  if (method && method.toLowerCase() !== "unknown") return method;
  if (!ref) return "—";
  const refUpper = ref.toUpperCase();
  if (refUpper.startsWith("JC-") || refUpper.startsWith("DEMO-")) return "JazzCash";
  if (refUpper.startsWith("EP-")) return "EasyPaisa";
  if (refUpper.startsWith("CC-") || refUpper.startsWith("CARD-")) return "Credit/Debit Card";
  if (refUpper.startsWith("BT-") || refUpper.startsWith("BANK-")) return "Bank Transfer";
  return ref;
}

function CustomPaymentModal({
  isOpen, onClose, onSubmit, isBusy, maxAmount
}: {
  isOpen: boolean; onClose: () => void; onSubmit: (amount: number, method: string) => void; isBusy: boolean; maxAmount: number;
}) {
  const [amountStr, setAmountStr] = useState<string>("");
  const [method, setMethod] = useState<string>("JazzCash");
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (isOpen) {
      setAmountStr("");
      setMethod("JazzCash");
      setFile(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const raw = val.replace(/,/g, '');
    if (!isNaN(Number(raw)) || raw === '') {
      setAmountStr(raw);
    }
  };

  const displayValue = amountStr && !amountStr.includes('.') ? Number(amountStr).toLocaleString('en-US') : amountStr;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(amountStr);
    if (!isNaN(amount) && amount > 0) {
      onSubmit(amount, method);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden border border-slate-100 animate-in slide-in-from-bottom-4">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4 bg-slate-50/50">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Post Dated Amount</h2>
            <p className="text-xs text-slate-500 mt-0.5">Pay a lump sum across upcoming installments</p>
          </div>
          <button onClick={onClose} disabled={isBusy} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors disabled:opacity-50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <div className="mb-4">
            <label className="block text-sm font-semibold text-slate-700 mb-2">Payment Amount (PKR)</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 font-semibold text-slate-400">Rs</span>
              <input
                type="text"
                value={displayValue}
                onChange={handleAmountChange}
                placeholder="0.00"
                required
                disabled={isBusy}
                className="w-full rounded-xl border border-slate-200 pl-10 pr-4 py-3 text-lg font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm transition-all disabled:opacity-50"
              />
            </div>
            <p className="text-xs text-slate-500 mt-2 flex items-start gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-blue-500 shrink-0"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></svg>
              This amount will be applied chronologically to your pending/overdue installments.
            </p>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-semibold text-slate-700 mb-2">Payment Channel</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={isBusy}
              className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm disabled:opacity-50"
            >
              <option value="JazzCash">JazzCash</option>
              <option value="Easypaisa">Easypaisa</option>
              <option value="Card">Credit/Debit Card</option>
              <option value="BankTransfer">Bank Transfer</option>
              <option value="Manual (offline)">Manual - Cash/Cheque</option>
            </select>
          </div>

          <div className="mb-6">
            <label className="block text-sm font-semibold text-slate-700 mb-2">Payment Receipt (Optional)</label>
            <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-slate-200 border-dashed rounded-xl hover:bg-slate-50 transition-colors">
              <div className="space-y-1 text-center">
                <svg className="mx-auto h-10 w-10 text-slate-400" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
                  <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div className="flex text-sm text-slate-600 justify-center">
                  <label htmlFor="file-upload" className="relative cursor-pointer rounded-md font-medium text-blue-600 hover:text-blue-500 focus-within:outline-none px-1">
                    <span className="truncate max-w-[150px] inline-block">{file ? file.name : "Upload a file"}</span>
                    <input id="file-upload" name="file-upload" type="file" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] || null)} accept="image/*,.pdf" disabled={isBusy} />
                  </label>
                  {!file && <p className="pl-1">or drag and drop</p>}
                </div>
                {!file && <p className="text-xs text-slate-500">PNG, JPG, PDF up to 10MB</p>}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} disabled={isBusy} className="px-5 py-2.5 rounded-xl text-sm font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={isBusy || !amountStr || parseFloat(amountStr) <= 0} className="px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-blue-600 hover:from-blue-700 hover:to-blue-700 shadow-sm transition-all disabled:opacity-50 flex items-center gap-2">
              {isBusy && <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>}
              Process Payment
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

function PremiumCollectionPanel({
  policyId, billing, onChanged,
}: Readonly<{ policyId: string; billing: BillingLedger | null; onChanged: () => Promise<void> }>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { notify } = useNotify();
  const [channel, setChannel] = useState("JazzCash");
  const [remChannel, setRemChannel] = useState<string>(REMINDER_CHANNELS[0]);
  const [remTemplate, setRemTemplate] = useState<string>(REMINDER_TEMPLATES[1]);
  const getActiveFreq = () => {
    if (!billing || billing.installments.length === 0) return "Quarterly";
    const pending = billing.installments.find(s => s.state !== "paid" && s.state !== "waived");
    return (pending || billing.installments[billing.installments.length - 1]).billing_frequency;
  };
  const [freq, setFreq] = useState<string>(() => getActiveFreq());
  const currentFreq = getActiveFreq();
  const [reminders, setReminders] = useState<ReminderLog[] | null>(null);
  const [openSecs, setOpenSecs] = useState<Set<string>>(() => new Set(["first-premium", "recurring-plan", "controls", "ledger"]));
  const [preview, setPreview] = useState<IssuancePreview | null>(null);
  const [viewMode, setViewMode] = useState<"tabular" | "list">("tabular");
  const [selectedInstallment, setSelectedInstallment] = useState<any | null>(null);
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getIssuancePreview(policyId).then(p => { if (alive) setPreview(p); }).catch(console.error);
    return () => { alive = false; };
  }, [policyId]);

  useEffect(() => {
    if (billing && billing.installments.length > 0) {
      const actualFreq = billing.installments.find(s => s.installment_no === 1)?.billing_frequency;
      if (actualFreq) setFreq(actualFreq);
    }
  }, [billing]);

  const sec = (k: string) => openSecs.has(k);
  const toggleSec = (k: string) => setOpenSecs((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const graceCd = useCountdown(billing?.summary.in_grace ? billing.summary.grace_until : null);

  if (!billing) {
    return <p className="text-xs text-slate-400 italic">Billing data unavailable for this policy.</p>;
  }

  const locked = busy || !billing.can_collect;
  const sum = billing.summary;
  const dash = billing.dashboard;
  const rows = billing.installments;

  // Every action shows a plain-language result so each control's effect is visible.
  const run = async (fn: () => Promise<any>, note?: string | ((r: any) => string)) => {
    setBusy(true); setErr(null);
    try {
      const result = await fn();
      await onChanged();
      if (openSecs.has("reminders")) setReminders(await getReminderHistory(policyId));
      if (note) notify(typeof note === "function" ? note(result) : note, true);
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "Action failed";
      setErr(msg);
      notify(msg, false);
    }
    finally { setBusy(false); }
  };

  const collect = (id: string) => {
    const manual = channel.startsWith("Manual");
    return collectInstallment(policyId, id, manual ? { manual: true } : { method: channel });
  };
  const remind = (s: Installment) =>
    remindInstallment(policyId, s.id, { channel: remChannel, template: remTemplate, kind: s.state === "upcoming" || s.state === "due_soon" ? "Upcoming" : s.state === "due_today" ? "Due" : "Overdue" });

  const openReminders = async () => {
    const opening = !sec("reminders");
    toggleSec("reminders");
    if (opening && reminders === null) setReminders(await getReminderHistory(policyId).catch(() => []));
  };

  const handleBulkSubmit = (amount: number, bulkMethod: string) => {
    const manual = bulkMethod.startsWith("Manual");
    run(async () => {
      await bulkCollectInstallments(policyId, { amount, manual: manual ? true : undefined, method: manual ? undefined : bulkMethod });
      setIsBulkModalOpen(false);
    }, `Post Dated Amount of Rs ${amount.toLocaleString('en-US')} processed successfully.`);
  };

  const firstPremium = rows.find((r) => r.installment_no === 1) ?? rows[0];

  return (
    <div className="w-full space-y-5">
      {/* Lapsed / grace / lapse-due banners */}
      {billing.policy_status === "Lapsed" ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm">
          <p className="font-bold text-red-700">Policy has lapsed</p>
          <p className="text-xs text-red-600/90 mt-1 max-w-xl">
            Cover has stopped because a premium stayed unpaid past the grace period. A lapsed policy
            can only be revived through <b>Reinstatement (Step 5)</b>. Premium collection stays locked until then.
          </p>
        </div>
      ) : sum.lapse_due && billing.can_collect ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-bold text-red-700">Past grace — lapse due</p>
            <p className="text-xs text-red-600/90 mt-0.5">Arrears unpaid beyond the grace window. Run monitor to lapse, or collect/waive to save it.</p>
          </div>
          <button disabled={busy} onClick={() => run(() => downloadLapseWarning(policyId), "Lapse-warning letter generated & downloaded.")}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-red-200 text-red-700 hover:bg-red-100">Lapse warning letter</button>
        </div>
      ) : sum.in_grace && graceCd ? (
        <div className="rounded-xl border border-orange-200 bg-gradient-to-br from-orange-50 to-white px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-orange-800">In grace period</p>
              <p className="text-xs text-orange-700/80 mt-0.5">Pay arrears before the grace window closes to keep cover in force.</p>
            </div>
            <div className="flex items-end gap-2">
              {[["Days", graceCd.days], ["Hrs", graceCd.hours], ["Min", graceCd.mins]].map(([l, v]) => (
                <div key={l as string} className="flex flex-col items-center">
                  <span className="tabular-nums text-xl font-bold text-orange-700 bg-white border border-orange-200 rounded-lg w-12 py-1 text-center">{String(v).padStart(2, "0")}</span>
                  <span className="text-[9px] uppercase tracking-wider font-semibold text-orange-600/70 mt-1">{l}</span>
                </div>
              ))}
            </div>
          </div>
          <button disabled={busy} onClick={() => run(() => downloadLapseWarning(policyId), "Lapse-warning letter generated & downloaded.")}
            className="mt-3 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-orange-200 text-orange-700 hover:bg-orange-100">Issue lapse-warning letter</button>
        </div>
      ) : null}

      {!billing.can_collect && billing.policy_status !== "Lapsed" && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
          🔒 Premium collection is only available while cover is in force (policy is {billing.policy_status}).
        </div>
      )}
      {err && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>}

      {/* Collapsible sections — keep the page compact, expand what you need */}
      <JourneyAccordion title="Overview & dashboard" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>} isOpen={sec("overview")} onToggle={() => toggleSec("overview")}>
        <div className="space-y-4">
          {/* Collection dashboard */}
          <div>
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Policy Billing Overview</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Total collected" value={fmtPKR(dash.total_collected)} accent />
              <StatCard label="Next premium due" value={sum.next_due_date ?? "—"} hint={sum.next_due_amount != null ? fmtPKR(sum.next_due_amount) : undefined} />
              <StatCard label="Overdue amount" value={fmtPKR(dash.overdue_amount)} hint={`${sum.arrears_count} arrear(s)`} accent={dash.overdue_amount > 0} />
              <StatCard label="Payment frequency" value={currentFreq} hint="Billing cycle" />
            </div>
          </div>

        </div>
      </JourneyAccordion>

      <JourneyAccordion title="First Premium Collection" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} isOpen={sec("first-premium")} onToggle={() => toggleSec("first-premium")}>
        {firstPremium && (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${firstPremium.state === "paid" ? "bg-blue-600 text-white" : "bg-amber-500 text-white"}`}>{firstPremium.state === "paid" ? "✓" : "1"}</span>
                <div>
                  <p className="text-sm font-bold text-slate-800">First Premium Collection</p>
                  <p className="text-[11px] text-slate-400">Taken at policy binding — activates cover.</p>
                </div>
              </div>
              <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-semibold border ${(STATE_CHIP[firstPremium.state] ?? STATE_CHIP.upcoming).cls}`}>{firstPremium.state === "paid" ? "Collected" : (STATE_CHIP[firstPremium.state] ?? STATE_CHIP.upcoming).label}</span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mt-4">
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Due</p><p className="text-sm font-semibold text-slate-800 mt-0.5">{firstPremium.due_date}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Amount</p><p className="text-sm font-semibold text-slate-800 mt-0.5">{fmtPKR(firstPremium.amount_due)}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Collected on</p><p className="text-sm font-semibold text-slate-800 mt-0.5">{firstPremium.paid_at ? firstPremium.paid_at.slice(0, 10) : "—"}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Status</p>
                {firstPremium.paid_at ? (
                  <span className={`text-sm font-semibold mt-0.5 ${firstPremium.paid_at.slice(0, 10) > firstPremium.due_date ? "text-amber-600" : "text-blue-600"}`}>
                    {firstPremium.paid_at.slice(0, 10) > firstPremium.due_date ? "Late" : "On time"}
                  </span>
                ) : <p className="text-sm text-slate-400 mt-0.5">—</p>}
              </div>
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Method</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5">
                  {getPaymentMethodName(firstPremium.receipt?.method, firstPremium.payment_reference ?? undefined)}
                </p>
              </div>
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Receipt</p>
                <button
                  disabled
                  onClick={() => {
                    if (firstPremium.receipt) {
                      run(() => downloadReceipt(policyId, firstPremium.receipt!.id), "Receipt downloaded.");
                    } else {
                      run(async () => {
                        const blob = new Blob(["--- DEMO RECEIPT ---\nAmount Paid: " + firstPremium.amount_due + "\nDate: " + firstPremium.paid_at], { type: "text/plain" });
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "demo_receipt.txt";
                        a.click();
                        window.URL.revokeObjectURL(url);
                      }, "Demo receipt downloaded.");
                    }
                  }}
                  className="mt-1 inline-flex items-center justify-center gap-1.5 px-3 py-1 text-[11px] font-bold text-white bg-gradient-to-r from-blue-600 to-blue-600 rounded-md transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download
                </button>
              </div>
            </div>
            {firstPremium.state !== "paid" && firstPremium.state !== "waived" && (
              <button disabled={locked} onClick={() => run(() => collect(firstPremium.id), "First premium collected — receipt generated.")} className="mt-4 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">Collect first premium</button>
            )}

            {preview && (
              <div className="mt-5 space-y-5 border-t border-slate-100 pt-5">
                {/* Insured */}
                <div>
                  <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">Insured</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-50 rounded-xl p-4 border border-slate-100">
                    <Field label="Name" value={preview.insured.name} />
                    <Field label="CNIC" value={preview.insured.cnic ?? "—"} />
                    <Field label="Date of birth" value={preview.insured.dob ?? "—"} />
                    <Field label="Smoker" value={preview.insured.is_smoker ? "Yes" : "No"} />
                  </div>
                </div>

                {/* Contract terms */}
                <div>
                  <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">Contract terms</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 bg-slate-50 rounded-xl p-4 border border-slate-100">
                    <Field label="Product" value={preview.contract.product_name} />
                    <Field label="Sum assured" value={fmtCoverage(preview.contract.coverage_amount)} />
                    <Field label="Insurance Terms" value={`${preview.contract.term_years} years`} />
                    <Field label="Commencement" value={preview.contract.effective_date} />
                    <Field label="Maturity date" value={<span className="text-blue-700">{preview.contract.maturity_date}</span>} />
                    <Field label="Billing" value={preview.contract.billing_frequency} />
                  </div>
                </div>

                {/* Premium breakdown */}
                {preview.premium_breakdown && (
                  <div>
                    <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">First Installment Breakdown</p>
                    <div className="rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                      <div className="divide-y divide-slate-100 max-h-[130px] overflow-y-auto bg-white">
                        {[
                          ["Base installment premium", firstPremium.amount_due - 5150],
                          ["Management & Admin Charge", 1750],
                          ["Agent Charges", 2000],
                          ["Courier Charges", 500],
                          ["Policy Maintenance Fee", 100],
                          ["Initial Medical & Underwriting", 150],
                          ["Fund Management Fee (FMF)", 200],
                          ["Document Issuance Fee", 400],
                          ["Government Stamp Duty", 50],
                        ].map(([l, v]) => (
                          <div key={l as string} className="flex justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors">
                            <span className="text-xs font-medium text-slate-600">{l}</span>
                            <span className="text-xs font-bold text-slate-800 font-mono">{fmtPKR(v as number)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between items-center px-4 py-3 bg-blue-50/80 border-t border-blue-100">
                        <span className="text-xs font-black text-blue-900 uppercase tracking-wider">Total Collection</span>
                        <span className="text-sm font-black text-blue-700 font-mono">{fmtPKR(firstPremium.amount_due)}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </JourneyAccordion>

      <JourneyAccordion title="Recurring Installation Plan" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>} isOpen={sec("recurring-plan")} onToggle={() => toggleSec("recurring-plan")}>
        <div className="space-y-4">
          <JourneyAccordion title="Payment controls" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>} isOpen={sec("controls")} onToggle={() => toggleSec("controls")}>
            <div className="space-y-4">
              {/* Demo tools */}
              <div className="rounded-xl border border-dashed border-blue-200 bg-blue-50/40 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-blue-500">Demo</span>
                  <span className="text-[11px] text-slate-500">Rebuild the schedule to test collection & grace:</span>
                  {([["healthy", "Healthy"], ["grace", "In grace"], ["lapse", "Past grace"]] as const).map(([id, label]) => (
                    <button key={id} disabled={busy} onClick={() => run(() => demoSeedPremiums(policyId, id), (b) => `Demo schedule loaded (${label}) — ${b.summary.outstanding_count} unpaid, ${b.summary.arrears_count} overdue. Now try Collect / Remind / Run grace monitor.`)} className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-40">{label}</button>
                  ))}
                </div>
              </div>
              {/* Controls — three colour-coded, independent groups */}
              <div className="grid lg:grid-cols-3 gap-3">
                {/* Group 1 — Collection (emerald) */}
                <div className="rounded-xl border-2 border-blue-200 bg-blue-50/50 overflow-hidden">
                  <div className="flex items-center gap-2 bg-blue-100/70 px-4 py-2 border-b border-blue-200">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-blue-600"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
                    <p className="text-xs font-bold uppercase tracking-wider text-blue-700">Collection</p>
                  </div>
                  <div className="p-4">
                    <label className="block text-[11px] font-semibold text-slate-500 mb-1">Payment channel</label>
                    <select value={channel} onChange={(e) => setChannel(e.target.value)}
                      className="w-full text-xs border border-blue-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200">
                      {PAY_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <p className="text-[10px] text-blue-700/70 mt-1.5">Used when you click <b>Collect</b> on a row.</p>
                  </div>
                </div>

                {/* Group 2 — Reminders (sky) */}
                <div className="rounded-xl border-2 border-blue-200 bg-blue-50/50 overflow-hidden">
                  <div className="flex items-center gap-2 bg-blue-100/70 px-4 py-2 border-b border-blue-200">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-blue-600"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
                    <p className="text-xs font-bold uppercase tracking-wider text-blue-700">Reminders</p>
                  </div>
                  <div className="p-4">
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-[11px] font-semibold text-slate-500 mb-1">Channel</label>
                        <select value={remChannel} onChange={(e) => setRemChannel(e.target.value)}
                          className="w-full text-xs border border-blue-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200">
                          {REMINDER_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-[11px] font-semibold text-slate-500 mb-1">Tone</label>
                        <select value={remTemplate} onChange={(e) => setRemTemplate(e.target.value)}
                          className="w-full text-xs border border-blue-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200">
                          {REMINDER_TEMPLATES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    </div>
                    <p className="text-[10px] text-blue-700/70 mt-1.5">Used when you click <b>Remind</b> on a row.</p>
                  </div>
                </div>

                {/* Group 3 — Premium collection plan: self-contained Restructure */}
                <div className="rounded-xl border-2 border-blue-200 bg-blue-50/50 overflow-hidden">
                  <div className="flex items-center gap-2 bg-blue-100/70 px-4 py-2 border-b border-blue-200">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-blue-600"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                    <p className="text-xs font-bold uppercase tracking-wider text-blue-700">Premium Collection plan</p>
                  </div>
                  <div className="p-4">
                    <label className="block text-[11px] font-semibold text-slate-500 mb-1">Frequency</label>
                    <div className="flex gap-2">
                      <select value={freq} onChange={(e) => setFreq(e.target.value)}
                        className="flex-1 text-xs border border-blue-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200">
                        {BILLING_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                      <button disabled={locked}
                        onClick={() => run(() => restructurePlan(policyId, freq), (b) => `Plan restructured to ${freq} — ${b.summary.outstanding_count} upcoming installment(s).`)}
                        className="px-3 py-2 rounded-lg text-[11px] font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 whitespace-nowrap">
                        Restructure
                      </button>
                    </div>
                    <p className="text-[10px] text-blue-700/70 mt-1.5">Applies immediately to the outstanding amount.</p>
                  </div>
                </div>
              </div>
              {/* Global action — the whole-policy billing sweep, kept separate */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] text-slate-500">
                  <b>Global:</b> re-checks the whole policy against today and applies grace / lapse / revive.
                </p>
                <button disabled={busy} onClick={() => run(() => runBillingMonitor(policyId), (b) => `Grace monitor run — policy is now ${b.policy_status}.`)}
                  className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-900 text-white disabled:opacity-40">
                  Run grace monitor
                </button>
              </div>
            </div>
          </JourneyAccordion>

          <JourneyAccordion title={`${currentFreq} Installment Plan`} icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>} isOpen={sec("ledger")} onToggle={() => toggleSec("ledger")}>
            {/* View Toggle */}
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <button
                  disabled={locked}
                  onClick={() => setIsBulkModalOpen(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-600 to-blue-600 hover:from-blue-700 hover:to-blue-700 shadow-sm transition-all disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                  Post Dated Amount
                </button>
                <button
                  disabled={locked}
                  onClick={() => run(() => demoSeedPremiums(policyId, "healthy"), () => `Ledger reset: Initial paid installment preserved, rest reverted to pending.`)}
                  className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors disabled:opacity-40 border border-slate-200 hover:border-rose-200 bg-white shadow-sm"
                  title="Reset table (except first installment)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                </button>
              </div>

              <div className="inline-flex bg-slate-100 p-1 rounded-lg">
                <button onClick={() => setViewMode("tabular")} title="Tabular View" className={`p-1.5 rounded-md transition-all ${viewMode === "tabular" ? "bg-white shadow-sm text-slate-800" : "text-slate-400 hover:text-slate-600 hover:bg-slate-200/50"}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
                </button>
                <button onClick={() => setViewMode("list")} title="Card View" className={`p-1.5 rounded-md transition-all ${viewMode === "list" ? "bg-white shadow-sm text-slate-800" : "text-slate-400 hover:text-slate-600 hover:bg-slate-200/50"}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                </button>
              </div>
            </div>

            {/* Ledger */}
            {viewMode === "tabular" ? (
              <div className="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
                <div className="overflow-x-auto max-h-[450px] overflow-y-auto custom-scrollbar">
                  <table className="w-full text-sm text-left relative">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400 font-bold border-b border-slate-200 sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="px-4 py-2.5">Due date</th>
                        <th className="px-4 py-2.5">INST Number</th>
                        <th className="px-4 py-2.5 text-left">INST Due Premium (Rupees)</th>
                        <th className="px-4 py-2.5 text-left">Outstanding Payment (Rupees)</th>
                        <th className="px-4 py-2.5">Comments</th>
                        <th className="px-4 py-2.5">Status</th>
                        <th className="px-4 py-2.5 text-left">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {rows.length === 0 ? (
                        <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400 text-xs">No installments — the next premium is created at renewal.</td></tr>
                      ) : rows.map((s) => {
                        const chip = STATE_CHIP[s.state] ?? STATE_CHIP.upcoming;
                        const collectable = s.state !== "paid" && s.state !== "waived";
                        return (
                          <tr key={s.id} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">
                              {s.due_date}
                            </td>
                            <td className="px-4 py-2.5 text-slate-600 font-medium">
                              {String(s.installment_no).padStart(2, '0')}
                            </td>
                            <td className="px-4 py-2.5 text-left font-mono text-xs text-slate-700">
                              {fmtPKR(collectable ? s.payable : s.amount_due).replace(/Rs\s*/, '')}
                              {s.surcharge > 0 && collectable && <span className="block text-[9px] text-orange-500">incl. {fmtPKR(s.surcharge).replace(/Rs\s*/, '')} surcharge</span>}
                            </td>
                            <td className="px-4 py-2.5 text-left font-mono text-xs text-slate-700">
                              {s.outstanding > 0 ? (
                                <span className="text-amber-600 font-semibold">{fmtPKR(s.outstanding).replace(/Rs\s*/, '')}</span>
                              ) : (
                                <span className="text-slate-400">0</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-500">
                              {s.state === "paid" ? `Paid on ${s.paid_at?.slice(0, 10) ?? "—"}` :
                                s.state === "partially_paid" ? `Post Dated Amount: ${fmtPKR((s.amount_due + (s.surcharge || 0)) - s.outstanding)} paid` :
                                  s.state === "waived" ? "Installment waived" :
                                    !collectable ? "—" :
                                      collectable && s.days_until < 0 ? `Overdue by ${Math.abs(s.days_until)}d` :
                                        collectable && s.days_until >= 0 ? `Due in ${s.days_until}d` :
                                          "Standard cycle"}
                              {s.reminder_count > 0 && <span className="block mt-0.5 text-[10px] text-slate-400">🔔 {s.reminder_count} reminder(s)</span>}
                            </td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${chip.cls}`}>{chip.label}</span>
                            </td>
                            <td className="px-4 py-2.5 text-left">
                              {collectable ? (
                                <select
                                  className="w-[90px] px-2 py-1 bg-white border border-slate-200 rounded-md text-[10px] font-semibold text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                                  value=""
                                  onChange={(e) => {
                                    const action = e.target.value;
                                    if (action === "collect") run(() => collect(s.id), `Installment #${s.installment_no} collected via ${channel}${s.surcharge > 0 ? " (incl. surcharge)" : ""} — receipt generated.`);
                                    if (action === "remind") run(() => remind(s), `Reminder sent for #${s.installment_no} via ${remChannel} (${remTemplate}).`);
                                    if (action === "waive") run(() => waiveInstallment(policyId, s.id), `Installment #${s.installment_no} waived.`);
                                  }}
                                  disabled={locked}
                                >
                                  <option value="" disabled>Actions...</option>
                                  <option value="collect">Collect Premium</option>
                                  <option value="remind">Send Reminder</option>
                                  <option value="waive">Waive Installment</option>
                                </select>
                              ) : (
                                <button onClick={() => setSelectedInstallment(s)} className="inline-flex items-center justify-center p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors" title="View details">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[450px] overflow-y-auto custom-scrollbar p-1">
                {rows.length === 0 ? (
                  <div className="col-span-full p-8 text-center text-slate-400 text-xs border border-slate-200 rounded-xl">No installments — the next premium is created at renewal.</div>
                ) : rows.map((s) => {
                  const chip = STATE_CHIP[s.state] ?? STATE_CHIP.upcoming;
                  const collectable = s.state !== "paid" && s.state !== "waived";
                  return (
                    <div key={s.id} className="relative bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-1">INST Number</p>
                          <p className="text-xl font-black text-slate-800">{String(s.installment_no).padStart(2, '0')}</p>
                        </div>
                        <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-bold border ${chip.cls}`}>{chip.label}</span>
                      </div>
                      <div className="space-y-3 flex-1">
                        <div className="flex justify-between border-b border-slate-50 pb-3">
                          <p className="text-xs text-slate-500 font-medium">Due date</p>
                          <p className="text-xs font-semibold text-slate-700 font-mono">{s.due_date}</p>
                        </div>
                        <div className="flex justify-between border-b border-slate-50 pb-3">
                          <p className="text-xs text-slate-500 font-medium">Premium Due</p>
                          <div className="text-right">
                            <p className="text-xs font-semibold text-slate-800 font-mono">{fmtPKR(collectable ? s.payable : s.amount_due)}</p>
                            {s.surcharge > 0 && collectable && <p className="text-[9px] text-orange-500 font-semibold mt-0.5">incl. {fmtPKR(s.surcharge)} sur.</p>}
                          </div>
                        </div>
                        <div className="flex justify-between items-center pb-1">
                          <p className="text-xs text-slate-500 font-medium">Outstanding</p>
                          {s.outstanding > 0 ? (
                            <p className="text-sm font-bold text-amber-600 font-mono">{fmtPKR(s.outstanding)}</p>
                          ) : (
                            <p className="text-sm font-bold text-slate-400 font-mono">Rs 0</p>
                          )}
                        </div>
                        <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                          <p className="text-[11px] font-medium text-slate-600">
                            {s.state === "paid" ? `Paid on ${s.paid_at?.slice(0, 10) ?? "—"}` :
                              s.state === "partially_paid" ? `Post Dated Amount: ${fmtPKR((s.amount_due + (s.surcharge || 0)) - s.outstanding)} paid` :
                                s.state === "waived" ? "Installment waived" :
                                  !collectable ? "—" :
                                    collectable && s.days_until < 0 ? `Overdue by ${Math.abs(s.days_until)}d` :
                                      collectable && s.days_until >= 0 ? `Due in ${s.days_until}d` :
                                        "Standard cycle"}
                          </p>
                          {s.reminder_count > 0 && <p className="mt-1.5 text-[10px] text-slate-400 font-bold">🔔 {s.reminder_count} reminder(s)</p>}
                        </div>
                      </div>
                      {collectable ? (
                        <div className="mt-4 pt-4 border-t border-slate-100">
                          <select
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer transition-colors hover:bg-white"
                            value=""
                            onChange={(e) => {
                              const action = e.target.value;
                              if (action === "collect") run(() => collect(s.id), `Installment #${s.installment_no} collected via ${channel}${s.surcharge > 0 ? " (incl. surcharge)" : ""} — receipt generated.`);
                              if (action === "remind") run(() => remind(s), `Reminder sent for #${s.installment_no} via ${remChannel} (${remTemplate}).`);
                              if (action === "waive") run(() => waiveInstallment(policyId, s.id), `Installment #${s.installment_no} waived.`);
                            }}
                            disabled={locked}
                          >
                            <option value="" disabled>Select Action...</option>
                            <option value="collect">Collect Premium</option>
                            <option value="remind">Send Reminder</option>
                            <option value="waive">Waive Installment</option>
                          </select>
                        </div>
                      ) : (
                        <div className="mt-4 pt-4 border-t border-slate-100 flex justify-end">
                          <button onClick={() => setSelectedInstallment(s)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-200">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                            View details
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </JourneyAccordion>

          <JourneyAccordion title="Reminder history" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>} isOpen={sec("reminders")} onToggle={openReminders}>
            <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {(reminders ?? []).length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-slate-400">No reminders sent yet.</p>
              ) : (reminders ?? []).map((r) => (
                <div key={r.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-700 truncate">{r.kind} · {r.channel} · <span className="font-normal text-slate-400">{r.template}</span></p>
                    {r.message && <p className="text-[10px] text-slate-400 truncate">{r.message}</p>}
                  </div>
                  <span className="text-[10px] text-slate-400 flex-shrink-0">{r.created_at.slice(0, 16).replace("T", " ")}</span>
                </div>
              ))}
            </div>
          </JourneyAccordion>
        </div>
      </JourneyAccordion>

      {/* Modal for Installment Details */}
      {selectedInstallment && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center p-4 border-b border-slate-100 bg-slate-50/50">
              <h3 className="font-bold text-slate-800">Installment Breakdown</h3>
              <button onClick={() => setSelectedInstallment(null)} className="p-1 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-200 transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="p-5 overflow-y-auto custom-scrollbar max-h-[80vh]">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">INST #{String(selectedInstallment.installment_no).padStart(2, '0')}</p>
                <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${(STATE_CHIP[selectedInstallment.state] ?? STATE_CHIP.upcoming).cls}`}>
                  {(STATE_CHIP[selectedInstallment.state] ?? STATE_CHIP.upcoming).label}
                </span>
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                <div className="divide-y divide-slate-100 bg-white">
                  {selectedInstallment.installment_no === 1 ? (
                    <>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Base installment premium</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">{fmtPKR(selectedInstallment.amount_due - 5150)}</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Management & Admin Charge</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 1,750</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Agent Charges</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 2,000</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Courier Charges</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 500</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Policy Maintenance Fee</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 100</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Initial Medical & Underwriting</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 150</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Fund Management Fee (FMF)</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 200</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Document Issuance Fee</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 400</span>
                      </div>
                      <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-medium text-slate-600">Government Stamp Duty</span>
                        <span className="text-sm font-bold text-slate-800 font-mono">Rs 50</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                      <span className="text-sm font-medium text-slate-600">Base installment premium</span>
                      <span className="text-sm font-bold text-slate-800 font-mono">{fmtPKR(selectedInstallment.amount_due)}</span>
                    </div>
                  )}
                  {selectedInstallment.surcharge > 0 && (
                    <div className="flex justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
                      <span className="text-sm font-medium text-orange-600">Late Surcharge</span>
                      <span className="text-sm font-bold text-orange-600 font-mono">{fmtPKR(selectedInstallment.surcharge)}</span>
                    </div>
                  )}
                </div>
                <div className="flex justify-between items-center px-4 py-4 bg-slate-50 border-t border-slate-200">
                  <span className="text-sm font-black text-slate-800 uppercase tracking-wider">Total Amount</span>
                  <span className="text-lg font-black text-blue-700 font-mono">{fmtPKR(
                    selectedInstallment.state === "paid" || selectedInstallment.state === "waived"
                      ? selectedInstallment.amount_due + (selectedInstallment.surcharge || 0)
                      : (selectedInstallment.payable ?? selectedInstallment.amount_due)
                  )}</span>
                </div>
              </div>

              {selectedInstallment.state === "paid" && selectedInstallment.paid_at && (
                <div className="mt-4 bg-blue-50/50 border border-blue-100 rounded-lg p-3">
                  <p className="text-xs text-blue-600 font-semibold mb-1">Payment Info</p>
                  <p className="text-sm font-medium text-blue-800">Paid on: {selectedInstallment.paid_at.slice(0, 10)}</p>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end">
              <button onClick={() => setSelectedInstallment(null)} className="px-4 py-2 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition-colors shadow-sm">Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      <CustomPaymentModal
        isOpen={isBulkModalOpen}
        onClose={() => setIsBulkModalOpen(false)}
        onSubmit={handleBulkSubmit}
        isBusy={busy}
        maxAmount={sum.total_outstanding}
      />
    </div>
  );
}

export default function PostIssuancePage() {
  const params = useParams();
  const router = useRouter();
  const policyId = String(params.policyId);

  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [freeLook, setFreeLook] = useState<FreeLookStatus | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [billing, setBilling] = useState<BillingLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<StepId>("free-look");
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const countdown = useCountdown(freeLook?.is_open ? freeLook.free_look_end_date : null);

  const load = useCallback(async () => {
    try {
      const [d, fl, ob, bl] = await Promise.all([
        getPolicyDetail(policyId),
        getFreeLookStatus(policyId).catch(() => null),
        getOnboarding(policyId).catch(() => null),
        getBilling(policyId).catch(() => null),
      ]);
      setDetail(d);
      setFreeLook(fl);
      setOnboarding(ob);
      setBilling(bl);
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? err?.message ?? "Failed to load policy.");
    }
  }, [policyId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await load();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [load]);

  // Return to wherever the user came from (the Post Policy Issuance list), not a
  // hardcoded page. Falls back to the list if there's no history to pop.
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/policy-management/post-issuance");
  };

  const doCancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await cancelWithinFreeLook(policyId, { reason: reason || undefined });
      setToast(`Policy cancelled — ${fmtPKR(res.refund_amount)} refunded (ref ${res.refund.reference}).`);
      setConfirmOpen(false);
      setReason("");
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? err?.message ?? "Cancellation failed.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="py-24 flex justify-center">
        <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-500" />
      </div>
    );
  }

  const activeStep = STAGE_B_STEPS.find((s) => s.id === active)!;
  const liveCount = STAGE_B_STEPS.filter((s) => s.live).length;

  return (
    <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-8 space-y-6">
      {/* Breadcrumb + heading */}
      <div>
        <button onClick={goBack} className="text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-blue-600 transition-colors inline-flex items-center gap-1.5 mb-2">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
          Back
        </button>
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mt-2">
          <div>
            <div className="inline-flex items-center gap-2 mb-2.5 px-3 py-1 rounded-md bg-blue-50 border border-blue-100 shadow-sm">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
              <p className="text-[10px] font-bold text-blue-700 uppercase tracking-widest">Stage B · Policy Management</p>
            </div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight">{detail?.customer_name ?? "Policy"}</h1>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs font-bold font-mono text-slate-700 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200">{detail?.policy_number?.replace('POL-', 'PL-') ?? "—"}</span>
              {detail?.product_name && <span className="text-sm font-semibold text-slate-500 px-1 border-l-2 border-slate-200 pl-3">{detail.product_name}</span>}
            </div>
          </div>
          {detail && (
            <div className="mt-1 md:mt-0 flex items-center gap-3">
              <Badge status={detail.status} />

              <div className="relative">
                <button
                  onClick={() => setActionsOpen(!actionsOpen)}
                  className="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-blue-600 hover:border-blue-200 hover:bg-blue-50 transition-all shadow-sm"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                  </svg>
                </button>

                {actionsOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setActionsOpen(false)}></div>
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-lg border border-slate-200 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                      <button onClick={() => { setActionsOpen(false); setJourneyOpen(true); }} className="w-full text-left px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-700 flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        View Details
                      </button>
                      <button onClick={() => { setActionsOpen(false); alert('Edit Policy - Coming soon'); }} className="w-full text-left px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-700 flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        Edit Policy
                      </button>
                      <div className="h-px bg-slate-100 my-1 mx-2"></div>
                      <button onClick={() => { setActionsOpen(false); if (confirm('Are you sure you want to delete this policy? This action cannot be undone.')) { alert('Delete functionality not yet connected to backend.'); } }} className="w-full text-left px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50 flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        Delete Policy
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}
      {toast && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-sm px-4 py-3 flex items-center justify-between">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="text-blue-500 hover:text-blue-700">×</button>
        </div>
      )}

      {/* Contract facts — full-width card row */}
      {detail && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Sum Assured" value={fmtCoverage(detail.coverage_amount)} />
          <StatCard label="Effective" value={detail.effective_date ?? "—"} />
          <StatCard label="Expiry" value={detail.expiry_date ?? "—"} />
          <StatCard label="Nominee" value={detail.nominee_name ?? "—"} />
        </div>
      )}

      {/* Two-pane: step navigator + active panel */}
      <div className="grid lg:grid-cols-[320px_1fr] gap-6 items-start">
        {/* Navigator */}
        <nav aria-label="Post-issuance steps" className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-slate-100">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Post-Issuance Journey</p>
            <span className="text-[10px] font-semibold text-blue-600">{liveCount}/{STAGE_B_STEPS.length} live</span>
          </div>
          <div className="space-y-1">
            {STAGE_B_STEPS.map((step) => {
              const isActive = step.id === active;
              return (
                <button
                  key={step.id}
                  aria-current={isActive ? "step" : undefined}
                  onClick={() => setActive(step.id)}
                  className={`w-full text-left flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors ${isActive
                    ? "border-blue-300 bg-blue-50"
                    : "border-transparent hover:border-slate-200 hover:bg-slate-50"
                    }`}
                >
                  <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold flex-shrink-0 ${step.live ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500"
                    }`}>
                    {step.n}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-semibold truncate ${isActive ? "text-blue-800" : "text-slate-700"}`}>
                      {step.title}
                    </span>
                    <span className="block text-[11px] text-slate-400 truncate">{step.blurb}</span>
                  </span>
                  <span className={`text-[9px] font-semibold uppercase flex-shrink-0 ${step.live ? "text-blue-600" : "text-slate-400"}`}>
                    {step.live ? "Live" : "Soon"}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Active step panel */}
        <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden min-h-[460px] flex flex-col relative">
          <div key={active} className="animate-dropdown flex flex-col flex-1">
            <header className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
              <span className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${activeStep.live ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500"
                }`}>
                {activeStep.n}
              </span>
              <div>
                <h2 className="text-sm font-bold text-slate-800">{activeStep.title}</h2>
                <p className="text-[11px] text-slate-400">{activeStep.blurb}</p>
              </div>
            </header>

            <div className="p-6 flex-1">
              {active === "free-look" && (
                <FreeLookPanel
                  freeLook={freeLook}
                  countdown={countdown}
                  onCancel={() => setConfirmOpen(true)}
                  documents={detail?.documents ?? []}
                  policyId={policyId}
                />
              )}
              {active === "onboarding" && detail && (
                <OnboardingPanel detail={detail} onboarding={onboarding} onChanged={load} onOpenJourney={() => setJourneyOpen(true)} />
              )}
              {active === "premiums" && (
                <PremiumCollectionPanel policyId={policyId} billing={billing} onChanged={load} />
              )}
              {active === "endorsements" && detail && (
                <PolicyIssuancePanel detail={detail} policyId={policyId} billing={billing} />
              )}
              {active === "servicing" && (
                <ServicingPanel policyId={policyId} onChanged={load} />
              )}
              {active !== "free-look" && active !== "onboarding" && active !== "premiums" && active !== "endorsements" && active !== "servicing" && (
                <ComingSoon step={activeStep} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Cancel confirmation modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">Cancel within free-look?</h3>
              <p className="text-xs text-slate-500 mt-1">
                This terminates the policy and refunds the full premium of{" "}
                <b className="text-slate-700">{fmtPKR(freeLook?.refund_amount ?? 0)}</b>. This cannot be undone.
              </p>
            </div>
            <div>
              <label htmlFor="fl-reason" className="text-[11px] font-semibold text-slate-500">Reason (optional)</label>
              <textarea
                id="fl-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-100"
                placeholder="e.g. changed mind, found a better plan…"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setConfirmOpen(false); setReason(""); }}
                disabled={busy}
                className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40"
              >
                Keep policy
              </button>
              <button
                onClick={doCancel}
                disabled={busy}
                className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
              >
                {busy ? "Processing…" : "Confirm cancellation & refund"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Modals (must be outside of animate-dropdown bounds) */}
      {journeyOpen && detail && (
        <JourneyModal detail={detail} onClose={() => setJourneyOpen(false)} />
      )}
    </div>
  );
}

// ── Step 1 panel — Deliver Policy & Free-Look ────────────────────────────────

function FreeLookPanel({
  freeLook, countdown, onCancel, documents, policyId,
}: Readonly<{ freeLook: FreeLookStatus | null; countdown: Remaining | null; onCancel: () => void; documents: PolicyDocument[]; policyId: string }>) {
  if (!freeLook) {
    return <p className="text-xs text-slate-400 italic">Free-look data unavailable for this policy.</p>;
  }

  let windowState = "N/A";
  if (freeLook.cancelled) windowState = "Cancelled";
  else if (freeLook.is_open) windowState = "Open";
  else if (freeLook.status === "Active") windowState = "Closed";

  return (
    <div className="space-y-5">
      {/* Stat card row — fills the panel width */}
      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Documents delivered" value={freeLook.delivery_date ?? "—"} />
        <StatCard label="Free-look ends" value={freeLook.free_look_end_date ?? "—"} />
        <StatCard
          label="Full refund value"
          value={fmtPKR(freeLook.refund_amount)}
          hint={`Window: ${windowState}`}
          accent
        />
      </div>

      {/* Main status card — spans the full panel width */}
      <FreeLookStateCard freeLook={freeLook} countdown={countdown} onCancel={onCancel} />

      <div className="mt-8 pt-6 border-t border-slate-100">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-6 h-6 rounded bg-blue-100 text-blue-600 shadow-sm">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </span>
            <h3 className="text-sm font-bold text-slate-800 tracking-tight">Policy Documents (Deliverables)</h3>
          </div>
          <span className="text-[10px] uppercase tracking-widest font-bold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200">
            {documents.length} Files
          </span>
        </div>

        {documents.length > 0 ? (
          <div className="grid sm:grid-cols-2 gap-3">
            {documents.map((doc) => (
              <button
                key={doc.id}
                onClick={() => downloadDocument(policyId, doc.id)}
                className="group relative overflow-hidden flex items-start gap-3 p-4 rounded-xl border border-slate-200 bg-white hover:border-blue-300 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 text-left"
              >
                <div className="absolute top-0 left-0 w-1 h-full bg-blue-400 scale-y-0 group-hover:scale-y-100 transition-transform origin-top"></div>
                <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg bg-slate-50 text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors border border-slate-100 group-hover:border-blue-100">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <p className="text-sm font-bold text-slate-700 group-hover:text-blue-800 truncate transition-colors">
                    {doc.document_name}
                  </p>
                  <p className="text-[11px] font-medium text-slate-400 mt-0.5 flex items-center gap-1.5">
                    PDF Document
                    <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                    <span className="text-slate-400 group-hover:text-blue-600 font-semibold transition-colors">Click to download</span>
                  </p>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 border-dashed bg-slate-50/50 p-6 flex flex-col items-center justify-center text-center">
            <svg className="w-8 h-8 text-slate-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm font-medium text-slate-500">No documents available</p>
            <p className="text-xs text-slate-400 mt-1">Generated documents will appear here once ready.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function FreeLookStateCard({
  freeLook, countdown, onCancel,
}: Readonly<{ freeLook: FreeLookStatus; countdown: Remaining | null; onCancel: () => void }>) {
  if (freeLook.cancelled) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-200 text-slate-500">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
          <p className="text-sm font-bold text-slate-700">Cancelled during free-look</p>
        </div>
        <div className="grid sm:grid-cols-3 gap-4 mt-4">
          <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Refunded</p><p className="text-sm font-semibold text-slate-700 mt-0.5">{fmtPKR(freeLook.cancellation?.refund_amount ?? 0)}</p></div>
          <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Reference</p><p className="text-sm font-mono text-slate-700 mt-0.5">{freeLook.cancellation?.refund_reference ?? "—"}</p></div>
          <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Date</p><p className="text-sm font-semibold text-slate-700 mt-0.5">{freeLook.cancellation?.at?.slice(0, 10) ?? "—"}</p></div>
        </div>
      </div>
    );
  }

  if (freeLook.is_open && countdown) {
    return (
      <div className="rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-blue-800">Free-look window is open</p>
            <p className="text-xs text-blue-700/80 mt-1 max-w-md">
              The policyholder can walk away with no penalty until the window closes — a full refund of <b>{fmtPKR(freeLook.refund_amount)}</b>.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-white border border-red-200 text-red-700 hover:bg-red-50 transition-colors flex-shrink-0"
          >
            Cancel for full refund
          </button>
        </div>
        <div className="flex items-end gap-3 mt-6">
          <CountdownUnit value={countdown.days} label="Days" />
          <span className="text-3xl font-bold text-blue-300 pb-7">:</span>
          <CountdownUnit value={countdown.hours} label="Hrs" />
          <span className="text-3xl font-bold text-blue-300 pb-7">:</span>
          <CountdownUnit value={countdown.mins} label="Min" />
          <span className="text-3xl font-bold text-blue-300 pb-7">:</span>
          <CountdownUnit value={countdown.secs} label="Sec" />
        </div>
      </div>
    );
  }

  if (freeLook.status === "Active") {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
        Free-look window closed{freeLook.free_look_end_date ? ` on ${freeLook.free_look_end_date}` : ""}. Cancellation now follows standard surrender rules (step 8).
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-400 italic">
      Free-look applies only while cover is in force.
    </div>
  );
}

// ── Step 2 panel — Customer Welcome & Onboarding ─────────────────────────────

function AccordionCard({
  n, title, done, isOpen, onToggle, children,
}: Readonly<{ n: number; title: string; done: boolean; isOpen: boolean; onToggle: () => void; children: React.ReactNode }>) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border transition-all duration-300 ${done ? "border-blue-200 bg-gradient-to-br from-blue-50/40 to-white shadow-sm" : "border-slate-200 bg-white shadow-sm"}`}>
      {done && (
        <div className="absolute top-0 right-0 -mt-4 -mr-4 w-24 h-24 bg-blue-400 opacity-10 rounded-full blur-2xl pointer-events-none"></div>
      )}
      <button
        onClick={onToggle}
        className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-slate-50/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold shadow-sm ${done ? "bg-gradient-to-r from-blue-500 to-blue-500 text-white shadow-blue-200" : "bg-slate-100 text-slate-500"}`}>
            {done ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : n}
          </span>
          <p className="text-sm font-bold text-slate-800 tracking-tight">{title}</p>
        </div>
        <div className={`transform transition-transform duration-300 ${isOpen ? "rotate-180" : ""} text-slate-400`}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      <div className={`overflow-hidden transition-all duration-300 ${isOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"}`}>
        <div className="px-6 pb-6 pt-2 relative z-10">
          <div className="pt-4 border-t border-slate-100">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function OnboardingBtn({
  onClick, children, tone = "slate", disabled,
}: Readonly<{ onClick: () => void; children: React.ReactNode; tone?: "slate" | "emerald"; disabled?: boolean }>) {
  const tones = {
    slate: "bg-slate-800 hover:bg-slate-900 text-white shadow-sm hover:shadow",
    emerald: "bg-gradient-to-r from-blue-600 to-blue-600 hover:from-blue-700 hover:to-blue-700 text-white shadow-md shadow-blue-200 hover:shadow-blue-300",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${tones[tone]}`}>
      {children}
    </button>
  );
}

function OnboardingPanel({
  detail, onboarding, onChanged, onOpenJourney,
}: Readonly<{ detail: PolicyDetail; onboarding: OnboardingStatus | null; onChanged: () => Promise<void>; onOpenJourney: () => void }>) {
  const policyId = detail.id;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creds, setCreds] = useState<PortalCredentials | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  if (!onboarding) {
    return <p className="text-xs text-slate-400 italic">Onboarding data unavailable for this policy.</p>;
  }

  const locked = busy || !onboarding.can_onboard;
  const s = onboarding.steps;
  const hasContact = Boolean(onboarding.contact.email || onboarding.contact.phone);

  const [openStep, setOpenStep] = useState<number>(() => {
    if (!s.welcome_kit.done) return 1;
    if (!s.portal.done) return 2;
    if (!s.welcome_sent.done) return 3;
    if (!s.acknowledged.done) return 4;
    return 1;
  });

  const { notify } = useNotify();

  const run = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true); setErr(null);
    try {
      await fn();
      await onChanged();
      if (successMsg) notify(successMsg, true);
    }
    catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "Action failed";
      setErr(msg);
      notify(msg, false);
    }
    finally { setBusy(false); }
  };

  const copy = (text: string) => navigator.clipboard?.writeText(text);

  return (
    <div className="space-y-6">
      {/* Progress + status */}
      <div className="flex items-center justify-between bg-slate-50/80 border border-slate-100 rounded-2xl p-4 shadow-sm backdrop-blur-sm">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Onboarding Progress</p>
          <div className="flex items-center gap-3">
            <div className="w-32 h-1.5 bg-slate-200 rounded-full overflow-hidden shadow-inner">
              <div className="h-full bg-gradient-to-r from-blue-400 to-blue-500 rounded-full transition-all duration-700 ease-out"
                style={{ width: `${(onboarding.progress.done / onboarding.progress.total) * 100}%` }}></div>
            </div>
            <p className="text-xs font-bold text-slate-700">
              {onboarding.progress.done}/{onboarding.progress.total}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5">
          {onboarding.progress.done > 0 && (
            <button
              onClick={() => {
                if (confirm("Reset all onboarding progress? This will clear the policyholder ID, portal account, and welcome kit record.")) {
                  run(() => resetOnboarding(policyId));
                }
              }}
              disabled={locked}
              className="text-[11px] font-bold tracking-wider text-slate-400 hover:text-red-500 transition-colors uppercase disabled:opacity-50 group flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5 transition-transform group-hover:-rotate-45" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Reset
            </button>
          )}
          <span className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-full border shadow-sm ${onboarding.completed
            ? "bg-gradient-to-r from-blue-100 to-blue-100 text-blue-800 border-blue-200"
            : "bg-white text-amber-700 border-amber-200"
            }`}>
            {onboarding.status}
          </span>

          <button
            onClick={onOpenJourney}
            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors ml-1 border border-transparent hover:border-blue-200"
            title="View Lead Journey & Details"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
        </div>
      </div>

      {!onboarding.can_onboard && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
          🔒 Onboarding is only available while cover is in force (policy is {onboarding.policy_status}).
        </div>
      )}
      {onboarding.warnings.map((w) => (
        <div key={w} className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">⚠ {w}</div>
      ))}
      {err && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>}

      {/* One-time credential reveal */}
      {creds && (
        <div className="rounded-2xl border border-blue-300 bg-blue-50 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-blue-800">Portal credentials {creds.reset ? "reset" : "created"}</p>
            <button onClick={() => setCreds(null)} className="text-blue-500 hover:text-blue-700 text-sm">×</button>
          </div>
          <p className="text-[11px] text-blue-700/80 mt-0.5">Shown once — copy and hand these to the policyholder now.</p>
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <div className="bg-white rounded-lg border border-blue-200 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Username</p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-mono text-slate-800 truncate">{creds.username}</p>
                <button onClick={() => copy(creds.username)} className="text-[11px] text-blue-600 hover:text-blue-700 font-semibold">Copy</button>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-blue-200 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Temporary password</p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-mono text-slate-800 truncate">{creds.temp_password}</p>
                <button onClick={() => copy(creds.temp_password)} className="text-[11px] text-blue-600 hover:text-blue-700 font-semibold">Copy</button>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">Portal: <span className="font-mono">{creds.portal_url}</span></p>
        </div>
      )}

      {/* Accordion List */}
      <div className="space-y-3">
        {/* 1 — Welcome Kit */}
        <AccordionCard n={1} title="Welcome Kit" done={s.welcome_kit.done} isOpen={openStep === 1} onToggle={() => setOpenStep(openStep === 1 ? 0 : 1)}>
          {s.welcome_kit.done ? (
            <div className="space-y-3">
              <div className="bg-white/50 rounded-lg p-2.5 border border-blue-100/50">
                <p className="text-xs font-medium text-slate-700 truncate flex items-center gap-2">
                  <svg className="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  {s.welcome_kit.name}
                </p>
              </div>
              <div className="flex gap-2.5 pt-1">
                <a href={welcomeKitDownloadUrl(policyId)} target="_blank" rel="noreferrer"
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-200 transition-all duration-200 inline-flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download PDF
                </a>
                <OnboardingBtn disabled={locked} onClick={() => run(() => generateWelcomeKit(policyId))}>Regenerate</OnboardingBtn>
              </div>
            </div>
          ) : (
            <OnboardingBtn tone="emerald" disabled={locked} onClick={() => run(() => generateWelcomeKit(policyId))}>Generate welcome kit</OnboardingBtn>
          )}
        </AccordionCard>

        {/* 2 — Portal Login */}
        <AccordionCard n={2} title="Customer Portal Login" done={s.portal.done} isOpen={openStep === 2} onToggle={() => setOpenStep(openStep === 2 ? 0 : 2)}>
          {s.portal.done ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-600">Username: <span className="font-mono text-slate-800">{s.portal.username}</span> · <span className="text-slate-400">{s.portal.status}</span></p>
              <OnboardingBtn disabled={locked} onClick={() => run(async () => setCreds(await provisionPortal(policyId)))}>Reset password</OnboardingBtn>
            </div>
          ) : (
            <OnboardingBtn tone="emerald" disabled={locked} onClick={() => run(async () => setCreds(await provisionPortal(policyId)))}>Provision portal access</OnboardingBtn>
          )}
        </AccordionCard>

        {/* 3 — Welcome Delivery */}
        <AccordionCard n={3} title="Send Welcome Pack" done={s.welcome_sent.done} isOpen={openStep === 3} onToggle={() => setOpenStep(openStep === 3 ? 0 : 3)}>
          {s.welcome_sent.done ? (
            <p className="text-xs text-slate-600">Sent via {s.welcome_sent.channel} · {s.welcome_sent.at?.slice(0, 10)}</p>
          ) : !s.welcome_kit.done ? (
            <p className="text-[11px] text-slate-400">Generate the welcome kit first.</p>
          ) : hasContact ? (
            <div className="space-y-1.5">
              <p className="text-[11px] text-slate-500">
                Deliver to <span className="font-medium text-slate-700">{onboarding.contact.email ?? onboarding.contact.phone}</span>.
              </p>
              <OnboardingBtn tone="emerald" disabled={locked} onClick={() => run(() => sendWelcome(policyId))}>Send welcome pack</OnboardingBtn>
            </div>
          ) : (
            /* No contact on record — capture one, or record a physical delivery. */
            <div className="space-y-3">
              <p className="text-[11px] text-amber-700 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100 flex items-start gap-2">
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                No email/phone on record. Add a contact to deliver digitally, or record a manual delivery.
              </p>
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                  </div>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address"
                    className="w-full text-xs border border-slate-200 rounded-xl pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all bg-slate-50 hover:bg-white" />
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                  </div>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number"
                    className="w-full text-xs border border-slate-200 rounded-xl pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all bg-slate-50 hover:bg-white" />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <OnboardingBtn tone="emerald" disabled={locked || (!email.trim() && !phone.trim())}
                  onClick={() => run(async () => {
                    await setOnboardingContact(policyId, { email: email.trim() || undefined, phone: phone.trim() || undefined });
                    await sendWelcome(policyId);
                    setEmail(""); setPhone("");
                  })}>Save & send</OnboardingBtn>
                <OnboardingBtn disabled={locked} onClick={() => run(() => sendWelcome(policyId, { channel: "Manual" }))}>Record manual delivery</OnboardingBtn>
              </div>
            </div>
          )}

          {s.welcome_kit.done && (
            <div className="pt-4 mt-4 border-t border-slate-100">
              <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-2">Acknowledgment (optional)</p>
              {s.acknowledged.done ? (
                <p className="text-xs text-slate-600">Confirmed via {s.acknowledged.method} · {s.acknowledged.at?.slice(0, 10)}</p>
              ) : (
                <OnboardingBtn disabled={locked} onClick={() => run(() => acknowledgeOnboarding(policyId, { method: "Call" }))}>Mark acknowledged</OnboardingBtn>
              )}
            </div>
          )}
        </AccordionCard>


      </div>

      {onboarding.completed && (
        <div className="relative overflow-hidden rounded-2xl border border-blue-200 bg-gradient-to-r from-blue-50 to-blue-50/50 p-5 flex items-center gap-4 shadow-sm mt-8">
          <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-full bg-blue-100/80 border border-blue-200 shadow-sm">
            <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="relative z-10">
            <p className="text-sm font-bold text-blue-900 tracking-tight">Onboarding Complete</p>
            <p className="text-xs font-medium text-blue-700/80 mt-1">The policyholder is fully welcomed and set up in our systems.</p>
          </div>
          <div className="absolute top-0 right-0 w-48 h-48 bg-blue-300 opacity-20 rounded-full blur-3xl transform translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>
        </div>
      )}
    </div>
  );
}

// ── Step 3+ placeholder ──────────────────────────────────────────────────────

// ── Step 4 panel — Policy Issuance record + document pack ─────────────────────

function IssueDropdown({
  title, icon, badge, defaultOpen, children,
}: Readonly<{ title: string; icon: React.ReactNode; badge?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }>) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
        <div className="flex items-center gap-2.5">
          <span className="text-slate-400">{icon}</span>
          <p className="text-sm font-bold text-slate-800">{title}</p>
          {badge != null && <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">{badge}</span>}
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`w-4 h-4 text-slate-400 transition-transform duration-300 ${open ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className={`overflow-hidden transition-all duration-300 ${open ? "max-h-[1600px] opacity-100" : "max-h-0 opacity-0"}`}>
        <div className="px-4 pb-4 pt-3 border-t border-slate-100">{children}</div>
      </div>
    </div>
  );
}

const EVENT_TONE = (t: string) =>
  /lapse|cancel|declin|fail/i.test(t) ? "bg-red-500"
    : /payment|collect/i.test(t) ? "bg-amber-500"
      : /active|issue|revive|renew|confirm/i.test(t) ? "bg-blue-500" : "bg-slate-400";

function PolicyIssuancePanel({
  detail, policyId, billing,
}: Readonly<{ detail: PolicyDetail; policyId: string; billing: BillingLedger | null }>) {
  const [events, setEvents] = useState<PolicyEvent[] | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    const e = await getPolicyEvents(policyId).catch(() => [] as PolicyEvent[]);
    setEvents(e);
  }, [policyId]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const docs = detail.documents ?? [];
  const { notify } = useNotify();

  const download = async (docId: string) => {
    setDownloading(docId); setErr(null);
    try {
      await downloadDocument(policyId, docId);
      notify("Document downloaded.", true);
    }
    catch (e: any) {
      const msg = e?.message ?? "Download failed";
      setErr(msg);
      notify(msg, false);
    }
    finally { setDownloading(null); }
  };

  // Last issuance email sent — derived from the audit events.
  const lastEmail = (events ?? []).find((e) => e.event_type === "IssuanceEmailSent");
  const sendEmail = async () => {
    setEmailing(true); setErr(null); setEmailMsg(null);
    try {
      const r = await sendIssuanceEmail(policyId);
      setEmailMsg(`Issuance email sent to ${r.sent_to}.`);
      notify(`Issuance email sent to ${r.sent_to}.`, true);
      await loadEvents();
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "Failed to send email";
      setErr(msg);
      notify(msg, false);
    } finally { setEmailing(false); }
  };

  const inst = billing?.installments ?? [];
  const annualPremium = inst.reduce((a, s) => a + s.amount_due, 0);
  const first = inst.find((s) => s.installment_no === 1) ?? inst[0];
  const freq = first?.billing_frequency ?? "Annual";

  return (
    <div className="space-y-3">
      {/* Issued banner — always visible */}
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex items-center gap-2.5">
        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold">✓</span>
        <div>
          <p className="text-sm font-bold text-blue-800">Policy issued &amp; bound</p>
          <p className="text-xs text-blue-700/80">
            {detail.policy_number?.replace('POL-', 'PL-') ?? "—"}
            {detail.issued_at ? ` · issued ${detail.issued_at.slice(0, 10)}` : ""}
            {detail.issued_by ? ` · by ${detail.issued_by}` : ""}
          </p>
        </div>
      </div>
      {err && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>}

      {/* 1 — Issuance record (open by default) */}
      <IssueDropdown defaultOpen title="Issuance record"
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Policy number" value={detail.policy_number?.replace('POL-', 'PL-') ?? "—"} />
          <StatCard label="Sum assured" value={fmtCoverage(detail.coverage_amount)} />
          <StatCard label="Insurance Term" value={`${detail.term_years} years`} />
          <StatCard label="Status" value={detail.status} accent />
          <StatCard label="Commencement" value={detail.effective_date ?? "—"} />
          <StatCard label="Maturity" value={detail.maturity_date ?? detail.expiry_date ?? "—"} />
          <StatCard label="Expiry / renewal" value={detail.expiry_date ?? "—"} />
          <StatCard label="Nominee" value={detail.nominee_name ?? "—"} />
        </div>
      </IssueDropdown>

      {/* 2 — Premium & payment */}
      <IssueDropdown title="Premium & payment"
        badge={billing ? `${billing.summary.paid}/${billing.summary.total} paid` : undefined}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>}>
        {!billing ? (
          <p className="text-xs text-slate-400 italic">Premium data loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <StatCard label="Annual premium" value={fmtPKR(annualPremium)} accent />
              <StatCard label="Collected to date" value={fmtPKR(billing.dashboard.total_collected)} />
              <StatCard label="Next due" value={billing.summary.next_due_date ?? "—"} hint={billing.summary.next_due_amount != null ? fmtPKR(billing.summary.next_due_amount) : undefined} />
            </div>
            {first && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-slate-700">First premium</p>
                  <p className="text-[11px] text-slate-500">{fmtPKR(first.amount_due)} · due {first.due_date}{first.payment_reference ? ` · ref ${first.payment_reference}` : ""}</p>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${first.state === "paid" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}>
                  {first.state === "paid" ? "Collected" : "Pending"}
                </span>
              </div>
            )}
          </div>
        )}
      </IssueDropdown>

      {/* 3 — Customer communication (issuance confirmation email) */}
      <IssueDropdown title="Customer communication" defaultOpen={!lastEmail}
        badge={lastEmail ? "Sent" : "Not sent"}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>}>
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Send the policyholder a formatted <b>policy-issuance confirmation</b> email — policy summary,
            cover dates, free-look period and portal access.
          </p>
          {lastEmail && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-700">
              ✓ Last sent to <b>{String((lastEmail.detail as any)?.to ?? "customer")}</b> · {lastEmail.created_at.slice(0, 16).replace("T", " ")}
            </div>
          )}
          {emailMsg && <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-700">✓ {emailMsg}</div>}
          <button disabled={emailing} onClick={sendEmail}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">
            {emailing ? "Sending…" : lastEmail ? "Resend issuance email" : "Send issuance email"}
          </button>
        </div>
      </IssueDropdown>

      {/* 4 — Policy document pack */}
      <IssueDropdown title="Policy document pack" badge={docs.length}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>}>
        {docs.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No documents yet — generated once the first premium is confirmed.</p>
        ) : (
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-4 h-4 text-slate-400 flex-shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                <p className="text-sm font-medium text-slate-700 flex-1 truncate">{d.document_name}</p>
                {d.is_stub ? (
                  <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">STUB</span>
                ) : (
                  <button disabled={downloading === d.id} onClick={() => download(d.id)}
                    className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">
                    {downloading === d.id ? "…" : "Download"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </IssueDropdown>

      {/* 5 — Issuance timeline */}
      <IssueDropdown title="Issuance timeline" badge={events ? events.length : undefined}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>}>
        {events === null ? (
          <p className="text-xs text-slate-400 italic">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No lifecycle events recorded.</p>
        ) : (
          <ol className="relative border-l border-slate-200 ml-2 space-y-3 max-h-72 overflow-y-auto pr-2">
            {events.map((e) => (
              <li key={e.id} className="ml-4">
                <span className={`absolute -left-[7px] w-3.5 h-3.5 rounded-full ring-4 ring-white ${EVENT_TONE(e.event_type)}`} />
                <p className="text-xs font-semibold text-slate-800">{e.event_type}</p>
                <p className="text-[11px] text-slate-500">
                  {e.from_status && e.to_status ? <>{e.from_status} → {e.to_status} · </> : null}by {e.actor}
                </p>
                <p className="text-[10px] text-slate-400">{e.created_at.slice(0, 16).replace("T", " ")}</p>
              </li>
            ))}
          </ol>
        )}
      </IssueDropdown>
    </div>
  );
}


// ── Step panel — Policy Servicing & Endorsements ─────────────────────────────

type NomRow = { name: string; cnic?: string; relationship: string; share_pct: number };

function ServicingPanel({ policyId, onChanged }: Readonly<{ policyId: string; onChanged: () => Promise<void> }>) {
  const [ov, setOv] = useState<EndorsementsOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { notify } = useNotify();

  // form state
  const [noms, setNoms] = useState<NomRow[]>([]);
  const [addr, setAddr] = useState({ address: "", city: "", province: "" });
  const [contact, setContact] = useState({ email: "", phone: "" });
  const [newSum, setNewSum] = useState<string>("");
  const [quote, setQuote] = useState<EndorsementQuote | null>(null);
  const [rider, setRider] = useState({ name: "", sum_assured: "" });
  const [emailingId, setEmailingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const o = await getEndorsements(policyId).catch(() => null);
    if (o) {
      setOv(o);
      setNoms(o.beneficiaries.length ? o.beneficiaries.map((b) => ({ ...b, cnic: b.cnic ?? undefined })) : []);
      setAddr({ address: o.address.address ?? "", city: o.address.city ?? "", province: o.address.province ?? "" });
      setContact({ email: o.contact.email ?? "", phone: o.contact.phone ?? "" });
      setNewSum(String(o.sum_assured ?? ""));
    }
  }, [policyId]);
  useEffect(() => { load(); }, [load]);

  // Live re-quote: as the new sum assured is typed, preview the premium impact.
  useEffect(() => {
    const n = Number(newSum);
    if (!ov || !n || n === ov.sum_assured || n <= 0) { setQuote(null); return; }
    const t = setTimeout(() => {
      getEndorsementQuote(policyId, { sum_assured: n }).then(setQuote).catch(() => setQuote(null));
    }, 400);
    return () => clearTimeout(t);
  }, [newSum, ov, policyId]);

  if (!ov) return <p className="text-xs text-slate-400 italic">Loading servicing data…</p>;

  const locked = busy || !ov.can_endorse;
  const nomTotal = Math.round(noms.reduce((a, b) => a + (Number(b.share_pct) || 0), 0) * 100) / 100;

  const run = async (fn: () => Promise<unknown>, note: string) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); await onChanged(); notify(note, true); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? e?.message ?? "Endorsement failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {!ov.can_endorse && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
          🔒 Endorsements are only available while cover is in force (policy is {ov.policy_status}).
        </div>
      )}
      {err && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>}

      {/* Current snapshot */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Sum assured" value={fmtCoverage(ov.sum_assured)} accent />
        <StatCard label="Nominees" value={String(ov.beneficiaries.length)} />
        <StatCard label="Active riders" value={String(ov.riders.length)} />
        <StatCard label="Endorsements" value={String(ov.history.length)} />
      </div>

      {/* 1 — Nominee change */}
      <IssueDropdown defaultOpen title="Nominee change" badge={ov.beneficiaries.length}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>}>
        <div className="space-y-2">
          {noms.map((b, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input value={b.name} placeholder="Name" onChange={(e) => setNoms((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                className="flex-1 min-w-0 text-xs border border-slate-200 rounded px-2 py-1.5" />
              <input value={b.relationship} placeholder="Relation" onChange={(e) => setNoms((p) => p.map((x, j) => j === i ? { ...x, relationship: e.target.value } : x))}
                className="w-24 text-xs border border-slate-200 rounded px-2 py-1.5" />
              <input type="number" value={b.share_pct === 0 ? "" : b.share_pct} placeholder="%" onChange={(e) => setNoms((p) => p.map((x, j) => j === i ? { ...x, share_pct: e.target.value === "" ? 0 : Number(e.target.value) } : x))}
                className="w-16 text-xs border border-slate-200 rounded px-2 py-1.5" />
              <button onClick={() => setNoms((p) => p.filter((_, j) => j !== i))} className="text-slate-300 hover:text-red-500 text-sm px-1">×</button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button onClick={() => setNoms((p) => [...p, { name: "", relationship: "", share_pct: 0 }])} className="text-[11px] text-blue-600 hover:text-blue-700 font-semibold">+ Add nominee</button>
            <span className={`text-[11px] font-semibold ${Math.abs(nomTotal - 100) < 0.01 ? "text-blue-600" : "text-amber-600"}`}>Σ {nomTotal}%</span>
          </div>
          <button disabled={locked || Math.abs(nomTotal - 100) > 0.01 || noms.some((b) => !b.name || !b.relationship)}
            onClick={() => run(() => endorseNominees(policyId, noms, "Nominee change"), "Nominee endorsement applied.")}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">Save nominee change</button>
          {Math.abs(nomTotal - 100) > 0.01 && <span className="ml-2 text-[10px] text-amber-600">Shares must total 100%</span>}
        </div>
      </IssueDropdown>

      {/* 2 — Address update */}
      <IssueDropdown title="Address update"
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>}>
        <div className="space-y-2">
          <input value={addr.address} onChange={(e) => setAddr({ ...addr, address: e.target.value })} placeholder="Street address"
            className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2" />
          <div className="flex gap-2">
            <input value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} placeholder="City" className="flex-1 text-xs border border-slate-200 rounded-lg px-2.5 py-2" />
            <input value={addr.province} onChange={(e) => setAddr({ ...addr, province: e.target.value })} placeholder="Province" className="flex-1 text-xs border border-slate-200 rounded-lg px-2.5 py-2" />
          </div>
          <button disabled={locked || !(addr.address || addr.city || addr.province)}
            onClick={() => run(() => endorseAddress(policyId, addr), "Address endorsement applied.")}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">Save address</button>
        </div>
      </IssueDropdown>

      {/* 2b — Contact update */}
      <IssueDropdown title="Contact update"
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>}>
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500">Keeping contact current ensures reminders and letters reach the policyholder.</p>
          <input value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} placeholder="Email"
            className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2" />
          <input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder="Phone / mobile"
            className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2" />
          <button disabled={locked || !(contact.email.trim() || contact.phone.trim())}
            onClick={() => run(() => endorseContact(policyId, { email: contact.email.trim() || undefined, phone: contact.phone.trim() || undefined }), "Contact endorsement applied.")}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">Save contact</button>
        </div>
      </IssueDropdown>

      {/* 3 — Sum-assured change */}
      <IssueDropdown title="Sum-assured change" badge={fmtCoverage(ov.sum_assured)}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M12 1v22" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>}>
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500">Current: <b>{fmtCoverage(ov.sum_assured)}</b>. A change re-prices the premium.</p>
          <div className="flex gap-2 items-center">
            <input type="number" value={newSum} onChange={(e) => setNewSum(e.target.value)} placeholder="New sum assured (PKR)"
              className="flex-1 text-xs border border-slate-200 rounded-lg px-2.5 py-2" />
            <button disabled={locked || !newSum || Number(newSum) === ov.sum_assured || Number(newSum) <= 0}
              onClick={() => run(() => endorseSumAssured(policyId, Number(newSum)), "Sum-assured endorsement applied — premium re-priced.")}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 whitespace-nowrap">Apply change</button>
          </div>
          {/* Live re-quote preview — premium impact before applying */}
          {quote && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2.5 grid grid-cols-3 gap-2 text-center">
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Current</p><p className="text-sm font-semibold text-slate-700 mt-0.5">{fmtPKR(quote.current_premium)}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">New</p><p className="text-sm font-bold text-blue-700 mt-0.5">{fmtPKR(quote.new_premium)}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Change</p><p className={`text-sm font-bold mt-0.5 ${quote.delta > 0 ? "text-amber-600" : "text-blue-700"}`}>{quote.delta > 0 ? "+" : ""}{fmtPKR(quote.delta)}/yr</p></div>
            </div>
          )}
        </div>
      </IssueDropdown>

      {/* 4 — Riders */}
      <IssueDropdown title="Riders" badge={ov.riders.length}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M12 2l3 7h7l-5.5 4 2 7L12 17l-6.5 3 2-7L2 9h7z" /></svg>}>
        <div className="space-y-3">
          {ov.riders.length === 0 ? (
            <p className="text-xs text-slate-400 italic">No riders attached.</p>
          ) : (
            <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
              {ov.riders.map((r) => (
                <div key={r.id} className="flex items-center justify-between px-3 py-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{r.name}</p>
                    <p className="text-[11px] text-slate-400">{fmtCoverage(r.sum_assured)} cover · {fmtPKR(r.annual_premium)}/yr</p>
                  </div>
                  <button disabled={locked} onClick={() => run(() => endorseRider(policyId, { action: "remove", rider_id: r.id }), `Rider "${r.name}" removed.`)}
                    className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-40">Remove</button>
                </div>
              ))}
            </div>
          )}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
            <p className="text-[11px] font-semibold text-slate-500">Add a rider</p>
            <div className="flex gap-2">
              <select 
                value={rider.name} 
                onChange={(e) => setRider({ ...rider, name: e.target.value })} 
                className="flex-1 text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-colors"
              >
                <option value="" disabled>Select Adamjee standard rider...</option>
                <option value="Accidental Death Benefit (ADB)">Accidental Death Benefit (ADB)</option>
                <option value="Accidental Death & Disability (ADD)">Accidental Death & Disability (ADD)</option>
                <option value="Waiver of Premium (WOP)">Waiver of Premium (WOP)</option>
                <option value="Critical Illness (CI)">Critical Illness (CI)</option>
                <option value="Hospital Cash Cover">Hospital Cash Cover</option>
                <option value="Family Income Benefit (FIB)">Family Income Benefit (FIB)</option>
                <option value="Level Term Rider">Level Term Rider</option>
              </select>
              <input type="number" value={rider.sum_assured} onChange={(e) => setRider({ ...rider, sum_assured: e.target.value })} placeholder="Sum assured" className="w-36 text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white" />
            </div>
            <button disabled={locked || !rider.name}
              onClick={() => run(() => endorseRider(policyId, { action: "add", name: rider.name, sum_assured: rider.sum_assured ? Number(rider.sum_assured) : undefined }).then(() => setRider({ name: "", sum_assured: "" })), `Rider "${rider.name}" added.`)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">Add rider</button>
          </div>
        </div>
      </IssueDropdown>

      {/* 5 — Endorsement history */}
      <IssueDropdown title="Endorsement history" badge={ov.history.length}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>}>
        {ov.history.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No endorsements yet.</p>
        ) : (
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {ov.history.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-700 truncate">
                    <span className="text-blue-700">{e.endorsement_no}</span> · {e.type}
                    {Math.abs(e.premium_delta) > 0.005 && <span className={e.premium_delta > 0 ? "text-amber-600" : "text-blue-600"}> · {e.premium_delta > 0 ? "+" : ""}{fmtPKR(e.premium_delta)}/yr</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate">{e.summary} · {e.effective_date}</p>
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  <a href={endorsementDocUrl(policyId, e.id)} target="_blank" rel="noreferrer" className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-blue-200 text-blue-700 hover:bg-blue-50">Letter</a>
                  <button disabled={emailingId === e.id}
                    onClick={async () => {
                      setEmailingId(e.id); setErr(null);
                      try { const r = await emailEndorsement(policyId, e.id); notify(`Endorsement emailed to ${r.sent_to}.`, true); }
                      catch (er: any) { setErr(er?.response?.data?.detail ?? "Failed to email endorsement"); }
                      finally { setEmailingId(null); }
                    }}
                    className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                    {emailingId === e.id ? "…" : "Email"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </IssueDropdown>
    </div>
  );
}

function ComingSoon({ step }: Readonly<{ step: StageBStep }>) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-16 px-6">
      <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 mb-4">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-6 h-6">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
      </span>
      <p className="text-base font-semibold text-slate-600">{step.title}</p>
      <p className="text-sm text-slate-400 mt-1 max-w-sm">{step.blurb}</p>
      <span className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-400 bg-slate-100 border border-slate-200 rounded-full px-3 py-1">
        Coming soon
      </span>
    </div>
  );
}

function JourneyAccordion({
  title, icon, isOpen, onToggle, children,
}: Readonly<{ title: string; icon: React.ReactNode; isOpen: boolean; onToggle: () => void; children: React.ReactNode }>) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border transition-all duration-300 ${isOpen ? "border-blue-200 bg-white shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 shadow-sm"}`}>
      <button
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-50/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-8 h-8 rounded-full ${isOpen ? "bg-blue-50 text-blue-600 border border-blue-100" : "bg-slate-50 text-slate-500 border border-slate-100"} shadow-sm transition-colors`}>
            {icon}
          </div>
          <p className="text-sm font-bold text-slate-800 tracking-tight">{title}</p>
        </div>
        <div className={`transform transition-transform duration-300 ${isOpen ? "rotate-180 text-blue-500" : "text-slate-400"}`}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      <div className={`overflow-hidden transition-all duration-300 ${isOpen ? "max-h-[3000px] opacity-100" : "max-h-0 opacity-0"}`}>
        <div className="px-6 pb-6 pt-2 relative z-10">
          <div className="pt-4 border-t border-slate-100">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function JourneyModal({
  detail, onClose,
}: Readonly<{ detail: PolicyDetail; onClose: () => void }>) {
  const [openSection, setOpenSection] = useState<string>("identity");

  const getLeadId = () => {
    if (!detail.customer?.created_at) return "IND-0000-001";
    const dt = new Date(detail.customer.created_at);
    const yymm = `${dt.getFullYear().toString().slice(-2)}${(dt.getMonth() + 1).toString().padStart(2, "0")}`;
    const hash = parseInt(detail.customer_id.substring(0, 4), 16);
    const seq = (hash % 999) + 1;
    return `IND-${yymm}-${seq.toString().padStart(3, "0")}`;
  };


  const InfoItem = ({ label, value, font = "sans", truncate = false }: { label: string, value: string | number | null | undefined, font?: "sans" | "mono", truncate?: boolean }) => (
    <div>
      <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">{label}</p>
      <p className={`text-sm mt-0.5 text-slate-800 ${font === "mono" ? "font-mono font-medium" : "font-medium"} ${truncate ? "truncate" : ""}`} title={truncate && typeof value === 'string' ? value : undefined}>
        {value || "—"}
      </p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden border border-slate-200 transform transition-all">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 text-blue-600 shadow-sm">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </span>
            <div>
              <h3 className="text-base font-bold text-slate-900 tracking-tight">Lead Information</h3>
              <p className="text-[11px] text-slate-500 font-medium mt-0.5">{detail.customer_name} — Comprehensive View</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-200/50 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 bg-slate-50/50">
          <div className="w-full space-y-4">

            {/* Identity & Contact Accordion */}
            <JourneyAccordion
              title="Identity & Contact"
              icon={<svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}
              isOpen={openSection === "identity"}
              onToggle={() => setOpenSection(openSection === "identity" ? "" : "identity")}
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-6 gap-x-4">
                <InfoItem label="Full Name" value={detail.customer_name} />
                <InfoItem label="CNIC" value={detail.customer?.cnic} font="mono" />
                <InfoItem label="Date of Birth" value={detail.customer?.dob} />
                <InfoItem label="Gender" value={detail.customer?.gender} />
                <InfoItem label="Marital Status" value={detail.customer?.marital_status} />
                <InfoItem label="Phone" value={detail.customer?.phone} />
                <div className="col-span-2 sm:col-span-3">
                  <InfoItem label="Email" value={detail.customer?.email} />
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <InfoItem label="Location" value={[detail.customer?.city, detail.customer?.province].filter(Boolean).join(", ")} />
                </div>
              </div>
            </JourneyAccordion>

            {/* Underwriting & Policy Accordion */}
            <JourneyAccordion
              title="Underwriting & Policy"
              icon={<svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}
              isOpen={openSection === "policy"}
              onToggle={() => setOpenSection(openSection === "policy" ? "" : "policy")}
            >
              <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Lead ID</p>
                  <div className="mt-1">
                    <span className="text-xs font-mono font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-100">{getLeadId()}</span>
                  </div>
                </div>
                <InfoItem label="Policyholder ID" value={detail.customer?.policyholder_id} font="mono" />
                <InfoItem label="Case Number" value={detail.case_number} font="mono" />

                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Case Status</p>
                  <div className="mt-1">
                    {detail.case_status ? (
                      <span className="text-[10px] bg-amber-100 text-amber-700 font-bold px-2 py-0.5 rounded-full">{detail.case_status}</span>
                    ) : <span className="text-sm text-slate-400">—</span>}
                  </div>
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <InfoItem label="Insurance Type" value={detail.insurance_type.replace(/_/g, " ")} />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <InfoItem label="Product & Term" value={`${detail.product_name} (${detail.term_years} years)`} />
                </div>
                <InfoItem label="Sum Assured" value={fmtPKR(detail.coverage_amount)} />
                <InfoItem label="Current Status" value={detail.status} />
              </div>
            </JourneyAccordion>

            {/* Socio-Economic & Health Accordion */}
            <JourneyAccordion
              title="Socio-Economic & Health"
              icon={<svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" /></svg>}
              isOpen={openSection === "socio"}
              onToggle={() => setOpenSection(openSection === "socio" ? "" : "socio")}
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-6 gap-x-4">
                <InfoItem label="Occupation" value={detail.customer?.occupation} />
                <InfoItem label="Declared Income" value={detail.customer?.declared_income ? fmtPKR(detail.customer.declared_income) : null} />
                <InfoItem label="Smoker Status" value={detail.customer?.is_smoker === true ? "Yes" : detail.customer?.is_smoker === false ? "No" : null} />
                <InfoItem label="Height" value={detail.customer?.height_cm ? `${detail.customer.height_cm} cm` : null} />
                <InfoItem label="Weight" value={detail.customer?.weight_kg ? `${detail.customer.weight_kg} kg` : null} />
              </div>
            </JourneyAccordion>

            {/* Beneficiaries & Dependents Accordion */}
            {(detail.nominee_name || detail.dependent_name) && (
              <JourneyAccordion
                title="Beneficiaries & Dependents"
                icon={<svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>}
                isOpen={openSection === "beneficiaries"}
                onToggle={() => setOpenSection(openSection === "beneficiaries" ? "" : "beneficiaries")}
              >
                <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                  {detail.nominee_name && (
                    <>
                      <InfoItem label="Nominee Name" value={detail.nominee_name} />
                      <InfoItem label="Nominee Relation" value={detail.nominee_relationship} />
                    </>
                  )}
                  {detail.dependent_name && (
                    <>
                      <InfoItem label="Dependent Name" value={detail.dependent_name} />
                      <InfoItem label="Dependent DOB" value={detail.dependent_dob} />
                    </>
                  )}
                </div>
              </JourneyAccordion>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
