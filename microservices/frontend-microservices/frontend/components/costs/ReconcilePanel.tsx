"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { RECON_LABEL, addStatement, getCertainty, getStatement, listStatements, money, percent, reconcileStatement, COMPONENT_LABEL,
  type CertaintyWindow, type Reconciliation, type Statement, type StatementDetail, type StatementIn } from "@/lib/evalCosts";
import { useQueryState } from "@/lib/useQueryState";
import { Badge, Drawer, Field, Modal, Notice, RECON_TONE, btnGhost, btnPrimary, card, day, inputCls, shortId, when } from "./ui";

type Fmt = (usd: number | null | undefined) => string;
const PROVIDERS = ["openai", "anthropic", "gemini"];

export function StatementForm({ replaces, onClose, onSaved }: { replaces?: Statement | StatementDetail | null; onClose: () => void; onSaved: (r: { statement: Statement; reconciliation: Reconciliation; scope_note: string }) => void }) {
  const [provider, setProvider] = useState(replaces?.provider ?? "openai");
  const [start, setStart] = useState(replaces?.period_start ?? "");
  const [end, setEnd] = useState(replaces?.period_end ?? "");
  const [billed, setBilled] = useState(replaces ? String(replaces.billed_usd) : "");
  const [reference, setReference] = useState("");
  const [source, setSource] = useState("");
  const [tin, setTin] = useState(replaces?.billed_tokens.input?.toString() ?? "");
  const [tout, setTout] = useState(replaces?.billed_tokens.output?.toString() ?? "");
  const [tcached, setTcached] = useState(replaces?.billed_tokens.cached?.toString() ?? "");
  const [tolPct, setTolPct] = useState(replaces ? String(replaces.tolerance_pct) : "5");
  const [tolUsd, setTolUsd] = useState(replaces ? String(replaces.tolerance_usd) : "0.05");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const int = (s: string) => (s.trim() === "" ? undefined : Number(s.replace(/,/g, "")));
  const problems = [
    !start || !end ? tx("Choose the first and last day of the period.") : end < start ? tx("The period cannot end before it starts.") : null,
    !(Number(billed) >= 0) || billed.trim() === "" ? tx("Enter what the provider billed, in US dollars.") : null,
    !source.trim() ? tx("Say where the figure came from.") : null,
    [tin, tout, tcached].some((t) => t.trim() !== "" && !(int(t)! >= 0)) ? tx("Token totals are whole numbers.") : null,
  ].filter(Boolean) as string[];
  async function save() {
    setBusy(true);
    setError(null);
    const body: StatementIn = { provider, period_start: start, period_end: end, billed_usd: Number(billed), reference: reference.trim() || undefined, source: source.trim(), billed_input_tokens: int(tin), billed_output_tokens: int(tout),
      billed_cached_tokens: int(tcached), tolerance_pct: Number(tolPct), tolerance_usd: Number(tolUsd), supersedes_id: replaces?.id, note: note.trim() || undefined };
    try {
      onSaved(await addStatement(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The bill could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={replaces ? tx("Replace a bill with a correction") : tx("Enter what a provider billed")} onClose={onClose} wide>
      <Notice kind="info">{tx("Enter the figure for the API key or project that evaluations use. A key other callers also use will always show more billed than was recorded, and that gap is not missing attribution.")}</Notice>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tx("Provider")}><select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!!replaces} data-testid="stmt-provider">{PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
        <Field label={tx("Billed (US dollars)")}><input className={inputCls} inputMode="decimal" value={billed} onChange={(e) => setBilled(e.target.value)} data-testid="stmt-billed" /></Field>
        <Field label={tx("First day")}><input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} data-testid="stmt-start" /></Field>
        <Field label={tx("Last day (included)")}><input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} data-testid="stmt-end" /></Field>
      </div>
      <Field label={tx("Where the figure came from (required)")} hint={tx("For example: typed from the OpenAI usage page, project 'evaluation', 1 to 31 October.")}><textarea className={inputCls} rows={2} value={source} onChange={(e) => setSource(e.target.value)} data-testid="stmt-source" /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={tx("Input tokens (optional)")}><input className={inputCls} inputMode="numeric" value={tin} onChange={(e) => setTin(e.target.value)} /></Field>
        <Field label={tx("Output tokens (optional)")}><input className={inputCls} inputMode="numeric" value={tout} onChange={(e) => setTout(e.target.value)} /></Field>
        <Field label={tx("Cached tokens (optional)")}><input className={inputCls} inputMode="numeric" value={tcached} onChange={(e) => setTcached(e.target.value)} /></Field>
      </div>
      <p className="text-[10px] text-slate-400">{tx("With token totals, a difference can be told apart: tokens that agree while dollars differ point to the prices; tokens the provider counted and we did not point to missing attribution.")}</p>
      <details className="text-xs text-slate-600"><summary className="cursor-pointer font-semibold">{tx("Tolerance and reference")}</summary>
        <div className="grid gap-3 sm:grid-cols-3 mt-2">
          <Field label={tx("Match within (%)")}><input className={inputCls} inputMode="decimal" value={tolPct} onChange={(e) => setTolPct(e.target.value)} /></Field>
          <Field label={tx("…but never less than (USD)")}><input className={inputCls} inputMode="decimal" value={tolUsd} onChange={(e) => setTolUsd(e.target.value)} /></Field>
          <Field label={tx("Invoice number or export name")}><input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
      </details>
      <Field label={tx("Note (optional)")}><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {error && <Notice>{error}</Notice>}
      {problems.length > 0 && (billed !== "" || source !== "") && <Notice kind="warn">{problems.join(" ")}</Notice>}
      <div className="flex justify-end gap-2"><button type="button" className={btnGhost} onClick={onClose}>{tx("Cancel")}</button>
        <button type="button" className={btnPrimary} disabled={busy || problems.length > 0} onClick={save} data-testid="stmt-save">{tx("Save and reconcile")}</button></div>
    </Modal>
  );
}

