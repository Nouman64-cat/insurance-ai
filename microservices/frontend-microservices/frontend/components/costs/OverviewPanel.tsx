"use client";

import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { COMPONENT_COLOR, COMPONENT_LABEL, RECON_LABEL, getCostOverview, money, percent, type CostOverview } from "@/lib/evalCosts";
import { StackedBars } from "./charts";
import { Badge, BudgetBar, Notice, SEVERITY_TONE, Stat, card, btnGhost, RECON_TONE, day } from "./ui";

/** The costs overview as pure data -> markup, so the test can render it with what the real API returned. */
export function OverviewView({ data, currency, fmt, onGo }: { data: CostOverview; currency: string; fmt: (usd: number | null | undefined) => string; onGo: (view: string) => void }) {
  const second = currency !== "USD" && data.rate;
  const monthText = second && data.month.converted_total !== null ? money(data.month.converted_total, currency) : fmt(data.month.total_usd);
  const points = data.trend.points.map((p) => ({ start: p.start, total: second && p.converted ? p.converted.total : p.total_usd, by_group: second && p.converted ? p.converted.by_group : p.by_group }));
  const chartFmt = (v: number) => (second ? money(v, currency) : money(v, "USD"));
  const c = data.month.certainty;
  const totalForBar = Math.max(c.total_usd, 1e-12);
  const reserved = data.budget.periods.day.reserved_usd;
  const bad = data.statements.needs_attention;
  return (
    <div className="space-y-4" data-testid="costs-overview">
      {second && (
        <Notice kind="info">
          1 USD = <b>{data.rate!.units_per_usd}</b> {currency} ({tx("rate in force today, recorded for")} {day(data.rate!.effective_from)}; {data.rate!.source}). {tx("The month total and the daily chart convert each day at that day's own rate; single figures use today's rate.")}
          {data.month.unconverted_usd ? ` ${money(data.month.unconverted_usd, "USD")} ${tx("was spent on days with no recorded rate and is not in the converted figures.")}` : ""}
        </Notice>
      )}
      {currency !== "USD" && !data.rate && <Notice kind="warn">{tx("No rate is recorded for")} {currency}: {tx("figures are shown in US dollars. Record a rate under Rates.")}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={tx("Spent this month")} value={monthText} testId="month-total"
          sub={<>{data.month.unknown_lines > 0 ? <span className="text-amber-600">{data.month.unknown_lines} {tx("line(s) could not be priced and are in no total")} · </span> : null}
            {data.month.projection ? `${tx("at this pace")} ${fmt(data.month.projection.projected_usd)} ${tx("by month end")}` : tx("nothing spent yet")}</>} />
        <Stat label={tx("Spent today")} value={fmt(data.today_usd)} testId="today-total" sub={reserved > 0 ? `${fmt(reserved)} ${tx("reserved by jobs in progress")}` : tx("nothing reserved")} />
        <Stat label={tx("Running now")} value={data.running.length} testId="running-count" sub={data.running.length > 0 ? `${tx("estimated")} ${fmt(data.running.reduce((a, r) => a + (r.estimated_usd ?? 0), 0))}` : tx("no evaluation is running")} />
        <div className={card} data-testid="certainty">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{tx("How sure is this month's money")}</div>
          <div className="mt-2 h-3 rounded-full bg-slate-100 overflow-hidden flex" aria-label={tx("confirmed, estimated")}>
            <div className="bg-emerald-500" style={{ width: `${(c.confirmed_usd / totalForBar) * 100}%` }} title={`${tx("confirmed")} ${fmt(c.confirmed_usd)}`} />
            <div className="bg-blue-500" style={{ width: `${(c.estimated_usd / totalForBar) * 100}%` }} title={`${tx("estimated")} ${fmt(c.estimated_usd)}`} />
          </div>
          <dl className="mt-2 text-[11px] space-y-0.5">
            <div className="flex justify-between"><dt className="text-emerald-700 font-semibold">{tx("Confirmed by a provider bill")}</dt><dd data-testid="confirmed-usd">{fmt(c.confirmed_usd)}</dd></div>
            <div className="flex justify-between"><dt className="text-blue-700 font-semibold">{tx("Estimated from tokens")}</dt><dd data-testid="estimated-usd">{fmt(c.estimated_usd)}</dd></div>
            <div className="flex justify-between"><dt className="text-amber-700 font-semibold">{tx("Unknown (could not be priced)")}</dt><dd data-testid="unknown-lines">{c.unknown_lines} {tx("line(s)")}</dd></div>
          </dl>
        </div>
      </div>

      <section className={card}>
        <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-bold text-slate-900">{tx("Budgets")}</h2><button type="button" className={btnGhost} onClick={() => onGo("budgets")}>{tx("Change limits")}</button></div>
        <div className="mt-3 grid gap-5 md:grid-cols-2">
          <BudgetBar p={data.budget.periods.day} fmt={fmt} />
          <BudgetBar p={data.budget.periods.month} fmt={fmt} />
        </div>
        {data.budget.messages.length > 0 && <div className="mt-3 space-y-1">{data.budget.messages.map((m) => <Notice key={m} kind={data.budget.allowed ? "warn" : "error"}>{m}</Notice>)}</div>}
        {data.month.projection?.over_limit && <div className="mt-3"><Notice kind="warn">{tx("At this month's pace you would spend")} {fmt(data.month.projection.projected_usd)}, {tx("above the")} {fmt(data.month.projection.limit_usd)} {tx("monthly limit (a straight line through uneven spending).")}</Notice></div>}
      </section>

      <section className={card}>
        <h2 className="text-sm font-bold text-slate-900">{tx("Spending in the last 30 days")}</h2>
        <p className="text-[11px] text-slate-500 mb-2">{tx("Real models only, by what the money paid for.")}</p>
        <StackedBars title={tx("Spending per day")} points={points} groups={data.trend.groups} format={chartFmt} />
        {Object.keys(data.month.by_component).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2" data-testid="by-component">
            {Object.entries(data.month.by_component).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-700">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COMPONENT_COLOR[k] ?? "#64748b" }} />{tx(COMPONENT_LABEL[k] ?? k)} <b>{fmt(v)}</b>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-bold text-slate-900">{tx("Running now")}</h2>
        {data.running.length === 0 ? <p className="text-xs text-slate-400 mt-2" data-testid="nothing-running">{tx("Nothing is running.")}</p> : (
          <table className="w-full text-xs mt-2" data-testid="running-table">
            <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="py-1.5 font-semibold">{tx("Job")}</th><th className="font-semibold">{tx("State")}</th><th className="font-semibold">{tx("Progress")}</th><th className="font-semibold text-right">{tx("Spent so far")}</th><th className="font-semibold text-right">{tx("Estimated")}</th></tr></thead>
            <tbody>{data.running.map((r) => (
              <tr key={r.job_id} className="border-t border-slate-100">
                <td className="py-1.5 text-slate-700">{r.dataset} {r.version}<span className="block text-[10px] text-slate-400">{(r.models.filter(Boolean) as string[]).join(" vs ") || r.kind}</span></td>
                <td>{r.state}</td>
                <td>{r.executions !== null && r.planned ? <><div className="h-1.5 w-24 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-blue-600" style={{ width: `${Math.min(100, (r.executions / r.planned) * 100)}%` }} /></div><span className="text-[10px] text-slate-400">{r.executions} / {r.planned}</span></> : <span className="text-slate-400">{tx("queued")}</span>}</td>
                <td className="text-right">{r.spent_usd === null ? "—" : fmt(r.spent_usd)}</td>
                <td className="text-right text-slate-500">{fmt(r.estimated_usd)}</td>
              </tr>))}</tbody>
          </table>
        )}
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <section className={card} data-testid="card-statements">
          <h3 className="text-xs font-bold text-slate-900">{tx("Provider bills")}</h3>
          {data.statements.count === 0 ? <p className="text-[11px] text-slate-500 mt-1">{tx("No bill has been entered, so nothing is confirmed yet.")}</p> : (
            <ul className="mt-1 space-y-1 text-[11px]">{data.statements.latest.map((s) => <li key={s.id} className="flex justify-between gap-2"><span>{s.provider} {s.period_start}</span>{s.status ? <Badge tone={RECON_TONE[s.status]}>{tx(RECON_LABEL[s.status])}</Badge> : null}</li>)}</ul>
          )}
          <button type="button" className={`${btnGhost} mt-2`} onClick={() => onGo("reconcile")}>{bad > 0 ? `${bad} ${tx("need a look")}` : tx("Open reconciliation")}</button>
        </section>
        <section className={card} data-testid="card-attribution">
          <h3 className="text-xs font-bold text-slate-900">{tx("Attribution check")}</h3>
          <p className="text-[11px] mt-1">{data.attribution.with_problems === 0 ? <span className="text-emerald-700 font-semibold">{tx("All")} {data.attribution.checked} {tx("runs account for their spending exactly.")}</span>
            : <span className="text-red-600 font-semibold">{data.attribution.with_problems} {tx("of")} {data.attribution.checked} {tx("runs have spending that does not add up.")}</span>}</p>
          <button type="button" className={`${btnGhost} mt-2`} onClick={() => onGo("usage")}>{tx("Inspect usage records")}</button>
        </section>
        <section className={card} data-testid="card-anomalies">
          <h3 className="text-xs font-bold text-slate-900">{tx("Unusual spending")}</h3>
          <p className="text-[11px] mt-1 text-slate-600">{data.anomalies.count === 0 ? tx("Nothing unusual in the last 90 days.") : `${data.anomalies.count} ${tx("finding(s)")}${data.anomalies.high ? `, ${data.anomalies.high} ${tx("high")}` : ""}.`}</p>
          <button type="button" className={`${btnGhost} mt-2`} onClick={() => onGo("insights")}>{tx("See findings")}</button>
        </section>
        <section className={card} data-testid="card-advice">
          <h3 className="text-xs font-bold text-slate-900">{tx("Advice")}</h3>
          {data.recommendations.top.length === 0 ? <p className="text-[11px] mt-1 text-slate-500">{tx("No advice yet: it needs more real runs.")}</p> : (
            <ul className="mt-1 space-y-1 text-[11px] text-slate-600">{data.recommendations.top.map((r) => <li key={r.id}><Badge tone={SEVERITY_TONE[r.severity as keyof typeof SEVERITY_TONE] ?? "slate"}>{r.kind.replace("_", " ")}</Badge> {r.title}</li>)}</ul>
          )}
          {data.recommendations.estimated_saving_usd > 0 && <p className="text-[10px] text-slate-400 mt-1">{tx("Estimated saving on past runs")}: {fmt(data.recommendations.estimated_saving_usd)}</p>}
          <button type="button" className={`${btnGhost} mt-2`} onClick={() => onGo("insights")}>{tx("See advice")}</button>
        </section>
      </div>
    </div>
  );
}

/** Loads the overview, and keeps it live while something is running (every 6 seconds). */
export default function OverviewPanel({ currency, fmt, onGo, refreshKey }: { currency: string; fmt: (usd: number | null | undefined) => string; onGo: (view: string) => void; refreshKey: number }) {
  const [data, setData] = useState<CostOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => getCostOverview(currency === "USD" ? undefined : currency).then((d) => { setData(d); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the costs.")), [currency]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const live = !!data && data.running.length > 0;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [live, load]);
  if (error && !data) return <Notice>{error}</Notice>;
  if (!data) return <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>;
  return <>{error && <Notice>{error}</Notice>}<OverviewView data={data} currency={currency} fmt={fmt} onGo={onGo} /></>;
}
