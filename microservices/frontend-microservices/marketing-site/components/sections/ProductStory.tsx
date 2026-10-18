"use client";

import { useEffect, useRef, useState } from "react";
import { Container } from "@/components/ui/Section";
import { ProductSurface } from "@/components/product/ProductSurface";

// The scroll-driven product story. On desktop the interface stays pinned while the page scrolls
// and the case moves through four stages; no scroll hijacking, the page scrolls normally and the
// stage is simply read from the scroll position. Below 1024px the section is a normal block, every
// step's text is shown, and the stages play on a gentle timer while it is on screen.

const steps = [
  {
    title: "Every journey starts with a lead",
    body: "A new application arrives from the agent app, the portal or the copilot and enters one shared workflow, with its customer, case and policy records linked from the first minute.",
  },
  {
    title: "Turn complex risk signals into clear insights",
    body: "Language models read the medical, financial and fraud evidence in parallel. What they produce is advice: scored, explained, and kept separate from any decision.",
  },
  {
    title: "Your reviewers remain in control",
    body: "Versioned rules support the recommendation. Authorised reviewers record the human outcome, and Claims and Finance retain separate decision and payment responsibilities.",
  },
  {
    title: "Every decision has a story you can replay",
    body: "Saved findings, review rationale and recorded outcomes let teams inspect how a case progressed.",
  },
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function ProductStory() {
  const sectionRef = useRef<HTMLElement>(null);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    let frame = 0;
    let timer = 0;
    let observer: IntersectionObserver | undefined;

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = section.getBoundingClientRect();
        const header = 64;
        const travel = rect.height - (window.innerHeight - header);
        const p = clamp((header - rect.top) / travel, 0, 1);
        section.style.setProperty("--p", p.toFixed(3));
        const next = Math.min(3, Math.floor(p * 4));
        setStage((prev) => (prev === next ? prev : next));
      });
    };

    const setup = () => {
      window.removeEventListener("scroll", onScroll);
      window.clearInterval(timer);
      observer?.disconnect();
      if (desktop.matches) {
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
      } else {
        section.style.setProperty("--p", "0");
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) {
          setStage(3);
          return;
        }
        observer = new IntersectionObserver(([entry]) => {
          window.clearInterval(timer);
          if (entry.isIntersecting) timer = window.setInterval(() => setStage((s) => (s + 1) % 4), 3200);
        });
        observer.observe(section);
      }
    };

    setup();
    desktop.addEventListener("change", setup);
    return () => {
      desktop.removeEventListener("change", setup);
      window.removeEventListener("scroll", onScroll);
      window.clearInterval(timer);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section
      id="product-story"
      ref={sectionRef}
      className="relative scroll-mt-16 bg-alt lg:h-[330vh]"
      style={{ "--p": 0 } as React.CSSProperties}
    >
      <div className="relative overflow-hidden py-16 sm:py-20 lg:sticky lg:top-16 lg:flex lg:h-[calc(100vh-4rem)] lg:items-center lg:py-0">
        {/* Faint brand glow behind the interface */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_68%_50%,rgb(37_99_235/0.08),transparent_70%),radial-gradient(ellipse_35%_35%_at_85%_75%,rgb(109_40_217/0.06),transparent_70%),radial-gradient(ellipse_30%_30%_at_55%_25%,rgb(34_184_214/0.08),transparent_70%)]"
        />
        <Container className="relative grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8.5fr)] lg:items-center lg:gap-14 2xl:gap-20">
          <div>
            <p className="eyebrow">How a case moves</p>
            <h2 className="mt-3 max-w-xl text-3xl font-semibold leading-[1.08] tracking-[-0.025em] text-ink sm:text-4xl 2xl:text-5xl">
              Follow the evidence to a human decision.
            </h2>

            <ol className="relative mt-8 space-y-1 pl-7 2xl:mt-10">
              <span className="absolute bottom-2 left-[0.4375rem] top-2 w-px bg-line-strong" aria-hidden="true" />
              <span
                className="absolute bottom-2 left-[0.4375rem] top-2 hidden w-0.5 origin-top bg-gradient-to-b from-brand-cyan via-brand to-brand-violet lg:block"
                style={{ transform: "scaleY(var(--p, 0))" }}
                aria-hidden="true"
              />
              {steps.map((st, i) => {
                const active = stage === i;
                return (
                  <li key={st.title} className="relative py-2.5">
                    <span
                      className={`absolute -left-7 top-[1.1rem] flex h-3.5 w-3.5 items-center justify-center rounded-full transition-colors duration-500 ${
                        stage >= i ? "bg-brand" : "bg-line-strong"
                      } ${active ? "ring-4 ring-accent/20" : ""}`}
                      aria-hidden="true"
                    />
                    <p className={`text-xs font-semibold tabular-nums transition-colors duration-500 ${active ? "text-accent" : "text-faint"}`}>
                      0{i + 1}
                    </p>
                    <h3 className={`mt-0.5 text-lg font-semibold tracking-tight transition-colors duration-500 2xl:text-xl ${active ? "text-ink" : "text-muted"}`}>
                      {st.title}
                    </h3>
                    <div
                      className={`grid transition-[grid-template-rows,opacity] duration-500 ease-out ${
                        active ? "grid-rows-[1fr] opacity-100" : "grid-rows-[1fr] opacity-100 lg:grid-rows-[0fr] lg:opacity-0"
                      }`}
                    >
                      <p className="overflow-hidden text-sm leading-relaxed text-body 2xl:text-base">{st.body}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          <ProductSurface stage={stage} />
        </Container>
      </div>
    </section>
  );
}
