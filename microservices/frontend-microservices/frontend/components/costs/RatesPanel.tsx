"use client";

import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { addRate, getRates, type Rates } from "@/lib/evalCosts";
import { Field, Modal, Notice, btnGhost, btnPrimary, card, day, inputCls, shortId, when } from "./ui";

export function RateForm({ defaultCurrency, onClose, onSaved }: { defaultCurrency: string; onClose: () => void; onSaved: (warning: string | null) => void }) {
  const [currency, setCurrency] = useState(defaultCurrency);
  const [units, setUnits] = useState("");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = [!/^[A-Za-z]{3}$/.test(currency) || currency.toUpperCase() === "USD" ? tx("The currency is a three-letter code other than USD.") : null, !(Number(units) > 0) ? tx("The rate is how many units one US dollar buys.") : null,
    !from ? tx("Choose the day the rate takes effect.") : null, !source.trim() ? tx("Say where the rate came from.") : null].filter(Boolean) as string[];
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await addRate({ currency: currency.toUpperCase(), units_per_usd: Number(units), effective_from: from, source: source.trim() });
      onSaved(r.warning);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rate could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={tx("Record an exchange rate")} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tx("Currency")}><input className={inputCls} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} data-testid="rate-currency" /></Field>
        <Field label={tx("Units per US dollar")} hint={tx("1 USD buys this many")}><input className={inputCls} inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} data-testid="rate-units" /></Field>
        <Field label={tx("Takes effect on")}><input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} data-testid="rate-from" /></Field>
      </div>
      <Field label={tx("Where it came from (required)")} hint={tx("For example: State Bank of Pakistan interbank closing rate.")}><textarea className={inputCls} rows={2} value={source} onChange={(e) => setSource(e.target.value)} data-testid="rate-source" /></Field>
      {error && <Notice>{error}</Notice>}
      {problems.length > 0 && source !== "" && <Notice kind="warn">{problems.join(" ")}</Notice>}
      <div className="flex justify-end gap-2"><button type="button" className={btnGhost} onClick={onClose}>{tx("Cancel")}</button><button type="button" className={btnPrimary} disabled={busy || problems.length > 0} onClick={save} data-testid="rate-save">{tx("Record the rate")}</button></div>
    </Modal>
  );
}

export function RatesView({ rates, onAdd }: { rates: Rates; onAdd: () => void }) {
  const codes = Object.keys(rates.currencies);
  return (
    <div className="space-y-4" data-testid="rates-view">
      <Notice kind="info">{tx("Money is recorded once, in US dollars, as the provider charges it. A second currency only changes how it is read: each day's spending is converted at the rate that was in force that day, never at today's rate, so last month's report does not change when the rate moves. A day with no recorded rate is not converted at some other rate: it stays in dollars and is reported as unconverted. Rates are never edited; a correction is a newer rate.")}</Notice>
      <section className={card}>
        <div className="flex items-center justify-between gap-2 mb-2"><h2 className="text-sm font-bold text-slate-900">{tx("Exchange rates")}</h2><button type="button" className={btnPrimary} onClick={onAdd} data-testid="add-rate">{tx("Record a rate")}</button></div>
        {codes.length === 0 ? <p className="py-8 text-center text-xs text-slate-400" data-testid="no-rates">{tx("No rate has been recorded, so money is shown in US dollars only.")}</p> : codes.map((code) => {
          const c = rates.currencies[code];
          return (
            <div key={code} className="mt-3" data-testid={`rates-${code}`}>
              <h3 className="text-xs font-bold text-slate-800">{code}{c.current ? <span className="font-normal text-slate-500"> · {tx("today")} 1 USD = <b>{c.current.units_per_usd}</b> {code} ({tx("since")} {day(c.current.effective_from)})</span> : <span className="font-normal text-amber-600"> · {tx("no rate in force yet")}</span>}</h3>
              <table className="w-full text-xs mt-1"><thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="py-1 font-semibold">{tx("Takes effect")}</th><th className="font-semibold">{tx("1 USD =")}</th><th className="font-semibold">{tx("Source")}</th><th className="font-semibold">{tx("Recorded")}</th></tr></thead>
                <tbody>{c.history.map((h) => <tr key={h.id} className="border-t border-slate-100"><td className="py-1">{day(h.effective_from)}</td><td className="font-semibold">{h.units_per_usd}</td><td className="text-slate-600">{h.source}</td><td className="text-slate-400">{when(h.created_at)} · {shortId(h.recorded_by)}</td></tr>)}</tbody></table>
            </div>
          );
        })}
      </section>
    </div>
  );
}

export default function RatesPanel({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const [rates, setRates] = useState<Rates | null>(null);
  const [adding, setAdding] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(() => getRates().then((r) => { setRates(r); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the rates.")), []);
  useEffect(() => { load(); }, [load, refreshKey]);
  if (error && !rates) return <Notice>{error}</Notice>;
  if (!rates) return <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>;
  return (
    <>
      {saved && <div className="mb-3"><Notice kind="ok">{tx("The rate was recorded.")}</Notice></div>}
      {warning && <div className="mb-3"><Notice kind="warn">{warning}</Notice></div>}
      <RatesView rates={rates} onAdd={() => { setSaved(false); setWarning(null); setAdding(true); }} />
      {adding && <RateForm defaultCurrency={Object.keys(rates.currencies)[0] ?? "PKR"} onClose={() => setAdding(false)} onSaved={(w) => { setAdding(false); setSaved(true); setWarning(w); load(); onChanged(); }} />}
    </>
  );
}
