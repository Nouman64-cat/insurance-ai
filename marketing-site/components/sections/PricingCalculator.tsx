"use client";

import { useMemo, useState } from "react";
import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { BlockHeader } from "@/components/blocks/Blocks";
import { Container } from "@/components/ui/Section";
import {
  CASE_TYPES,
  HYBRID_BASE_MONTHLY,
  RETAINER_MONTHLY,
  SCENARIOS,
  aiUsage,
  usd,
  type CaseMix,
  type CaseType,
} from "@/content/pricing";

type Period = "month" | "year";

// Enter a monthly case volume (or start from a scenario) and see both commercial models
// side by side: the bill, what makes it up, which is lower and where they cross over.
export function PricingCalculator() {
  const [mix, setMix] = useState<CaseMix>(SCENARIOS[1].mix);
  const [period, setPeriod] = useState<Period>("month");

  const scenario = SCENARIOS.find((s) => CASE_TYPES.every((t) => s.mix[t.key] === mix[t.key]))?.key ?? "custom";
  const factor = period === "year" ? 12 : 1;

  const r = useMemo(() => {
    const usage = aiUsage(mix);
    const hybrid = HYBRID_BASE_MONTHLY + usage;
    const cases = CASE_TYPES.reduce((n, t) => n + mix[t.key], 0);
    const perCase = cases > 0 ? usage / cases : 0;
    // Total monthly cases, at this mix, where the two bills are equal.
    const breakEven = perCase > 0 ? Math.round((RETAINER_MONTHLY - HYBRID_BASE_MONTHLY) / perCase) : null;
    return { usage, hybrid, cases, breakEven, cheaper: hybrid < RETAINER_MONTHLY ? "hybrid" : hybrid > RETAINER_MONTHLY ? "retainer" : "equal" };
  }, [mix]);

  const setCount = (key: CaseType, raw: string | number, max: number) => {
    const n = Math.round(Number(raw));
    setMix((m) => ({ ...m, [key]: Number.isFinite(n) ? Math.min(Math.max(n, 0), max * 5) : 0 }));
  };

  const saving = Math.abs(RETAINER_MONTHLY - r.hybrid) * factor;
  const top = Math.max(RETAINER_MONTHLY, r.hybrid);

  return (
    <section id="calculator" className="bg-alt py-16 sm:py-20 2xl:py-28">
      <Container>
        <BlockHeader
          eyebrow="Pricing calculator"
          title="See your bill under each model"
          description="Enter how many cases you expect to process in a month, or start from one of the scenarios. Both bills update as you go."
        />

        <div className="mt-10 grid gap-4 lg:grid-cols-[1.05fr_1fr] 2xl:mt-14 2xl:gap-6">
          {/* Inputs */}
          <div data-reveal className="card p-6 2xl:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-ink">Your monthly volume</h3>
              <div role="group" aria-label="Start from a scenario" className="flex flex-wrap gap-1 rounded-xl bg-alt p-1">
                {SCENARIOS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={scenario === s.key}
                    onClick={() => setMix(s.mix)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                      scenario === s.key ? "bg-brand text-white shadow-glow" : "text-muted hover:text-ink"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
                {scenario === "custom" && (
                  <span className="rounded-lg bg-card px-3 py-1.5 text-xs font-semibold text-ink">Custom</span>
                )}
              </div>
            </div>

            <div className="mt-6 space-y-6">
              {CASE_TYPES.map((t) => {
                const id = `calc-${t.key}`;
                return (
                  <div key={t.key}>
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor={id} className="text-sm font-semibold text-ink">
                        {t.label}
                        <span className="ml-2 font-normal text-muted">AI usage {usd(t.aiCost, true)} / {t.unit}</span>
                      </label>
                      <input
                        id={`${id}-n`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={t.step}
                        value={mix[t.key]}
                        onChange={(e) => setCount(t.key, e.target.value, t.max)}
                        aria-label={`${t.label} per month`}
                        className="w-28 rounded-lg border border-line bg-card px-3 py-1.5 text-right text-sm font-semibold tabular-nums text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
                      />
                    </div>
                    <input
                      id={id}
                      type="range"
                      min={0}
                      max={t.max}
                      step={t.step}
                      value={Math.min(mix[t.key], t.max)}
                      onChange={(e) => setCount(t.key, e.target.value, t.max)}
                      className="mt-3 w-full accent-brand"
                    />
                    <div className="mt-1 flex justify-between text-[0.6875rem] text-faint tabular-nums">
                      <span>0</span>
                      <span>{t.max.toLocaleString("en-US")} / month</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-sm">
              <span className="text-body">
                <span className="font-semibold tabular-nums text-ink">{r.cases.toLocaleString("en-US")}</span> cases a month ·{" "}
                <span className="tabular-nums">{(r.cases * 12).toLocaleString("en-US")}</span> a year
              </span>
              <span className="text-xs text-muted">A corporate scheme counts once, however many employees it covers.</span>
            </div>
          </div>

          {/* Results */}
          <div data-reveal className="card flex flex-col p-6 2xl:p-8" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-ink">Your bill</h3>
              <div role="group" aria-label="Show amounts per" className="flex gap-1 rounded-xl bg-alt p-1">
                {(["month", "year"] as Period[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={period === p}
                    onClick={() => setPeriod(p)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                      period === p ? "bg-card text-ink shadow-card" : "text-muted hover:text-ink"
                    }`}
                  >
                    Per {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-6 space-y-5">
              {[
                { key: "retainer", name: "Enterprise Retainer", amount: RETAINER_MONTHLY, note: "Flat fee, whatever the volume" },
                {
                  key: "hybrid",
                  name: "Cost + Hybrid",
                  amount: r.hybrid,
                  note: `${usd(HYBRID_BASE_MONTHLY * factor)} base + ${usd(r.usage * factor)} AI usage at cost`,
                },
              ].map((m) => {
                const lowest = r.cheaper === m.key;
                return (
                  <div key={m.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                        {m.name}
                        {lowest && (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                            Lower for this volume
                          </span>
                        )}
                      </span>
                      <span className="text-2xl font-semibold tracking-tight tabular-nums text-ink">{usd(m.amount * factor)}</span>
                    </div>
                    <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-alt">
                      <div
                        className={`h-full rounded-full transition-[width] duration-500 ${lowest ? "bg-emerald-500" : "bg-brand"}`}
                        style={{ width: `${top > 0 ? (m.amount / top) * 100 : 0}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-xs text-muted">{m.note}</p>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 rounded-xl bg-alt p-4 text-sm">
              <p className="font-semibold text-ink">
                {r.cheaper === "equal"
                  ? "Both models cost the same at this volume."
                  : `${r.cheaper === "hybrid" ? "Cost + Hybrid" : "The Enterprise Retainer"} saves ${usd(saving)} per ${period}.`}
              </p>
              {r.breakEven !== null && (
                <p className="mt-1 text-body">
                  At this case mix the two models cross at about{" "}
                  <span className="font-semibold tabular-nums text-ink">{r.breakEven.toLocaleString("en-US")}</span> cases a
                  month: below it Cost + Hybrid is lower, above it the Retainer is.
                </p>
              )}
            </div>

            <table className="mt-6 w-full text-sm">
              <caption className="sr-only">Cost + Hybrid breakdown per {period}</caption>
              <tbody className="divide-y divide-line">
                <tr>
                  <td className="py-2 text-body">Base fee</td>
                  <td className="py-2 text-right tabular-nums text-ink">{usd(HYBRID_BASE_MONTHLY * factor)}</td>
                </tr>
                {CASE_TYPES.map((t) => (
                  <tr key={t.key}>
                    <td className="py-2 text-body">
                      {t.label} <span className="text-muted">· {(mix[t.key] * factor).toLocaleString("en-US")} × {usd(t.aiCost, true)}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums text-ink">{usd(mix[t.key] * t.aiCost * factor, true)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2 font-semibold text-ink">Cost + Hybrid total</td>
                  <td className="py-2 text-right font-semibold tabular-nums text-ink">{usd(r.hybrid * factor, true)}</td>
                </tr>
              </tbody>
            </table>

            <div className="mt-auto flex flex-wrap items-center gap-3 pt-6">
              <ButtonLink href="/contact" variant="brand" arrow>
                Get a quote for this volume
              </ButtonLink>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Icon name="check" className="h-3.5 w-3.5 text-emerald-600" />
                Illustrative; final terms agreed per contract.
              </span>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
