import { Icon, type IconName } from "@/components/ui/Icon";
import { Container } from "@/components/ui/Section";
import { stagger } from "@/lib/utils";

const parts: { n: string; icon: IconName; title: string; role: string; body: string; sample: string }[] = [
  {
    n: "01",
    icon: "spark",
    title: "Intelligent analysis",
    role: "AI advises",
    body: "Language models read medical reports, financial documents and fraud signals, and turn them into scored, explained evidence.",
    sample: "Medical risk 38 / 100",
  },
  {
    n: "02",
    icon: "shield",
    title: "Controlled decisions",
    role: "Rules decide",
    body: "A deterministic, versioned rule chain makes the call. It is configurable by your team and behaves identically every time.",
    sample: "Fraud below 15%: pass",
  },
  {
    n: "03",
    icon: "file",
    title: "Complete traceability",
    role: "Audit proves",
    body: "Each input, rule and outcome is written to an immutable trail that can be replayed to explain any decision.",
    sample: "Decision v12, replayable",
  },
];

const verdicts = [
  "Auto Approve",
  "Approve with Loading",
  "Human Review",
  "Request Additional Evidence",
  "Fraud Investigation",
  "Postpone",
  "Decline",
];

export function WhyInsuranceAI() {
  return (
    <section className="relative overflow-hidden bg-canvas py-20 sm:py-24 2xl:py-32">
        {/* Faint brand glow behind the three cards */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_50%_60%,rgb(37_99_235/0.12),transparent_70%),radial-gradient(ellipse_35%_30%_at_80%_75%,rgb(109_40_217/0.1),transparent_70%),radial-gradient(ellipse_30%_25%_at_20%_40%,rgb(34_184_214/0.07),transparent_70%)]" />
      <Container className="relative">
        <div data-reveal className="max-w-4xl">
          <p className="eyebrow">Why Insurance AI</p>
          <h2 className="mt-3 text-3xl font-semibold leading-[1.06] tracking-[-0.03em] text-ink sm:text-5xl 2xl:text-6xl">
            Intelligent analysis. Controlled decisions. Complete traceability.
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-body 2xl:text-lg">
            Most AI in insurance is a black box that nobody can explain. Here the model never decides: it informs a rule
            chain you control, and every step is recorded.
          </p>
        </div>

        <ol className="relative mt-14 grid gap-4 lg:grid-cols-3 lg:gap-0 2xl:mt-20">
          {/* The flow line behind the cards: a pulse travels from analysis to rules to audit */}
          <div className="absolute left-[16%] right-[16%] top-[3.25rem] hidden h-px bg-gradient-to-r from-brand-cyan/50 via-brand/50 to-brand-violet/50 lg:block" aria-hidden="true">
            <span className="flow-dot absolute -top-[3px] left-0 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_rgb(103_212_240/0.6)]" />
          </div>
          {parts.map((p, i) => (
            <li key={p.n} data-reveal style={stagger(i)} className="glass glass-hover glow relative rounded-2xl p-6 sm:p-8 lg:mx-3 2xl:p-10">
              <div className="flex items-center justify-between">
                <span className="flex h-[2.75rem] w-[2.75rem] items-center justify-center rounded-xl bg-brand-gradient-strong text-white shadow-glow">
                  <Icon name={p.icon} />
                </span>
                <span className="rounded-full bg-chip px-3 py-1 text-xs font-semibold text-accent">{p.role}</span>
              </div>
              <p className="mt-8 text-xs font-semibold tabular-nums text-faint">{p.n}</p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight text-ink 2xl:text-2xl">{p.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-body 2xl:text-base">{p.body}</p>
              <p className="mt-6 inline-block rounded-lg border border-line bg-canvas/60 px-3 py-2 text-xs font-medium tabular-nums text-ink">{p.sample}</p>
            </li>
          ))}
        </ol>

        <div data-reveal className="mt-12 2xl:mt-16">
          <p className="text-sm font-semibold text-ink">Seven possible outcomes, each one reachable only through the rules</p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {verdicts.map((v) => (
              <li key={v} className="glass flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.8125rem] font-medium text-body">
                <Icon name="check" className="h-3.5 w-3.5 text-emerald-400" />
                {v}
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
