"use client";

import { useState } from "react";
import { Tilt } from "@/components/effects/Tilt";
import { Icon } from "@/components/ui/Icon";
import { Container } from "@/components/ui/Section";
import { journeys } from "@/content/journeys";

// Individual, family and corporate share one five-stage workflow. Choosing a customer type
// replays the same stages with that customer's details (all demo data).
export function JourneyExplorer() {
  const [active, setActive] = useState(0);
  const journey = journeys[active];

  return (
    <section className="relative overflow-hidden bg-alt py-20 sm:py-24 2xl:py-32">
        {/* Faint brand glow behind the stage cards */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_45%_70%,rgb(37_99_235/0.07),transparent_70%),radial-gradient(ellipse_35%_30%_at_15%_85%,rgb(109_40_217/0.05),transparent_70%),radial-gradient(ellipse_30%_25%_at_85%_30%,rgb(34_184_214/0.07),transparent_70%)]" />
      <Container className="relative">
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

          <div role="tablist" aria-label="Customer type" className="glass flex w-max max-w-full gap-1 rounded-xl p-1 shadow-card">
            {journeys.map((j, i) => (
              <button
                key={j.name}
                type="button"
                role="tab"
                aria-selected={i === active}
                onClick={() => setActive(i)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  i === active ? "bg-brand-gradient-strong text-white shadow-glow" : "text-muted hover:text-ink"
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
              className="sc-in flex"
              style={{ "--d": i * 110 } as React.CSSProperties}
            >
              <Tilt className="flex w-full rounded-2xl">
                <div className="glass glass-hover glow flex w-full flex-col rounded-2xl p-5 shadow-card 2xl:p-6">
                  <div className="flex items-center justify-between">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-chip text-accent">
                      <Icon name={st.icon} />
                    </span>
                    <span className="text-xs font-semibold tabular-nums text-faint">0{i + 1}</span>
                  </div>
                  <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-accent">{st.label}</p>
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
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-alt px-3 py-2">
                      <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted">{st.result.label}</span>
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                        {st.result.ok && <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                        {st.result.value}
                      </span>
                    </div>
                  </div>
                </div>
              </Tilt>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
