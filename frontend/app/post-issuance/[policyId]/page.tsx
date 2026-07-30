"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { getPolicyDetail, getPolicyEvents, fmtPKR, downloadDocument, type PolicyDetail, type PolicyDocument, type PolicyEvent } from "@/app/services/policies";
import {
  getFreeLookStatus, cancelWithinFreeLook,
  getOnboarding, assignPolicyholderId, generateWelcomeKit, welcomeKitDownloadUrl,
  provisionPortal, sendWelcome, acknowledgeOnboarding, setOnboardingContact, resetOnboarding,
  getBilling, collectInstallment, remindInstallment, waiveInstallment, runBillingMonitor, setAutopay, demoSeedPremiums,
  restructurePlan, getReminderHistory, receiptDownloadUrl, downloadLapseWarning,
  REMINDER_CHANNELS, REMINDER_TEMPLATES, BILLING_FREQUENCIES,
  type ReminderLog,
  type FreeLookStatus, type OnboardingStatus, type PortalCredentials,
  type BillingLedger, type Installment,
} from "@/app/services/postIssuance";
import { fmtCoverage } from "@/lib/mock-data";

// ─────────────────────────────────────────────────────────────────────────────
// Stage B roadmap — the canonical post-issuance journey. `live` steps are wired;
// the rest render a clean "coming soon" panel. Adding a future step = flip `live`
// and drop its panel into the switch in <StepPanel>.
// ─────────────────────────────────────────────────────────────────────────────

type StepId =
  | "free-look" | "onboarding" | "premiums" | "endorsements"
  | "reinstatement" | "renewals" | "claims" | "exit";

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
  { id: "endorsements", n: 4, title: "Policy Issuance", blurb: "Nominee, address, sum-assured & rider changes.", live: false },
  { id: "reinstatement", n: 5, title: "Reinstatement", blurb: "Revive a lapsed policy after arrears + underwriting.", live: false },
  { id: "renewals", n: 6, title: "Renewals", blurb: "Annual renewal via STP or manual referral.", live: false },
  { id: "claims", n: 7, title: "Claims Management", blurb: "Death, health and reimbursement claims.", live: false },
  { id: "exit", n: 8, title: "Policy Exit", blurb: "Maturity, surrender or death-benefit payout.", live: false },

];

