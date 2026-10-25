"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { COMPONENT_COLOR, COMPONENT_LABEL, getModelComparison, percent, secondsText, type ModelComparison, type ModelGroup, type ModelSet, type Recommendation } from "@/lib/evalCosts";
import { QualityCostScatter } from "./charts";
import { Badge, Notice, SEVERITY_TONE, card } from "./ui";
import { useQueryState } from "@/lib/useQueryState";

export function Advice({ items, fmt }: { items: Recommendation[]; fmt: (usd: number | null | undefined) => string }) {
  if (items.length === 0) return <p className="text-xs text-slate-400" data-testid="no-advice">{tx("The runs so far give no advice: either they cannot tell the models apart, or there is not enough evidence.")}</p>;
  return (
    <ul className="space-y-3" data-testid="advice-list">
      {items.map((r) => (
        <li key={r.id} className="rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY_TONE[r.severity as keyof typeof SEVERITY_TONE] ?? "slate"}>{r.kind.replace(/_/g, " ")}</Badge>
            {r.confidence && <Badge tone={r.confidence === "high" ? "green" : r.confidence === "medium" ? "blue" : "amber"}>{r.confidence} {tx("confidence")}</Badge>}
            <span className="text-xs font-semibold text-slate-800">{r.title}</span>
          </div>
          {r.detail && <p className="text-[11px] text-slate-600 mt-1.5">{r.detail}</p>}
          {r.estimated_saving_usd !== null && r.estimated_saving_usd !== undefined && <p className="text-[11px] text-slate-700 mt-1"><b>{tx("Estimated saving")}: {fmt(r.estimated_saving_usd)}</b>{r.saving_basis ? ` — ${r.saving_basis}` : ""}</p>}
          {r.caveats && r.caveats.length > 0 && <ul className="mt-1 list-disc pl-4 text-[10px] text-slate-400">{r.caveats.map((c) => <li key={c}>{c}</li>)}</ul>}
        </li>
      ))}
    </ul>
  );
}

function Row({ m, fmt }: { m: ModelGroup; fmt: (usd: number | null | undefined) => string }) {
  const [open, setOpen] = useState(false);
  const comps = Object.entries(m.by_component).sort((a, b) => b[1].usd - a[1].usd);
  return (
    <>
      <tr className="border-t border-slate-100 align-top cursor-pointer hover:bg-blue-50/40" onClick={() => setOpen((o) => !o)} data-testid="model-row">
        <td className="px-3 py-2 text-slate-800 font-semibold">{m.label}<span className="block text-[10px] font-normal text-slate-400">{m.runs} {tx("run(s)")} · {m.ran} {tx("executions")}{m.enough_evidence ? "" : ` · ${tx("thin evidence")}`}</span></td>
        <td className="py-2" data-testid="pass-rate">{percent(m.pass_rate, 1)}<span className="block text-[10px] text-slate-400">{m.ci_low === null ? "" : `${percent(m.ci_low)}–${percent(m.ci_high)}`}</span></td>
        <td className="py-2">{m.consistency === null ? <span className="text-slate-400" title={tx("needs at least two repetitions")}>—</span> : percent(m.consistency)}</td>
        <td className="py-2">{secondsText(m.latency_p50_ms)} / {secondsText(m.latency_p95_ms)}</td>
        <td className="py-2">{percent(m.error_rate, 1)}</td>
        <td className={`py-2 ${m.critical_failures ? "text-red-600 font-semibold" : ""}`}>{m.critical_failures}</td>
        <td className="py-2 text-right">{fmt(m.total_usd)}<span className="block text-[10px] text-slate-400">{tx("judge")} {fmt(m.judge_usd)}</span></td>
        <td className="py-2 text-right font-bold text-slate-900" data-testid="per-passed">{m.per_passed_usd === null ? <span className="font-normal text-amber-600" title={tx("some spending could not be priced")}>{tx("unknown")}</span> : fmt(m.per_passed_usd)}</td>
        <td className="py-2 pl-2">{m.on_frontier === null ? <Badge>{tx("not placed")}</Badge> : m.on_frontier ? <Badge tone="blue">{tx("on the frontier")}</Badge> : <Badge>{tx("beaten by")} {m.dominated_by.length}</Badge>}</td>
      </tr>
      {open && (
        <tr className="bg-slate-50/60"><td colSpan={9} className="px-3 py-2">
          <div className="text-[11px] text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
            {comps.map(([k, v]) => <span key={k} className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COMPONENT_COLOR[k] ?? "#64748b" }} />{tx(COMPONENT_LABEL[k] ?? k)} <b>{fmt(v.usd)}</b>{v.unknown_lines ? <span className="text-amber-600"> (+{v.unknown_lines} {tx("unpriced")})</span> : null}</span>)}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">{tx("runs")}: {m.run_ids.join(", ")}{m.dominated_by.length ? ` · ${tx("beaten by")} ${m.dominated_by.join(", ")}` : ""}</p>
        </td></tr>
      )}
    </>
  );
}

