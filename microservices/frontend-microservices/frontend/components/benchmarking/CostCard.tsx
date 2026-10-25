"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { COMPONENT_COLOR, COMPONENT_LABEL, getBenchmarkSpending, show, type BenchmarkSpend } from "@/lib/evalCosts";

/** What one benchmark cost, all-in, from the cost lines: the model's own calls, the judge, retries and anything unattributed, per model and in total. Pure markup, so it can be rendered from real API data. */
export function BenchmarkCostView({ spend }: { spend: BenchmarkSpend }) {
  const comps = Object.entries(spend.by_component).sort((a, b) => b[1] - a[1]);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 min-w-0" data-testid="benchmark-cost">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-sm font-bold text-slate-900">{tx("What this benchmark cost")}</h3>
          <p className="text-[11px] text-slate-500">{tx("Everything it spent, from the recorded cost lines: the models' own calls, the judge, retries and calls that earned no verdict.")}</p></div>
        <div className="text-right"><div className="text-xl font-bold text-slate-900" data-testid="benchmark-total">{show(spend.total_usd)}</div>
          <Link className="text-[11px] text-blue-600 hover:underline" href="/super-admin/evaluation?mode=investigate&sub=compare" data-testid="costs-link">{tx("Compare models and costs")} →</Link></div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs"><thead><tr className="text-left text-slate-400"><th className="py-1 font-semibold">{tx("Model")}</th><th className="font-semibold text-right">{tx("Total")}</th><th className="font-semibold text-right">{tx("of which judge")}</th><th className="font-semibold text-right">{tx("Passed")}</th><th className="font-semibold text-right">{tx("Per passed test")}</th></tr></thead>
          <tbody>{spend.models.map((m) => (
            <tr key={m.run_id} className="border-t border-slate-100"><td className="py-1.5 text-slate-800 font-semibold">{m.label}</td><td className="text-right">{show(m.total_usd)}</td><td className="text-right text-slate-500">{show(m.judge_usd)}</td><td className="text-right">{m.passed} / {m.ran}</td>
              <td className="text-right font-bold">{m.per_passed_usd === null ? <span className="font-normal text-amber-600">{tx("unknown")}</span> : show(m.per_passed_usd)}</td></tr>))}</tbody></table>
      </div>
      {comps.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{comps.map(([k, v]) => <span key={k} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-700"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COMPONENT_COLOR[k] ?? "#64748b" }} />{tx(COMPONENT_LABEL[k] ?? k)} <b>{show(v)}</b></span>)}</div>}
      {spend.unknown_lines > 0 && <p className="mt-2 text-[11px] text-amber-700">{spend.unknown_lines} {tx("call(s) could not be priced: they are in no total, so the figures above are a lower bound.")}</p>}
    </section>
  );
}

export default function BenchmarkCost({ benchmarkId }: { benchmarkId: string }) {
  const [spend, setSpend] = useState<BenchmarkSpend | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setSpend(null);
    setMissing(false);
    getBenchmarkSpending(benchmarkId).then((d) => { const one = d.benchmarks.find((b) => b.benchmark_id === benchmarkId); if (one) setSpend(one); else setMissing(true); }).catch(() => setMissing(true));
  }, [benchmarkId]);
  if (missing) return <p className="text-[11px] text-slate-400">{tx("No cost lines are recorded for this benchmark (a scripted benchmark costs nothing, and older runs may predate cost lines).")}</p>;
  return spend ? <BenchmarkCostView spend={spend} /> : null;
}
