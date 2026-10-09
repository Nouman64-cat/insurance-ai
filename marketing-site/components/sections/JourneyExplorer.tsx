"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Container } from "@/components/ui/Section";
import { journeys } from "@/content/journeys";

// Individual, family and corporate share one five-stage workflow. Choosing a customer type
// replays the same stages with that customer's details (all demo data).
export function JourneyExplorer() {
  const [active, setActive] = useState(0);
  const journey = journeys[active];

  return (
    <section className="bg-alt py-20 sm:py-24 2xl:py-32">
      <Container>
        <div data-reveal className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <div className="max-w-3xl">
            <p className="eyebrow">Built for every customer</p>
            <h2 className="mt-3 text-3xl font-semibold leading-[1.06] tracking-[-0.03em] text-ink sm:text-5xl 2xl:text-6xl">
              One workflow for individuals, families and employers.
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-body 2xl:text-lg">
              Conventional and takaful plans share the same lifecycle, with the differences modelled where they matter:
              nominees for families, census and benefit classes for employers.
            </p>
          </div>

          <div role="tablist" aria-label="Customer type" className="flex w-max gap-1 rounded-xl bg-card p-1 shadow-card">
            {journeys.map((j, i) => (
              <button
                key={j.name}
                type="button"
                role="tab"
                aria-selected={i === active}
                onClick={() => setActive(i)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  i === active ? "bg-brand text-white shadow-glow" : "text-muted hover:text-ink"
                }`}
              >
                {j.name}
              </button>
            ))}
          </div>
        </div>

        <p className="mt-10 text-sm font-medium text-muted">
          {journey.who} <span className="text-faint">· demo data</span>
        </p>

        <ol key={active} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {journey.stages.map((st, i) => (
            <li
              key={st.label}
              className="sc-in glow flex flex-col rounded-2xl bg-card p-5 shadow-card 2xl:p-6"
              style={{ "--d": i * 110 } as React.CSSProperties}
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Icon name={st.icon} />
                </span>
                <span className="text-xs font-semibold tabular-nums text-faint">0{i + 1}</span>
              </div>
              <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-brand">{st.label}</p>
              <h3 className="mt-1 text-[0.9375rem] font-semibold leading-snug text-ink 2xl:text-base">{st.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{st.caption}</p>

              <ul className="mt-4 space-y-2">
                {st.rows.map((r) => (
                  <li key={r.label} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-body">{r.label}</span>
                    <span className="text-right font-semibold tabular-nums text-ink">{r.value}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-5">
                <div className="flex items-center justify-between rounded-lg bg-alt px-3 py-2">
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted">{st.result.label}</span>
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                    {st.result.ok && <Icon name="check" className="h-3.5 w-3.5 text-emerald-600" />}
                    {st.result.value}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