/** One comparison set (a dataset version in one mode): the chart, the table, the warnings and the advice. */
export function SetView({ set, fmt }: { set: ModelSet; fmt: (usd: number | null | undefined) => string }) {
  return (
    <div className="space-y-4" data-testid="model-set">
      {set.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
      <section className={card}>
        <h3 className="text-sm font-bold text-slate-900">{tx("Quality against cost")}</h3>
        <p className="text-[11px] text-slate-500 mb-2">{set.dataset} {set.version} · {set.mode}</p>
        <QualityCostScatter models={set.models} format={(v) => fmt(v)} />
      </section>
      <section className={`${card} overflow-x-auto`}>
        <table className="w-full text-xs" data-testid="models-table">
          <thead><tr className="text-left text-slate-400"><th className="px-3 py-1.5 font-semibold">{tx("Configuration")}</th><th className="font-semibold">{tx("Pass rate")}</th><th className="font-semibold">{tx("Reliability")}</th><th className="font-semibold">{tx("Latency p50 / p95")}</th>
            <th className="font-semibold">{tx("Errors")}</th><th className="font-semibold">{tx("Critical")}</th><th className="font-semibold text-right">{tx("Total spent")}</th><th className="font-semibold text-right">{tx("Cost per passed test")}</th><th /></tr></thead>
          <tbody>{set.models.map((m) => <Row key={m.label} m={m} fmt={fmt} />)}</tbody>
        </table>
      </section>
      <section className={card}>
        <h3 className="text-sm font-bold text-slate-900 mb-2">{tx("What the numbers support")}</h3>
        <Advice items={set.recommendations} fmt={fmt} />
      </section>
    </div>
  );
}

export function ModelsView({ data, fmt, index, onIndex, synthetic, onSynthetic }: { data: ModelComparison; fmt: (usd: number | null | undefined) => string; index: number; onIndex: (i: number) => void; synthetic: boolean; onSynthetic: (on: boolean) => void }) {
  const set = data.sets[Math.min(index, Math.max(data.sets.length - 1, 0))];
  return (
    <div className="space-y-4" data-testid="models-view">
      <div className="flex flex-wrap items-center gap-3">
        {data.sets.length > 0 && (
          <label className="text-xs text-slate-600">{tx("Compare on")}{" "}
            <select className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white" value={index} onChange={(e) => onIndex(Number(e.target.value))} aria-label={tx("dataset version")}>
              {data.sets.map((s, i) => <option key={`${s.dataset}-${s.version}-${s.mode}`} value={i}>{s.dataset} {s.version} · {s.mode} ({s.models.length} {tx("configurations")})</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600"><input type="checkbox" checked={synthetic} onChange={(e) => onSynthetic(e.target.checked)} />{tx("include scripted models (they cost nothing and prove nothing about quality)")}</label>
      </div>
      <Notice kind="info">{data.how_to_read}</Notice>
      {!set ? <p className="py-12 text-center text-xs text-slate-400" data-testid="no-sets">{tx("No real model has been benchmarked yet.")}</p> : <SetView set={set} fmt={fmt} />}
    </div>
  );
}

export default function ModelsPanel({ fmt, refreshKey }: { fmt: (usd: number | null | undefined) => string; refreshKey: number }) {
  const [data, setData] = useState<ModelComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setIdx, setSetIdx] = useQueryState("set", "0", { replace: true });
  const [synth, setSynth] = useQueryState("synthetic", "", { replace: true });
  useEffect(() => { setData(null); getModelComparison({ include_synthetic: synth === "1" }).then((d) => { setData(d); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the comparison.")); }, [synth, refreshKey]);
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>;
  return <ModelsView data={data} fmt={fmt} index={Number(setIdx) || 0} onIndex={(i) => setSetIdx(String(i))} synthetic={synth === "1"} onSynthetic={(on) => setSynth(on ? "1" : "")} />;
}
