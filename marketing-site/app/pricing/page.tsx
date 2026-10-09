import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHero, Section } from "@/components/ui/Section";
import { FaqBand, FeatureGrid, StepsBand } from "@/components/blocks/Blocks";
import { CtaBand } from "@/components/sections/CtaBand";
import { pageMetadata } from "@/lib/seo";
import { stagger } from "@/lib/utils";

export const metadata = pageMetadata(
  "Pricing",
  "Pilot, growth and enterprise engagements for insurers. Demo packaging while Insurance AI is a prototype.",
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

const faq = [
  {
    q: "Why are there no prices?",
    a: "Insurance AI is a prototype, so packaging is illustrative. We will agree scope and terms directly during the demo phase.",
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
        description="Three illustrative packages. Final scope and commercials are agreed with each insurer."
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
        eyebrow="How an engagement runs"
        title="From first conversation to live business"
        steps={[
          { title: "Discover", body: "We map your lines of business, your rules and the questions your underwriters ask first." },
          { title: "See it", body: "A walkthrough on demo data, shaped around your scenarios." },
          { title: "Pilot", body: "One tenant and one product line, with your rules configured and your team using it." },
          { title: "Grow", body: "Add products, branches, group schemes and integrations as the pilot proves itself." },
        ]}
      />

      <FaqBand tone="canvas" title="Pricing questions" items={faq} />
      <CtaBand title="Let's scope the right engagement" description="Tell us about your book and we will propose a package to match." />
    </>
  );
}
