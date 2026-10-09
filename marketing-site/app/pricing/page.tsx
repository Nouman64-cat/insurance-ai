import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHero, Section } from "@/components/ui/Section";
import { BlockHeader, CompareBand, FaqBand, FeatureGrid, StepsBand } from "@/components/blocks/Blocks";
import { CtaBand } from "@/components/sections/CtaBand";
import { pageMetadata } from "@/lib/seo";
import { stagger } from "@/lib/utils";

export const metadata = pageMetadata(
  "Pricing",
  "Two ways to pay for Insurance AI: a fixed Enterprise Retainer at $9,500 a month, or a Cost + Hybrid plan at $6,500 a month plus $0.40 per policy.",
  "/pricing"
);

const tiers = [
  {
    name: "Pilot",
    blurb: "Prove the workflow on one line of business.",
    features: [
      "One tenant, one product line",
      "AI underwriting and quoting",
      "Portal for operations and underwriting",
      "Guided onboarding on demo data",
    ],
  },
  {
    name: "Growth",
    blurb: "Run live business across individual and family cover.",
    highlight: true,
    features: [
      "Everything in Pilot",
      "AI copilot and the agent mobile app",
      "Claims, commissions and treasury",
      "Fraud graph and configurable rule engine",
    ],
  },
  {
    name: "Enterprise",
    blurb: "Multiple branches, group schemes and custom integration.",
    features: [
      "Everything in Growth",
      "Group life and group family takaful",
      "Branches, roles and super-admin controls",
      "Dedicated environment and integration support",
    ],
  },
];

// How the insurer pays — independent of the package (scope) above.
const models = [
  {
    name: "Enterprise Retainer",
    blurb: "One fixed fee, whatever your policy volume.",
    price: "$9,500",
    unit: "per month, flat",
    bestFor: "Best for insurers who want a fixed, predictable line in the budget.",
    terms: [
      "Billed monthly, payable within the first 7 days of the cycle",
      "No per-policy charges and nothing to reconcile",
      "No separate software development fee",
      "Service-level agreement on availability and support",
      "12-month minimum term, 90 days' notice to end it",
    ],
  },
  {
    name: "Cost + Hybrid",
    blurb: "A lower base fee, plus a small charge for each policy.",
    price: "$6,500",
    unit: "per month + $0.40 per policy",
    highlight: true,
    bestFor: "Best for insurers who want the bill to follow the business: lighter in slow months, scaling with campaigns.",
    terms: [
      "Fixed base fee of $6,500 a month",
      "$0.40 per transaction, where one policy generated is one transaction",
      "Usage itemised on every invoice",
      "Pay less in off-season months such as Ramzan",
      "No separate software development fee",
    ],
  },
];

