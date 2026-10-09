import { Icon, type IconName } from "@/components/ui/Icon";
import { Container } from "@/components/ui/Section";
import { stagger } from "@/lib/utils";

const principles: { icon: IconName; title: string; body: string }[] = [
  { icon: "file", title: "Decision traceability", body: "Every status change runs through one state machine and leaves an event behind, so any outcome can be traced back." },
  { icon: "users", title: "Human oversight", body: "Borderline cases go to a person. Human Review and Request Additional Evidence are first-class outcomes." },
  { icon: "search", title: "Explainability", body: "Scores come with reasons, and the rule that produced a verdict is recorded next to it." },
  { icon: "lock", title: "Configurable rules", body: "Business rules are versioned data your team can change, not behaviour buried inside a prompt." },
  { icon: "building", title: "Enterprise workflow integration", body: "Multi-tenant and role-aware, with the portal, agent app and copilot working on one set of records." },
];

const record = [
  ["Case", "CASE-2026-A3F9C1"],
  ["AI scores (advisory)", "Medical 38 · Financial 22 · Fraud 6%"],
  ["Rule chain", "v12, 5 of 5 rules passed"],
  ["Outcome", "Approve with Loading, +25%"],
  ["Recorded", "10:05, by the rule engine"],
];

export function TrustSection() {
  return (
    <section className="bg-canvas py-20 sm:py-24 2xl:py-32">
      <Container className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div data-reveal>
          <p className="eyebrow">Built to be trusted</p>
          <h2 className="mt-3 text-3xl font-semibold leading-[1.06] tracking-[-0.03em] text-ink sm:text-5xl 2xl:text-6xl">
            AI you can put in front of an auditor.
          </h2>
          <p className="mt-5 max-w-md text-base leading-relaxed text-body 2xl:text-lg">
            Insurance AI is a prototype built around the questions a regulated insurer asks first.
          </p>

          {/* A decision record, the thing an auditor would ask to see */}
          <div className="mt-10 max-w-md rounded-2xl bg-alt p-5 shadow-card 2xl:max-w-lg 2xl:p-6" role="img" aria-label="Example decision record, demo data">
            <div aria-hidden="true">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">Decision record</p>
                <span className="rounded-full bg-card px-2.5 py-1 text-[0.6875rem] font-semibold text-brand">Immutable</span>
              </div>
              <dl className="mt-4 space-y-2.5 text-[0.8125rem]">
                {record.map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted">{k}</dt>
                    <dd className="text-right font-medium tabular-nums text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 flex items-center gap-2 text-xs font-semibold text-emerald-700">
                <Icon name="check" className="h-4 w-4" />
                Replayable step by step
              </p>
            </div>
          </div>
        </div>

        <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {principles.map((p, i) => (
            <li key={p.title} data-reveal style={stagger(i)} className={i === principles.length - 1 ? "sm:col-span-2" : ""}>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-chip text-brand">
                <Icon name={p.icon} />
              </span>
              <h3 className="mt-4 text-base font-semibold text-ink">{p.title}</h3>
              <p className="mt-1.5 max-w-md text-sm leading-relaxed text-body">{p.body}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
