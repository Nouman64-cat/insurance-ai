"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { formatter, getRates, type Rates } from "@/lib/evalCosts";
import { setCurrency, setRates, useDisplayCurrency } from "@/lib/displayCurrency";
import { useQueryState } from "@/lib/useQueryState";
import BudgetsPanel from "./BudgetsPanel";
import InsightsPanel from "./InsightsPanel";
import ModelsPanel from "./ModelsPanel";
import OverviewPanel from "./OverviewPanel";
import RatesPanel from "./RatesPanel";
import ReconcilePanel from "./ReconcilePanel";
import UsagePanel from "./UsagePanel";
import { btnGhost } from "./ui";

export const COST_VIEWS: { id: string; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "models", label: "Cost vs quality" }, { id: "budgets", label: "Budgets" }, { id: "usage", label: "Usage records" },
  { id: "reconcile", label: "Reconciliation" }, { id: "insights", label: "Findings & advice" }, { id: "rates", label: "Exchange rates" },
];
function Workspace() {
  const [viewParam, setView] = useQueryState("view", "overview");
  const view = COST_VIEWS.some((v) => v.id === viewParam) ? viewParam : "overview";
  const [curParam, setCurParam] = useQueryState("cur", "");
  const display = useDisplayCurrency();                    // the one choice for the whole studio (header selector and this page are the same control)
  const [rates, setRatesState] = useState<Rates | null>(null);
  const [refresh, setRefresh] = useState(0);
  const loadRates = useCallback(() => getRates().then((r) => { setRatesState(r); setRates(Object.fromEntries(Object.entries(r.currencies).filter(([, v]) => v.current).map(([k, v]) => [k, v.current!.units_per_usd]))); }).catch(() => setRatesState({ base: "USD", currencies: {} })), []);
  useEffect(() => { loadRates(); }, [loadRates, refresh]);
  useEffect(() => { if (curParam) setCurrency(curParam); }, [curParam]);          // a link that names a currency opens in it
  const known = Object.keys(rates?.currencies ?? {});
  const currency = display.currency.toUpperCase();
  const rate = rates?.currencies[currency]?.current ?? null;
  const fmt = useMemo(() => formatter(currency, rate), [currency, rate]);
  const changed = useCallback(() => setRefresh((n) => n + 1), []);
  const choose = (c: string) => { setCurrency(c); setCurParam(c === "USD" ? "" : c); };
  return (
    <div className="space-y-4" data-testid="costs-workspace">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="text-lg font-bold text-slate-900">{tx("Costs & Budgets")}</h2>
          <p className="text-sm text-slate-500 mt-0.5">{tx("What evaluations cost, split by what the money paid for; limits that stop a job before it is scheduled; how the numbers compare with what the providers billed; and which model gives the most for the money.")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-600">{tx("Show money in")}{" "}
            <select className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white" value={known.includes(currency) || currency === "USD" ? currency : "USD"} onChange={(e) => choose(e.target.value)} aria-label={tx("currency")} data-testid="currency">
              <option value="USD">USD</option>{known.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <Link href="/super-admin/evaluation?mode=simulate" className={btnGhost} data-testid="estimate-link">{tx("Estimate a run")}</Link>
          <button type="button" className={btnGhost} onClick={changed}>{tx("Refresh")}</button>
        </div>
      </div>
      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto" role="tablist" data-testid="costs-tabs">
        {COST_VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}
            className={`px-3 py-2 text-xs font-semibold border-b-2 -mb-px whitespace-nowrap ${view === v.id ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{tx(v.label)}</button>
        ))}
      </div>
      {view === "overview" && <OverviewPanel currency={known.includes(currency) ? currency : "USD"} fmt={fmt} onGo={setView} refreshKey={refresh} />}
      {view === "models" && <ModelsPanel fmt={fmt} refreshKey={refresh} />}
      {view === "budgets" && <BudgetsPanel fmt={fmt} onChanged={changed} refreshKey={refresh} />}
      {view === "usage" && <UsagePanel fmt={fmt} />}
      {view === "reconcile" && <ReconcilePanel fmt={fmt} onChanged={changed} refreshKey={refresh} />}
      {view === "insights" && <InsightsPanel fmt={fmt} refreshKey={refresh} />}
      {view === "rates" && <RatesPanel onChanged={changed} refreshKey={refresh} />}
    </div>
  );
}

export default function CostsWorkspace() {
  return <Suspense fallback={null}><Workspace /></Suspense>;
}