export function TokenTable({ tokens }: { tokens: NonNullable<Reconciliation["tokens"]> }) {
  const rows = (["input", "output", "cached"] as const).filter((k) => typeof tokens[k] === "object");
  if (rows.length === 0) return null;
  return (
    <table className="w-full text-[11px]" data-testid="token-table">
      <thead><tr className="text-left text-slate-400"><th className="font-semibold py-1">{tx("Tokens")}</th><th className="font-semibold text-right">{tx("Provider counted")}</th><th className="font-semibold text-right">{tx("Recorded")}</th><th className="font-semibold text-right">{tx("Difference")}</th><th /></tr></thead>
      <tbody>{rows.map((k) => { const t = tokens[k] as { billed: number; recorded: number; difference: number; difference_pct: number; matches: boolean };
        return <tr key={k} className="border-t border-slate-100"><td className="py-1 capitalize">{tx(k)}</td><td className="text-right">{t.billed.toLocaleString()}</td><td className="text-right">{t.recorded.toLocaleString()}</td>
          <td className="text-right">{t.difference.toLocaleString()} ({t.difference_pct.toFixed(1)}%)</td><td className="pl-2">{t.matches ? <Badge tone="green">{tx("agree")}</Badge> : <Badge tone="amber">{tx("differ")}</Badge>}</td></tr>; })}</tbody>
    </table>
  );
}

export function CertaintyCard({ w, fmt }: { w: CertaintyWindow; fmt: Fmt }) {
  const t = w.totals;
  return (
    <section className={card} data-testid="certainty-window">
      <h2 className="text-sm font-bold text-slate-900">{tx("How sure is the money, last 90 days")}</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-3 text-xs">
        <div><div className="font-semibold text-emerald-700">{tx("Confirmed")}</div><div className="text-lg font-bold" data-testid="w-confirmed">{fmt(t.confirmed_usd)}</div><p className="text-[10px] text-slate-400">{tx(w.meaning.confirmed)}</p></div>
        <div><div className="font-semibold text-blue-700">{tx("Estimated")}</div><div className="text-lg font-bold" data-testid="w-estimated">{fmt(t.estimated_usd)}</div><p className="text-[10px] text-slate-400">{tx(w.meaning.estimated)}</p></div>
        <div><div className="font-semibold text-amber-700">{tx("Unknown")}</div><div className="text-lg font-bold">{t.unknown_lines} {tx("line(s)")}</div><p className="text-[10px] text-slate-400">{tx(w.meaning.unknown)}</p></div>
      </div>
      {Object.entries(w.by_provider).filter(([p]) => p !== "mock").length > 0 && (
        <ul className="mt-3 text-[11px] text-slate-600 space-y-0.5">{Object.entries(w.by_provider).filter(([p]) => p !== "mock").map(([p, v]) => <li key={p}><b>{p}</b>: {fmt(v.confirmed_usd)} {tx("confirmed")}, {fmt(v.estimated_usd)} {tx("estimated")}{v.unknown_lines ? `, ${v.unknown_lines} ${tx("unknown")}` : ""}</li>)}</ul>
      )}
    </section>
  );
}