const STATUS_TONE: Record<string, string> = {
  Active: "bg-emerald-50 text-emerald-700 border-emerald-200",
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
      ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white shadow-emerald-100/40"
      : "border-slate-200 bg-white shadow-sm hover:border-emerald-300"
      }`}>
      <div className={`absolute top-0 left-0 w-full h-1 transition-all duration-300 ${accent ? "bg-emerald-400" : "bg-transparent group-hover:bg-emerald-400"}`}></div>
      <p className={`text-[11px] uppercase tracking-widest font-bold mb-2 transition-colors duration-300 ${accent ? "text-emerald-600" : "text-slate-400 group-hover:text-emerald-600"
        }`}>{label}</p>
      <p className={`text-2xl font-black tracking-tight ${accent ? "text-emerald-900" : "text-slate-800"
        }`}>{value}</p>
      {hint && <p className="text-[12px] font-medium text-slate-500 mt-2">{hint}</p>}
    </div>
  );
}

function CountdownUnit({ value, label }: Readonly<{ value: number; label: string }>) {
  return (
    <div className="flex flex-col items-center">
      <span className="tabular-nums text-3xl font-bold text-emerald-700 bg-white border border-emerald-200 rounded-xl w-16 py-2 text-center shadow-sm">
        {String(value).padStart(2, "0")}
      </span>
      <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-600/70 mt-1.5">{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const PAY_CHANNELS = ["JazzCash", "Easypaisa", "Card", "BankTransfer", "Manual (offline)"];

const STATE_CHIP: Record<string, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  waived: { label: "Waived", cls: "bg-slate-100 text-slate-500 border-slate-200" },
  upcoming: { label: "Upcoming", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  due_soon: { label: "Due soon", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  due_today: { label: "Due today", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  grace: { label: "Overdue · grace", cls: "bg-orange-50 text-orange-700 border-orange-200" },
  past_grace: { label: "Past grace", cls: "bg-red-50 text-red-700 border-red-200" },
};

function PremiumCollectionPanel({
  policyId, billing, onChanged,
}: Readonly<{ policyId: string; billing: BillingLedger | null; onChanged: () => Promise<void> }>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [channel, setChannel] = useState("JazzCash");
  const [remChannel, setRemChannel] = useState<string>(REMINDER_CHANNELS[0]);
  const [remTemplate, setRemTemplate] = useState<string>(REMINDER_TEMPLATES[1]);
  const [freq, setFreq] = useState<string>("Quarterly");
  const [reminders, setReminders] = useState<ReminderLog[] | null>(null);
  const [openSecs, setOpenSecs] = useState<Set<string>>(() => new Set(["controls", "ledger"]));
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
    setBusy(true); setErr(null); setMsg(null);
    try {
      const result = await fn();
      await onChanged();
      if (openSecs.has("reminders")) setReminders(await getReminderHistory(policyId));
      if (note) setMsg(typeof note === "function" ? note(result) : note);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? e?.message ?? "Action failed"); }
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
      {msg && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs px-3 py-2 flex items-center justify-between gap-2">
          <span>✓ {msg}</span>
          <button onClick={() => setMsg(null)} className="text-emerald-500 hover:text-emerald-700">×</button>
        </div>
      )}

      {/* Collapsible sections — keep the page compact, expand what you need */}
      <JourneyAccordion title="Overview & dashboard" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>} isOpen={sec("overview")} onToggle={() => toggleSec("overview")}>
        <div className="space-y-4">
          {/* Collection dashboard */}
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Collection dashboard</p>
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                    <StatCard label="Collected (month)" value={fmtPKR(dash.collected_this_month)} accent />
                    <StatCard label="Total collected" value={fmtPKR(dash.total_collected)} />
                    <StatCard label="Overdue amount" value={fmtPKR(dash.overdue_amount)} hint={`${sum.arrears_count} arrear(s)`} />
                    <StatCard label="Collection rate" value={`${dash.collection_rate}%`} hint={`${sum.paid}/${sum.total} paid`} />
                    <StatCard label="Commission" value={fmtPKR(dash.commission_earned)} hint={`@ ${billing.commission_pct}%`} />
                  </div>
                </div>
          {/* Summary + autopay */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <StatCard label="Next due" value={sum.next_due_date ?? "—"} hint={sum.next_due_amount != null ? fmtPKR(sum.next_due_amount) : undefined} />
                  <StatCard label="Outstanding" value={fmtPKR(sum.total_outstanding)} hint={`${sum.outstanding_count} installment(s)`} accent={sum.total_outstanding > 0} />
                  <StatCard label="Surcharge" value={`${billing.surcharge_pct}%`} hint="on late payments" />
                  <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col justify-between">
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Auto-debit</p>
                    <button disabled={locked} onClick={() => run(() => setAutopay(policyId, !billing.autopay_enabled), (b) => `Auto-debit ${b.autopay_enabled ? "enabled" : "disabled"}.`)} className={`mt-1 inline-flex items-center gap-1.5 text-xs font-semibold ${billing.autopay_enabled ? "text-emerald-700" : "text-slate-500"}`}>
                      <span className={`w-8 h-4 rounded-full relative transition-colors ${billing.autopay_enabled ? "bg-emerald-500" : "bg-slate-300"}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${billing.autopay_enabled ? "left-4" : "left-0.5"}`} />
                      </span>
                      {billing.autopay_enabled ? "On" : "Off"}
                    </button>
                  </div>
                </div>
          {/* First premium card */}
                {firstPremium && (
                  <div className="rounded-xl border border-slate-200 bg-white p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${firstPremium.state === "paid" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{firstPremium.state === "paid" ? "✓" : "1"}</span>
                        <div>
                          <p className="text-sm font-bold text-slate-800">First Premium Collection</p>
                          <p className="text-[11px] text-slate-400">Taken at policy binding — activates cover.</p>
                        </div>
                      </div>
                      <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-semibold border ${(STATE_CHIP[firstPremium.state] ?? STATE_CHIP.upcoming).cls}`}>{firstPremium.state === "paid" ? "Collected" : (STATE_CHIP[firstPremium.state] ?? STATE_CHIP.upcoming).label}</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
                      <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Amount</p><p className="text-sm font-semibold text-slate-800 mt-0.5">{fmtPKR(firstPremium.amount_due)}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Due</p><p className="text-sm font-semibold text-slate-800 mt-0.5">{firstPremium.due_date}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Collected</p><p className="text-sm font-semibold text-slate-800 mt-0.5">{firstPremium.paid_at ? firstPremium.paid_at.slice(0, 10) : "—"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Receipt</p>
                        {firstPremium.receipt ? (
                          <a href={receiptDownloadUrl(policyId, firstPremium.receipt.id)} target="_blank" rel="noreferrer" className="text-sm font-semibold text-emerald-600 hover:text-emerald-700 mt-0.5 inline-block">{firstPremium.receipt.receipt_no}</a>
                        ) : <p className="text-sm text-slate-400 mt-0.5">—</p>}
                      </div>
                    </div>
                    {firstPremium.state !== "paid" && firstPremium.state !== "waived" && (
                      <button disabled={locked} onClick={() => run(() => collect(firstPremium.id), "First premium collected — receipt generated.")} className="mt-4 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40">Collect first premium</button>
                    )}
                  </div>
                )}
        </div>
      </JourneyAccordion>

      <JourneyAccordion title="Payment controls" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>} isOpen={sec("controls")} onToggle={() => toggleSec("controls")}>
        <div className="space-y-4">
          {/* Demo tools */}
                <div className="rounded-xl border border-dashed border-indigo-200 bg-indigo-50/40 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">Demo</span>
                    <span className="text-[11px] text-slate-500">Rebuild the schedule to test collection & grace:</span>
                    {([["healthy", "Healthy"], ["grace", "In grace"], ["lapse", "Past grace"]] as const).map(([id, label]) => (
                      <button key={id} disabled={busy} onClick={() => run(() => demoSeedPremiums(policyId, id), (b) => `Demo schedule loaded (${label}) — ${b.summary.outstanding_count} unpaid, ${b.summary.arrears_count} overdue. Now try Collect / Remind / Run grace monitor.`)} className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">{label}</button>
                    ))}
                  </div>
                </div>
          {/* Controls — three colour-coded, independent groups */}
                <div className="grid lg:grid-cols-3 gap-3">
                  {/* Group 1 — Collection (emerald) */}
                  <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/50 overflow-hidden">
                    <div className="flex items-center gap-2 bg-emerald-100/70 px-4 py-2 border-b border-emerald-200">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-emerald-600"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
                      <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">Collection</p>
                    </div>
                    <div className="p-4">
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">Payment channel</label>
                      <select value={channel} onChange={(e) => setChannel(e.target.value)}
                        className="w-full text-xs border border-emerald-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-200">
                        {PAY_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <p className="text-[10px] text-emerald-700/70 mt-1.5">Used when you click <b>Collect</b> on a row.</p>
                    </div>
                  </div>

                  {/* Group 2 — Reminders (sky) */}
                  <div className="rounded-xl border-2 border-sky-200 bg-sky-50/50 overflow-hidden">
                    <div className="flex items-center gap-2 bg-sky-100/70 px-4 py-2 border-b border-sky-200">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-sky-600"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
                      <p className="text-xs font-bold uppercase tracking-wider text-sky-700">Reminders</p>
                    </div>
                    <div className="p-4">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="block text-[11px] font-semibold text-slate-500 mb-1">Channel</label>
                          <select value={remChannel} onChange={(e) => setRemChannel(e.target.value)}
                            className="w-full text-xs border border-sky-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-sky-200">
                            {REMINDER_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="flex-1">
                          <label className="block text-[11px] font-semibold text-slate-500 mb-1">Tone</label>
                          <select value={remTemplate} onChange={(e) => setRemTemplate(e.target.value)}
                            className="w-full text-xs border border-sky-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-sky-200">
                            {REMINDER_TEMPLATES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                      </div>
                      <p className="text-[10px] text-sky-700/70 mt-1.5">Used when you click <b>Remind</b> on a row.</p>
                    </div>
                  </div>

                  {/* Group 3 — Billing plan (amber): self-contained Restructure */}
                  <div className="rounded-xl border-2 border-amber-200 bg-amber-50/50 overflow-hidden">
                    <div className="flex items-center gap-2 bg-amber-100/70 px-4 py-2 border-b border-amber-200">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-amber-600"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                      <p className="text-xs font-bold uppercase tracking-wider text-amber-700">Billing plan</p>
                    </div>
                    <div className="p-4">
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">Frequency</label>
                      <div className="flex gap-2">
                        <select value={freq} onChange={(e) => setFreq(e.target.value)}
                          className="flex-1 text-xs border border-amber-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-amber-200">
                          {BILLING_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                        <button disabled={locked}
                          onClick={() => run(() => restructurePlan(policyId, freq), (b) => `Plan restructured to ${freq} — ${b.summary.outstanding_count} upcoming installment(s).`)}
                          className="px-3 py-2 rounded-lg text-[11px] font-semibold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40 whitespace-nowrap">
                          Restructure
                        </button>
                      </div>
                      <p className="text-[10px] text-amber-700/70 mt-1.5">Applies immediately to the outstanding amount.</p>
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

      <JourneyAccordion title="Installment ledger" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>} isOpen={sec("ledger")} onToggle={() => toggleSec("ledger")}>
        {/* Ledger */}
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400 font-bold border-b border-slate-100">
                      <tr>
                        <th className="px-4 py-2.5">#</th>
                        <th className="px-4 py-2.5">Due date</th>
                        <th className="px-4 py-2.5 text-right">Payable</th>
                        <th className="px-4 py-2.5">Status</th>
                        <th className="px-4 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {rows.length === 0 ? (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400 text-xs">No installments — the next premium is created at renewal.</td></tr>
                      ) : rows.map((s) => {
                        const chip = STATE_CHIP[s.state] ?? STATE_CHIP.upcoming;
                        const collectable = s.state !== "paid" && s.state !== "waived";
                        return (
                          <tr key={s.id} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-2.5 font-semibold text-slate-800">#{s.installment_no}</td>
                            <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">
                              {s.due_date}
                              {collectable && s.days_until >= 0 && <span className="text-slate-400"> · in {s.days_until}d</span>}
                              {s.reminder_count > 0 && <span className="ml-1 text-[10px] text-slate-400">🔔{s.reminder_count}</span>}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-700">
                              {fmtPKR(collectable ? s.payable : s.amount_due)}
                              {s.surcharge > 0 && collectable && <span className="block text-[9px] text-orange-500">incl. {fmtPKR(s.surcharge)} surcharge</span>}
                            </td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${chip.cls}`}>{chip.label}</span>
                            </td>
                            <td className="px-4 py-2.5">
                              {collectable ? (
                                <div className="flex justify-end gap-1.5">
                                  <button disabled={locked} onClick={() => run(() => collect(s.id), `Installment #${s.installment_no} collected via ${channel}${s.surcharge > 0 ? " (incl. surcharge)" : ""} — receipt generated.`)} className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40">Collect</button>
                                  <button disabled={locked} onClick={() => run(() => remind(s), `Reminder sent for #${s.installment_no} via ${remChannel} (${remTemplate}).`)} className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">Remind</button>
                                  <button disabled={locked} onClick={() => run(() => waiveInstallment(policyId, s.id), `Installment #${s.installment_no} waived.`)} className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40">Waive</button>
                                </div>
                              ) : (
                                <div className="flex justify-end">
                                  {s.receipt ? (
                                    <a href={receiptDownloadUrl(policyId, s.receipt.id)} target="_blank" rel="noreferrer" className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50">Receipt</a>
                                  ) : <span className="text-[10px] text-slate-400">{s.paid_at ? s.paid_at.slice(0, 10) : "—"}</span>}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
      </JourneyAccordion>

      <JourneyAccordion title="Reminder history" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>} isOpen={sec("reminders")} onToggle={openReminders}>
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
        <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-emerald-500" />
      </div>
    );
  }

  const activeStep = STAGE_B_STEPS.find((s) => s.id === active)!;
  const liveCount = STAGE_B_STEPS.filter((s) => s.live).length;

  return (
    <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-8 space-y-6">
      {/* Breadcrumb + heading */}
      <div>
        <button onClick={goBack} className="text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-emerald-600 transition-colors inline-flex items-center gap-1.5 mb-2">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
          Back
        </button>
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mt-2">
          <div>
            <div className="inline-flex items-center gap-2 mb-2.5 px-3 py-1 rounded-md bg-emerald-50 border border-emerald-100 shadow-sm">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <p className="text-[10px] font-bold text-emerald-700 uppercase tracking-widest">Stage B · Policy Management</p>
            </div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight">{detail?.customer_name ?? "Policy"}</h1>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs font-bold font-mono text-slate-700 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200">{detail?.policy_number ?? "—"}</span>
              {detail?.product_name && <span className="text-sm font-semibold text-slate-500 px-1 border-l-2 border-slate-200 pl-3">{detail.product_name}</span>}
            </div>
          </div>
          {detail && (
            <div className="mt-1 md:mt-0 flex items-center gap-3">
              <Badge status={detail.status} />

              <div className="relative">
                <button
                  onClick={() => setActionsOpen(!actionsOpen)}
                  className="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-all shadow-sm"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                  </svg>
                </button>

                {actionsOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setActionsOpen(false)}></div>
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-lg border border-slate-200 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                      <button onClick={() => { setActionsOpen(false); setJourneyOpen(true); }} className="w-full text-left px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 hover:text-emerald-700 flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        View Details
                      </button>
                      <button onClick={() => { setActionsOpen(false); alert('Edit Policy - Coming soon'); }} className="w-full text-left px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 hover:text-indigo-700 flex items-center gap-2">
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
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3 flex items-center justify-between">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="text-emerald-500 hover:text-emerald-700">×</button>
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
            <span className="text-[10px] font-semibold text-emerald-600">{liveCount}/{STAGE_B_STEPS.length} live</span>
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
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-transparent hover:border-slate-200 hover:bg-slate-50"
                    }`}
                >
                  <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold flex-shrink-0 ${step.live ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"
                    }`}>
                    {step.n}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-semibold truncate ${isActive ? "text-emerald-800" : "text-slate-700"}`}>
                      {step.title}
                    </span>
                    <span className="block text-[11px] text-slate-400 truncate">{step.blurb}</span>
                  </span>
                  <span className={`text-[9px] font-semibold uppercase flex-shrink-0 ${step.live ? "text-emerald-600" : "text-slate-400"}`}>
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
              <span className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${activeStep.live ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"
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
              {active !== "free-look" && active !== "onboarding" && active !== "premiums" && (
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
            <span className="flex items-center justify-center w-6 h-6 rounded bg-emerald-100 text-emerald-600 shadow-sm">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </span>
            <h3 className="text-sm font-bold text-slate-800 tracking-tight">Policy Documents</h3>
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
                className="group relative overflow-hidden flex items-start gap-3 p-4 rounded-xl border border-slate-200 bg-white hover:border-emerald-300 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 text-left"
              >
                <div className="absolute top-0 left-0 w-1 h-full bg-emerald-400 scale-y-0 group-hover:scale-y-100 transition-transform origin-top"></div>
                <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg bg-slate-50 text-slate-400 group-hover:bg-emerald-50 group-hover:text-emerald-600 transition-colors border border-slate-100 group-hover:border-emerald-100">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <p className="text-sm font-bold text-slate-700 group-hover:text-emerald-800 truncate transition-colors">
                    {doc.document_name}
                  </p>
                  <p className="text-[11px] font-medium text-slate-400 mt-0.5 flex items-center gap-1.5">
                    PDF Document
                    <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                    <span className="text-slate-400 group-hover:text-emerald-600 font-semibold transition-colors">Click to download</span>
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
      <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-emerald-800">Free-look window is open</p>
            <p className="text-xs text-emerald-700/80 mt-1 max-w-md">
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
          <span className="text-3xl font-bold text-emerald-300 pb-7">:</span>
          <CountdownUnit value={countdown.hours} label="Hrs" />
          <span className="text-3xl font-bold text-emerald-300 pb-7">:</span>
          <CountdownUnit value={countdown.mins} label="Min" />
          <span className="text-3xl font-bold text-emerald-300 pb-7">:</span>
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
    <div className={`relative overflow-hidden rounded-2xl border transition-all duration-300 ${done ? "border-emerald-200 bg-gradient-to-br from-emerald-50/40 to-white shadow-sm" : "border-slate-200 bg-white shadow-sm"}`}>
      {done && (
        <div className="absolute top-0 right-0 -mt-4 -mr-4 w-24 h-24 bg-emerald-400 opacity-10 rounded-full blur-2xl pointer-events-none"></div>
      )}
      <button
        onClick={onToggle}
        className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-slate-50/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold shadow-sm ${done ? "bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-emerald-200" : "bg-slate-100 text-slate-500"}`}>
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
    emerald: "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-md shadow-emerald-200 hover:shadow-emerald-300",
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

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await onChanged(); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? e?.message ?? "Action failed"); }
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
              <div className="h-full bg-gradient-to-r from-emerald-400 to-teal-500 rounded-full transition-all duration-700 ease-out"
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
            ? "bg-gradient-to-r from-emerald-100 to-teal-100 text-emerald-800 border-emerald-200"
            : "bg-white text-amber-700 border-amber-200"
            }`}>
            {onboarding.status}
          </span>

          <button
            onClick={onOpenJourney}
            className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors ml-1 border border-transparent hover:border-emerald-200"
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
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-emerald-800">Portal credentials {creds.reset ? "reset" : "created"}</p>
            <button onClick={() => setCreds(null)} className="text-emerald-500 hover:text-emerald-700 text-sm">×</button>
          </div>
          <p className="text-[11px] text-emerald-700/80 mt-0.5">Shown once — copy and hand these to the policyholder now.</p>
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <div className="bg-white rounded-lg border border-emerald-200 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Username</p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-mono text-slate-800 truncate">{creds.username}</p>
                <button onClick={() => copy(creds.username)} className="text-[11px] text-emerald-600 hover:text-emerald-700 font-semibold">Copy</button>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-emerald-200 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Temporary password</p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-mono text-slate-800 truncate">{creds.temp_password}</p>
                <button onClick={() => copy(creds.temp_password)} className="text-[11px] text-emerald-600 hover:text-emerald-700 font-semibold">Copy</button>
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
              <div className="bg-white/50 rounded-lg p-2.5 border border-emerald-100/50">
                <p className="text-xs font-medium text-slate-700 truncate flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  {s.welcome_kit.name}
                </p>
              </div>
              <div className="flex gap-2.5 pt-1">
                <a href={welcomeKitDownloadUrl(policyId)} target="_blank" rel="noreferrer"
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-200 transition-all duration-200 inline-flex items-center gap-1.5">
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
                    className="w-full text-xs border border-slate-200 rounded-xl pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-slate-50 hover:bg-white" />
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                  </div>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number"
                    className="w-full text-xs border border-slate-200 rounded-xl pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-slate-50 hover:bg-white" />
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
        </AccordionCard>

        {/* 4 — Acknowledgment (optional) */}
        <AccordionCard n={4} title="Acknowledgment (optional)" done={s.acknowledged.done} isOpen={openStep === 4} onToggle={() => setOpenStep(openStep === 4 ? 0 : 4)}>
          {s.acknowledged.done ? (
            <p className="text-xs text-slate-600">Confirmed via {s.acknowledged.method} · {s.acknowledged.at?.slice(0, 10)}</p>
          ) : (
            <OnboardingBtn disabled={locked} onClick={() => run(() => acknowledgeOnboarding(policyId, { method: "Call" }))}>Mark acknowledged</OnboardingBtn>
          )}
        </AccordionCard>
      </div>

      {onboarding.completed && (
        <div className="relative overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50/50 p-5 flex items-center gap-4 shadow-sm mt-8">
          <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100/80 border border-emerald-200 shadow-sm">
            <svg className="w-6 h-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="relative z-10">
            <p className="text-sm font-bold text-emerald-900 tracking-tight">Onboarding Complete</p>
            <p className="text-xs font-medium text-emerald-700/80 mt-1">The policyholder is fully welcomed and set up in our systems.</p>
          </div>
          <div className="absolute top-0 right-0 w-48 h-48 bg-emerald-300 opacity-20 rounded-full blur-3xl transform translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>
        </div>
      )}
    </div>
  );
}

// ── Step 3+ placeholder ──────────────────────────────────────────────────────

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
    <div className={`relative overflow-hidden rounded-2xl border transition-all duration-300 ${isOpen ? "border-emerald-200 bg-white shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 shadow-sm"}`}>
      <button
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-50/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-8 h-8 rounded-full ${isOpen ? "bg-emerald-50 text-emerald-600 border border-emerald-100" : "bg-slate-50 text-slate-500 border border-slate-100"} shadow-sm transition-colors`}>
            {icon}
          </div>
          <p className="text-sm font-bold text-slate-800 tracking-tight">{title}</p>
        </div>
        <div className={`transform transition-transform duration-300 ${isOpen ? "rotate-180 text-emerald-500" : "text-slate-400"}`}>
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
            <span className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 shadow-sm">
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
              icon={<svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}
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
                    <span className="text-xs font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">{getLeadId()}</span>
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
              icon={<svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" /></svg>}
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
                icon={<svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>}
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
