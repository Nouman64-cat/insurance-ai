import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHero, Section } from "@/components/ui/Section";
import { Faq } from "@/components/sections/Faq";
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
];

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Engagements that grow with your book"
        description="Three illustrative packages. Final scope and commercials are agreed with each insurer."
      />
      <Section>
        <div className="mx-auto grid max-w-[84rem] gap-4 md:grid-cols-3">
          {tiers.map((t, i) => (
            <div
              key={t.name}
              data-reveal
              style={stagger(i)}
              className={`card flex flex-col p-6 ${t.highlight ? "border-brand ring-1 ring-brand" : ""}`}
            >
              <h2 className="text-lg font-semibold text-ink">{t.name}</h2>
              <p className="mt-1 text-sm text-body">{t.blurb}</p>
              <p className="mt-5 text-2xl font-semibold text-ink">Custom</p>
              <ul className="mt-5 flex-1 space-y-2.5">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-body">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <ButtonLink href="/contact" variant={t.highlight ? "brand" : "ghost"}>
                  Talk to us
                </ButtonLink>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section tone="muted">
        <div className="mx-auto max-w-3xl">
          <Faq items={faq} />
        </div>
      </Section>
    </>
  );
}