const faq = [
  {
    q: "Which model should we choose?",
    a: "If budget certainty matters most, the Enterprise Retainer is one flat fee. If you would rather pay in line with volume, Cost + Hybrid is cheaper below roughly 7,500 policies a month and scales with you above it.",
  },
  {
    q: "What counts as a transaction on Cost + Hybrid?",
    a: "Each policy generated on the platform is one transaction, billed at $0.40. Quotes, underwriting runs and copilot conversations along the way are not billed separately.",
  },
  {
    q: "What is the minimum commitment on the Enterprise Retainer?",
    a: "Twelve months. Either side can end it with 90 days' notice; ending it before the minimum term carries an early-termination fee set out in the contract.",
  },
  {
    q: "Are the packages and the payment models separate choices?",
    a: "Yes. Pilot, Growth and Enterprise describe what you get. The Enterprise Retainer and Cost + Hybrid describe how you pay for it. Scope is agreed with each insurer.",
  },
  {
    q: "Do LLM costs come on top?",
    a: "Model usage is metered per call and reported in the platform, so you can see exactly what each workflow costs with the provider you choose.",
  },
  {
    q: "Can we start with one product line?",
    a: "Yes. The Pilot package covers one line of business and can grow into individual, family and group cover on the same tenant.",
  },
  {
    q: "Which market is it built for?",
    a: "Pakistani insurers: PKR pricing, CNIC handling, takaful as a product type, and PEP and sanctions screening are part of the core.",
  },
  {
    q: "Can it integrate with our existing systems?",
    a: "Integration support is part of the Enterprise package and is scoped with each insurer.",
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        art="stages"
        title="Engagements that grow with your book"
        description="Choose the package that fits your scope, then the way you want to pay for it: one flat retainer, or a base fee plus usage."
      />
      <Section>
        <div className="mx-auto grid max-w-[96rem] gap-4 md:grid-cols-3 2xl:gap-6">
          {tiers.map((t, i) => (
            <div
              key={t.name}
              data-reveal
              style={stagger(i)}
              className={`card flex flex-col p-6 2xl:p-8 ${t.highlight ? "border-brand ring-1 ring-brand" : ""}`}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-ink 2xl:text-xl">{t.name}</h2>
                {t.highlight && <span className="rounded-full bg-brand px-2.5 py-1 text-[0.6875rem] font-semibold text-white">Most chosen</span>}
              </div>
              <p className="mt-1 text-sm text-body">{t.blurb}</p>
              <p className="mt-5 text-3xl font-semibold tracking-tight text-ink">Custom</p>
              <ul className="mt-5 flex-1 space-y-2.5">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-body 2xl:text-[1rem]">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <ButtonLink href="/contact" variant={t.highlight ? "brand" : "ghost"} arrow>
                  Talk to us
                </ButtonLink>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <section className="bg-alt py-16 sm:py-20 2xl:py-28">
        <div className="mx-auto w-full max-w-[150rem] px-4 sm:px-6 lg:px-10 2xl:px-16">
          <BlockHeader
            eyebrow="Two ways to pay"
            title="A flat retainer, or a base fee plus usage"
            description="Both include 24/7 availability of the platform, 24/7 technical support, and full observability and audit trails. They differ only in how the bill is worked out."
          />
          <div className="mt-10 grid gap-4 md:grid-cols-2 2xl:mt-14 2xl:gap-6">
            {models.map((m, i) => (
              <div
                key={m.name}
                data-reveal
                style={stagger(i)}
                className={`card flex flex-col p-6 2xl:p-8 ${m.highlight ? "border-brand ring-1 ring-brand" : ""}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold text-ink 2xl:text-xl">{m.name}</h3>
                  {m.highlight && (
                    <span className="rounded-full bg-brand px-2.5 py-1 text-[0.6875rem] font-semibold text-white">Scales with you</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-body">{m.blurb}</p>
                <p className="mt-5 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-4xl font-semibold tracking-tight text-ink">{m.price}</span>
                  <span className="text-sm text-muted">{m.unit}</span>
                </p>
                <ul className="mt-5 flex-1 space-y-2.5">
                  {m.terms.map((t) => (
                    <li key={t} className="flex items-start gap-2.5 text-sm text-body 2xl:text-[1rem]">
                      <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      {t}
                    </li>
                  ))}
                </ul>
                <p className="mt-5 text-sm font-medium text-ink">{m.bestFor}</p>
                <div className="mt-6">
                  <ButtonLink href="/contact" variant={m.highlight ? "brand" : "ghost"} arrow>
                    Discuss this model
                  </ButtonLink>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CompareBand
        eyebrow="What a month costs"
        title="The same month, under each model"
        description="Illustrative monthly bills at three policy volumes. On Cost + Hybrid, one policy generated is one transaction at $0.40."
        heads={["Slow month · 3,000 policies", "Normal month · 10,000 policies", "Peak month · 25,000 policies"]}
        rows={[
          { label: "Enterprise Retainer", cells: ["$9,500", "$9,500", "$9,500"] },
          {
            label: "Cost + Hybrid",
            cells: [
              "$7,700 ($6,500 base + $1,200 usage)",
              "$10,500 ($6,500 base + $4,000 usage)",
              "$16,500 ($6,500 base + $10,000 usage)",
            ],
          },
        ]}
      />

      <FeatureGrid
        tone="alt"
        eyebrow="In every engagement"
        title="What you get whichever package you choose"
        description="The foundations are the same everywhere. The packages differ in scope, not in rigour."
        items={[
          { icon: "lock", title: "An isolated tenant", body: "Your plans, rules and users live in their own tenant, behind JWT authentication and roles." },
          { icon: "shield", title: "A deterministic rule engine", body: "Verdicts come from a rule chain your team can read, test and configure." },
          { icon: "file", title: "An immutable audit trail", body: "Every policy status change leaves an event behind, so any decision can be replayed." },
          { icon: "spark", title: "Choice of LLM provider", body: "Gemini, OpenAI or Anthropic, with a runtime fallback and encrypted credentials." },
          { icon: "building", title: "Local by default", body: "CNIC handling, PKR pricing, takaful products, and PEP and sanctions screening." },
          { icon: "chart", title: "Usage you can see", body: "Model usage is metered per call and reported, so each workflow's cost is visible." },
        ]}
      />

      <StepsBand
        tone="canvas"
        eyebrow="How an engagement runs"
        title="From first conversation to live business"
        steps={[
          { title: "Discover", body: "We map your lines of business, your rules and the questions your underwriters ask first." },
          { title: "See it", body: "A walkthrough on demo data, shaped around your scenarios." },
          { title: "Pilot", body: "One tenant and one product line, with your rules configured and your team using it." },
          { title: "Grow", body: "Add products, branches, group schemes and integrations as the pilot proves itself." },
        ]}
      />

      <FaqBand tone="alt" title="Pricing questions" items={faq} />
      <CtaBand title="Let's scope the right engagement" description="Tell us about your book and we will propose a package to match." />
    </>
  );
}