export function StatementsView({ statements, scopeNote, certainty, fmt, onOpen, onAdd }: { statements: Statement[]; scopeNote: string; certainty: CertaintyWindow | null; fmt: Fmt; onOpen: (id: string) => void; onAdd: () => void }) {
  return (
    <div className="space-y-4" data-testid="reconcile-view">
      <Notice kind="info">{scopeNote}</Notice>
      {certainty && <CertaintyCard w={certainty} fmt={fmt} />}
      <section className={`${card} overflow-x-auto`}>
        <div className="flex items-center justify-between gap-2 mb-2"><h2 className="text-sm font-bold text-slate-900">{tx("Provider bills")}</h2><button type="button" className={btnPrimary} onClick={onAdd} data-testid="add-statement">{tx("Enter a bill")}</button></div>
        <table className="w-full text-xs" data-testid="statements-table">
          <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="py-1.5 font-semibold">{tx("Provider")}</th><th className="font-semibold">{tx("Period")}</th><th className="font-semibold text-right">{tx("Billed")}</th><th className="font-semibold text-right">{tx("Recorded")}</th><th className="font-semibold text-right">{tx("Difference")}</th><th className="font-semibold pl-3">{tx("Result")}</th><th className="font-semibold">{tx("Reference")}</th></tr></thead>
          <tbody>
            {statements.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-slate-400">{tx("No bill has been entered. Until one is, every figure is an estimate.")}</td></tr>}
            {statements.map((s) => (
              <tr key={s.id} className={`border-t border-slate-100 cursor-pointer hover:bg-blue-50/40 ${s.superseded ? "opacity-50" : ""}`} onClick={() => onOpen(s.id)} data-testid="statement-row">
                <td className="py-2 font-semibold text-slate-800">{s.provider}</td><td>{s.period_start} → {s.period_end}</td><td className="text-right">{fmt(s.billed_usd)}</td>
                <td className="text-right">{s.live ? fmt(s.live.recorded_usd) : "—"}</td><td className="text-right">{s.live ? `${s.live.difference_usd >= 0 ? "+" : "−"}${fmt(Math.abs(s.live.difference_usd))}` : "—"}</td>
                <td className="pl-3">{s.superseded ? <Badge>{tx("replaced")}</Badge> : s.live ? <Badge tone={RECON_TONE[s.live.status]}>{tx(RECON_LABEL[s.live.status])}</Badge> : null}</td><td className="text-slate-500">{s.reference ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function StatementDetailView({ d, live, fmt }: { d: StatementDetail; live: Reconciliation | null; fmt: Fmt }) {
  return (
    <div className="space-y-4 text-xs" data-testid="statement-detail">
      <div className="flex flex-wrap items-center gap-2">{d.superseded ? <Badge>{tx("replaced by a later bill")}</Badge> : live ? <Badge tone={RECON_TONE[live.status]}>{tx(RECON_LABEL[live.status])}</Badge> : null}
        <span className="text-slate-500">{d.period_start} → {d.period_end} · {d.reference ?? tx("no reference")}</span></div>
      <p className="text-slate-500">{tx("Entered")} {when(d.created_at)} {tx("by")} {shortId(d.entered_by)}: {d.source}</p>
      {live && (
        <>
          <dl className="grid grid-cols-3 gap-3"><div><dt className="text-slate-400">{tx("Billed")}</dt><dd className="text-lg font-bold">{fmt(live.billed_usd)}</dd></div>
            <div><dt className="text-slate-400">{tx("Recorded")}</dt><dd className="text-lg font-bold">{fmt(live.recorded_usd)}</dd></div>
            <div><dt className="text-slate-400">{tx("Difference")}</dt><dd className="text-lg font-bold" data-testid="difference">{live.difference_usd >= 0 ? "+" : "−"}{fmt(Math.abs(live.difference_usd))} ({live.difference_pct}%)</dd></div></dl>
          <p className="text-[11px] text-slate-500">{tx("Allowed to differ")}: {fmt(live.allowed_usd)} ({live.tolerance_pct}% {tx("of the bill, never less than")} {money(live.tolerance_usd)}). {live.unknown_lines > 0 ? `${live.unknown_lines} ${tx("recorded line(s) could not be priced.")}` : ""}</p>
          <ul className="list-disc pl-4 space-y-1 text-slate-700" data-testid="explanation">{live.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
          {live.tokens && <TokenTable tokens={live.tokens} />}
          <div><h3 className="font-bold text-slate-800 mb-1">{tx("What was recorded in the period, by what it paid for")}</h3>
            <ul className="space-y-0.5">{Object.entries(live.recorded.by_component).sort((a, b) => b[1].usd - a[1].usd).map(([c, v]) => <li key={c} className="flex justify-between"><span>{tx(COMPONENT_LABEL[c] ?? c)} <span className="text-slate-400">({v.lines})</span></span><b>{fmt(v.usd)}</b></li>)}</ul></div>
          {live.recorded.top_runs.length > 0 && (
            <div><h3 className="font-bold text-slate-800 mb-1">{tx("Biggest runs in the period")}</h3>
              <ul className="space-y-0.5">{live.recorded.top_runs.slice(0, 5).map((r) => <li key={r.run_id} className="flex justify-between"><Link className="text-blue-600 hover:underline font-mono text-[10px]" href={`/super-admin/evaluation?tool=costs&view=usage&run=${encodeURIComponent(r.run_id)}`}>{r.run_id}</Link><b>{fmt(r.usd)}</b></li>)}</ul></div>
          )}
        </>
      )}
      <div><h3 className="font-bold text-slate-800 mb-1">{tx("Every time it was reconciled")}</h3>
        <ul className="space-y-1.5" data-testid="recon-history">{d.reconciliations.map((r) => <li key={r.id} className="rounded-lg border border-slate-200 p-2"><div className="flex flex-wrap items-center gap-2"><Badge tone={RECON_TONE[r.status]}>{tx(RECON_LABEL[r.status])}</Badge><span className="text-slate-500">{when(r.at)} · {shortId(r.by)}</span></div>
          <p className="mt-1 text-slate-600">{tx("recorded")} {fmt(r.recorded_usd)} {tx("against")} {fmt(r.billed_usd)}{r.note ? ` — “${r.note}”` : ""}</p></li>)}</ul></div>
    </div>
  );
}

export default function ReconcilePanel({ fmt, onChanged, refreshKey }: { fmt: Fmt; onChanged: () => void; refreshKey: number }) {
  const [list, setList] = useState<Statement[] | null>(null);
  const [scope, setScope] = useState("");
  const [cert, setCert] = useState<CertaintyWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useQueryState("statement");
  const [detail, setDetail] = useState<StatementDetail | null>(null);
  const [live, setLive] = useState<Reconciliation | null>(null);
  const [adding, setAdding] = useState<Statement | StatementDetail | null | "new">(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const load = useCallback(() => {
    const to = new Date(), from = new Date(Date.now() - 90 * 86400000);
    return Promise.all([listStatements(), getCertainty(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10))]).then(([s, c]) => { setList(s.statements); setScope(s.scope_note); setCert(c); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the bills."));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!openId) { setDetail(null); setLive(null); return; }
    getStatement(openId).then((d) => { setDetail(d); setLive(d.live); }).catch((e) => setError(e instanceof Error ? e.message : "Could not open the bill."));
  }, [openId, list]);
  async function reconcile() {
    if (!detail) return;
    setBusy(true);
    try { const r = await reconcileStatement(detail.id, note); setResult(`${tx(RECON_LABEL[r.status])}: ${r.explanation[0]}`); setAsking(false); setNote(""); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Reconciling failed."); } finally { setBusy(false); }
  }
  if (error && !list) return <Notice>{error}</Notice>;
  if (!list) return <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>;
  return (
    <>
      {error && <div className="mb-3"><Notice>{error}</Notice></div>}
      {result && <div className="mb-3"><Notice kind="ok">{result}</Notice></div>}
      <StatementsView statements={list} scopeNote={scope} certainty={cert} fmt={fmt} onOpen={(id) => { setResult(null); setOpenId(id); }} onAdd={() => { setResult(null); setAdding("new"); }} />
      {openId && detail && (
        <Drawer title={`${detail.provider} · ${day(detail.period_start)} – ${day(detail.period_end)}`} onClose={() => setOpenId("")}>
          <StatementDetailView d={detail} live={live} fmt={fmt} />
          {!detail.superseded && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} onClick={() => setAsking(true)} data-testid="reconcile-again">{tx("Reconcile again")}</button>
              <button type="button" className={btnGhost} onClick={() => setAdding(detail)} data-testid="replace-statement">{tx("Replace with a correction")}</button>
            </div>
          )}
        </Drawer>
      )}
      {asking && (
        <Modal title={tx("Reconcile again")} onClose={() => setAsking(false)}>
          <p className="text-xs text-slate-600">{tx("Compares the bill with what is recorded now (new runs may have been added) and keeps who looked and what you say about it.")}</p>
          <Field label={tx("Note (optional): what explains a difference")}><textarea className={inputCls} rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="recon-note" /></Field>
          <div className="flex justify-end gap-2"><button type="button" className={btnGhost} onClick={() => setAsking(false)}>{tx("Cancel")}</button><button type="button" className={btnPrimary} disabled={busy} onClick={reconcile} data-testid="recon-submit">{tx("Reconcile")}</button></div>
        </Modal>
      )}
      {adding && <StatementForm replaces={adding === "new" ? null : adding} onClose={() => setAdding(null)}
        onSaved={(r) => { setAdding(null); setResult(`${tx(RECON_LABEL[r.reconciliation.status])}: ${r.reconciliation.explanation[0]}`); setOpenId(r.statement.id); load(); onChanged(); }} />}
    </>
  );
}
