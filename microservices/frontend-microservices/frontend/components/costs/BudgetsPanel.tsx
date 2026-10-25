"use client";

import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { getBudget, getBudgetHistory, setBudget, type BudgetChange, type BudgetPeriod, type BudgetStatus } from "@/lib/evalCosts";
import { BudgetBar, Field, Modal, Notice, btnGhost, btnPrimary, card, inputCls, shortId, when } from "./ui";

export function BudgetForm({ p, onClose, onSaved }: { p: BudgetPeriod; onClose: () => void; onSaved: () => void }) {
  const [limit, setLimit] = useState(p.limit_usd === null ? "" : String(p.limit_usd));
  const [warn, setWarn] = useState(String(p.warn_at_pct));
  const [enforce, setEnforce] = useState(p.enforce);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limitNum = limit.trim() === "" ? null : Number(limit);
  const problems = [
    limitNum !== null && (!Number.isFinite(limitNum) || limitNum < 0) ? tx("The limit is a positive amount in US dollars, or empty for no limit.") : null,
    !(Number(warn) >= 1 && Number(warn) <= 100) ? tx("The warning level is between 1 and 100 per cent.") : null,
    !reason.trim() ? tx("Say why the limit is changing: it stays in the history.") : null,
  ].filter(Boolean) as string[];
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setBudget(p.period, { limit_usd: limitNum, warn_at_pct: Number(warn), enforce, reason: reason.trim() });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The limit could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={p.period === "day" ? tx("Daily spending limit") : tx("Monthly spending limit")} onClose={onClose}>
      <Field label={tx("Limit (US dollars, UTC day or month)")} hint={tx("Leave empty for no limit. Only real-model spend counts: a scripted model costs nothing.")}>
        <input className={inputCls} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={tx("no limit")} data-testid="budget-limit" />
      </Field>
      <Field label={tx("Warn when this much of the limit would be used (%)")}><input className={inputCls} inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)} data-testid="budget-warn" /></Field>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={enforce} onChange={(e) => setEnforce(e.target.checked)} data-testid="budget-enforce" />
        <span><b>{tx("Stop scheduling at the limit.")}</b> {tx("A job whose estimate would take the spending past it is refused when it is requested. Unticked, passing it only shows a warning.")}</span>
      </label>
      <Field label={tx("Reason (required)")}><textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="budget-reason" /></Field>
      {error && <Notice>{error}</Notice>}
      {problems.length > 0 && reason !== "" && <Notice kind="warn">{problems.join(" ")}</Notice>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onClose}>{tx("Cancel")}</button>
        <button type="button" className={btnPrimary} disabled={busy || problems.length > 0} onClick={save} data-testid="budget-save">{tx("Save the limit")}</button>
      </div>
    </Modal>
  );
}

export function BudgetsView({ status, history, fmt, onEdit }: { status: BudgetStatus; history: BudgetChange[]; fmt: (usd: number | null | undefined) => string; onEdit: (p: BudgetPeriod) => void }) {
  return (
    <div className="space-y-4" data-testid="budgets-view">
      <Notice kind="info">{tx("A limit covers real-model spending in a UTC day or month: what finished runs cost, plus the estimates of jobs that are queued or running. When enforcement is on, a job that would take it past the limit is refused before it is scheduled. A free job (a scripted model) is never refused. Every change needs a reason and stays in the history below.")}</Notice>
      <div className="grid gap-4 md:grid-cols-2">
        {(["day", "month"] as const).map((k) => {
          const p = status.periods[k];
          return (
            <section key={k} className={card}>
              <h2 className="text-sm font-bold text-slate-900 mb-3">{k === "day" ? tx("Daily limit") : tx("Monthly limit")}</h2>
              <BudgetBar p={p} fmt={fmt} />
              <p className="mt-3 text-[11px] text-slate-500">{p.set_at ? `${tx("Set")} ${when(p.set_at)} ${tx("by")} ${shortId(p.set_by)}: “${p.reason}”` : tx("No limit has been set.")}</p>
              <button type="button" className={`${btnGhost} mt-3`} onClick={() => onEdit(p)} data-testid={`edit-${k}`}>{tx("Change this limit")}</button>
            </section>
          );
        })}
      </div>
      <section className={`${card} overflow-x-auto`}>
        <h2 className="text-sm font-bold text-slate-900 mb-2">{tx("History of limits")}</h2>
        <table className="w-full text-xs" data-testid="budget-history">
          <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="py-1.5 font-semibold">{tx("When")}</th><th className="font-semibold">{tx("Period")}</th><th className="font-semibold">{tx("Limit")}</th><th className="font-semibold">{tx("Enforced")}</th><th className="font-semibold">{tx("By")}</th><th className="font-semibold">{tx("Reason")}</th></tr></thead>
          <tbody>
            {history.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-slate-400">{tx("No limit has ever been set.")}</td></tr>}
            {history.map((h) => <tr key={h.id} className="border-t border-slate-100"><td className="py-1.5 whitespace-nowrap">{when(h.at)}</td><td>{h.period === "day" ? tx("daily") : tx("monthly")}</td><td>{h.limit_usd === null ? tx("removed") : fmt(h.limit_usd)}</td><td>{h.enforce ? tx("yes") : tx("warn only")}</td><td className="font-mono text-[10px]">{shortId(h.set_by)}</td><td className="text-slate-600">{h.reason}</td></tr>)}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default function BudgetsPanel({ fmt, onChanged, refreshKey }: { fmt: (usd: number | null | undefined) => string; onChanged: () => void; refreshKey: number }) {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [history, setHistory] = useState<BudgetChange[]>([]);
  const [editing, setEditing] = useState<BudgetPeriod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(() => Promise.all([getBudget(), getBudgetHistory()]).then(([s, h]) => { setStatus(s); setHistory(h); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the budgets.")), []);
  useEffect(() => { load(); }, [load, refreshKey]);
  if (error && !status) return <Notice>{error}</Notice>;
  if (!status) return <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>;
  return (
    <>
      {saved && <div className="mb-3"><Notice kind="ok">{tx("The limit was saved and is in the history.")}</Notice></div>}
      <BudgetsView status={status} history={history} fmt={fmt} onEdit={(p) => { setSaved(false); setEditing(p); }} />
      {editing && <BudgetForm p={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSaved(true); load(); onChanged(); }} />}
    </>
  );
}
