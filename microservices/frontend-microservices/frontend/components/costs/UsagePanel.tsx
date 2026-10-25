"use client";

import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { COMPONENT_LABEL, csvDownload, getAttribution, linesToCsv, listLines, type Attribution, type CostLine, type Lines } from "@/lib/evalCosts";
import { useQueryState } from "@/lib/useQueryState";
import { Badge, KIND_TONE, Notice, btnGhost, card, inputCls, when } from "./ui";

const PAGE = 50;
const COMPONENTS = Object.keys(COMPONENT_LABEL);

export function LinesTable({ lines, fmt }: { lines: CostLine[]; fmt: (usd: number | null | undefined) => string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="lines-table">
        <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="py-1.5 font-semibold">{tx("When")}</th><th className="font-semibold">{tx("Run / case")}</th><th className="font-semibold">{tx("Paid for")}</th><th className="font-semibold">{tx("Model")}</th>
          <th className="font-semibold text-right">{tx("Tokens in / out / cached")}</th><th className="font-semibold text-right">{tx("Cost")}</th><th className="font-semibold">{tx("Kind")}</th></tr></thead>
        <tbody>
          {lines.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-slate-400">{tx("No usage records match.")}</td></tr>}
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-slate-100 align-top" title={l.source} data-testid="line-row">
              <td className="py-1.5 whitespace-nowrap text-slate-500">{when(l.incurred_at)}</td>
              <td className="text-slate-700"><span className="font-mono text-[10px]">{l.run_id}</span>{l.case_id ? <span className="block text-[10px] text-slate-400">{l.case_id} r{l.repetition}</span> : null}</td>
              <td>{tx(COMPONENT_LABEL[l.component] ?? l.component)}</td>
              <td className="text-slate-600">{l.model ?? <span className="text-slate-400">—</span>}{l.provider ? <span className="block text-[10px] text-slate-400">{l.provider}</span> : null}</td>
              <td className="text-right text-slate-600">{l.input_units.toLocaleString()} / {l.output_units.toLocaleString()} / {l.cached_units.toLocaleString()}</td>
              <td className="text-right font-semibold text-slate-800">{l.usd === null ? <span className="text-amber-600 font-normal">{tx("unknown")}</span> : fmt(l.usd)}</td>
              <td><Badge tone={KIND_TONE[l.cost_kind]}>{l.cost_kind}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-400 mt-2">{tx("Hover a row for where its number came from. An unknown cost is a call that could not be priced: it is in no total.")}</p>
    </div>
  );
}

export function AttributionView({ data }: { data: Attribution }) {
  const bad = data.runs.filter((r) => r.problems.length > 0);
  return (
    <div data-testid="attribution-result">
      {bad.length === 0
        ? <Notice kind="ok">{tx("All")} {data.checked} {tx("runs account for their spending exactly: their lines add up to what was recorded, hold every token the ledger showed, and nothing is recorded twice.")}</Notice>
        : <Notice>{bad.length} {tx("of")} {data.checked} {tx("runs have spending that does not add up")}:{"\n"}{bad.map((r) => `${r.run_id}: ${r.problems.join("; ")}`).join("\n")}</Notice>}
    </div>
  );
}

export default function UsagePanel({ fmt }: { fmt: (usd: number | null | undefined) => string }) {
  const [run, setRun] = useQueryState("run", "", { replace: true });
  const [component, setComponent] = useQueryState("component");
  const [provider, setProvider] = useQueryState("provider");
  const [kind, setKind] = useQueryState("kind");
  const [from, setFrom] = useQueryState("from");
  const [to, setTo] = useQueryState("to");
  const [page, setPage] = useQueryState("page", "0", { replace: true });
  const [data, setData] = useState<Lines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attr, setAttr] = useState<Attribution | null>(null);
  const [checking, setChecking] = useState(false);
  const offset = (Number(page) || 0) * PAGE;
  const filter = { run_id: run || undefined, component: component || undefined, provider: provider || undefined, kind: kind || undefined, from: from || undefined, to: to || undefined };
  const load = useCallback(() => listLines({ ...filter, limit: PAGE, offset }).then((d) => { setData(d); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the usage records.")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, component, provider, kind, from, to, offset]);
  useEffect(() => { load(); }, [load]);
  async function exportCsv() {
    const all = await listLines({ ...filter, limit: 1000, offset: 0 });
    csvDownload("evaluation-usage-records.csv", linesToCsv(all.lines));
  }
  async function check() {
    setChecking(true);
    try { setAttr(await getAttribution(run || undefined)); } catch (e) { setError(e instanceof Error ? e.message : "The check failed."); } finally { setChecking(false); }
  }
  const sel = "border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white";
  return (
    <div className="space-y-4" data-testid="usage-panel">
      <section className={card}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-slate-500">{tx("Run")}<input className={`${sel} block w-56`} value={run} onChange={(e) => { setRun(e.target.value); setPage("0"); }} placeholder="20261023T151632-33aaa7" /></label>
          <label className="text-[11px] text-slate-500">{tx("Paid for")}<select className={`${sel} block`} value={component} onChange={(e) => { setComponent(e.target.value); setPage("0"); }}><option value="">{tx("anything")}</option>{COMPONENTS.map((c) => <option key={c} value={c}>{tx(COMPONENT_LABEL[c])}</option>)}</select></label>
          <label className="text-[11px] text-slate-500">{tx("Provider")}<select className={`${sel} block`} value={provider} onChange={(e) => { setProvider(e.target.value); setPage("0"); }}><option value="">{tx("any")}</option>{["openai", "anthropic", "gemini", "mock"].map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="text-[11px] text-slate-500">{tx("Kind")}<select className={`${sel} block`} value={kind} onChange={(e) => { setKind(e.target.value); setPage("0"); }}><option value="">{tx("any")}</option>{["estimated", "confirmed", "unknown"].map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="text-[11px] text-slate-500">{tx("From")}<input type="date" className={`${sel} block`} value={from} onChange={(e) => { setFrom(e.target.value); setPage("0"); }} /></label>
          <label className="text-[11px] text-slate-500">{tx("To")}<input type="date" className={`${sel} block`} value={to} onChange={(e) => { setTo(e.target.value); setPage("0"); }} /></label>
          <button type="button" className={btnGhost} onClick={exportCsv} data-testid="export-csv">{tx("Download CSV")}</button>
          <button type="button" className={btnGhost} onClick={check} disabled={checking} data-testid="check-attribution">{checking ? tx("Checking…") : tx("Check attribution")}</button>
        </div>
        {data && <p className="mt-3 text-xs text-slate-600" data-testid="lines-summary"><b>{data.total.toLocaleString()}</b> {tx("records")} · {tx("priced total")} <b>{fmt(data.usd)}</b>{data.unknown_lines > 0 ? <span className="text-amber-600"> · {data.unknown_lines} {tx("could not be priced")}</span> : null}</p>}
      </section>
      {error && <Notice>{error}</Notice>}
      {attr && <AttributionView data={attr} />}
      <section className={card}>
        {!data ? <p className="py-10 text-center text-xs text-slate-400">{tx("Loading…")}</p> : <LinesTable lines={data.lines} fmt={fmt} />}
        {data && data.total > PAGE && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <button type="button" className={btnGhost} disabled={offset === 0} onClick={() => setPage(String(Math.max(0, (Number(page) || 0) - 1)))}>{tx("Previous")}</button>
            <span>{offset + 1}–{Math.min(offset + PAGE, data.total)} {tx("of")} {data.total.toLocaleString()}</span>
            <button type="button" className={btnGhost} disabled={offset + PAGE >= data.total} onClick={() => setPage(String((Number(page) || 0) + 1))}>{tx("Next")}</button>
          </div>
        )}
      </section>
    </div>
  );
}
