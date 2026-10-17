import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHero } from "@/components/ui/Section";
import { BlockHeader, CompareBand, FaqBand, FeatureGrid, StepsBand } from "@/components/blocks/Blocks";
import { CtaBand } from "@/components/sections/CtaBand";
import { PricingCalculator } from "@/components/sections/PricingCalculator";
import { HYBRID_BASE_MONTHLY, RETAINER_MONTHLY, usd } from "@/content/pricing";
import { pageMetadata } from "@/lib/seo";
import { stagger } from "@/lib/utils";

export const metadata = pageMetadata(
  "Pricing",
  "Two ways to pay for Insurance AI: a fixed Enterprise Retainer at $11,500 a month, or a Cost + Hybrid plan at $9,050 a month plus AI usage passed through at cost.",
  "/pricing"
);

// The two commercial models.
const models = [
  {
    name: "Enterprise Retainer",
    blurb: "One fixed fee, whatever your policy volume.",
    price: usd(RETAINER_MONTHLY),
    unit: "per month, flat",
    bestFor: "Best for insurers who want a fixed, predictable line in the budget.",
    terms: [
      "Billed monthly, payable within the first 7 days of the cycle",
      "Infrastructure and AI usage included, with no per-case charges to reconcile",
      "No separate software development fee",
      "Service-level agreement on availability and support",
      "12-month minimum term, 90 days' notice to end it",
    ],
  },
  {
    name: "Cost + Hybrid",
    blurb: "A lower base fee, plus AI usage passed through at cost.",
    price: usd(HYBRID_BASE_MONTHLY),
    unit: "per month + AI usage at cost",
    highlight: true,
    bestFor: "Best for insurers who want the bill to follow the business, with no mark-up on AI usage.",
    terms: [
      "Fixed base fee of $9,050 a month for the platform, infrastructure and support",
      "AI usage at cost, per case: $0.30 individual, $0.60 family, $1.00 corporate scheme",
      "A corporate scheme is billed once, however many employees it covers",
      "Usage itemised by case type on every invoice",
      "Pay less in off-season months such as Ramzan",
      "No separate software development fee",
    ],
  },
];

const faq = [
  {
    q: "Which model should we choose?",
    a: "If budget certainty matters most, the Enterprise Retainer is one flat fee. If you would rather pay in line with volume, Cost + Hybrid is cheaper below roughly 6,700 cases a month at a typical case mix, and scales with you above it.",
  },
  {
    q: "What counts as a case on Cost + Hybrid?",
    a: "One application taken through the platform. Its AI usage is passed through at cost: $0.30 for an individual, $0.60 for a family and $1.00 for a corporate scheme, which is billed once however many employees it covers. Quotes, underwriting runs and copilot conversations within a case are not billed separately.",
  },
  {
    q: "What is the minimum commitment on the Enterprise Retainer?",
    a: "Twelve months. Either side can end it with 90 days' notice; ending it before the minimum term carries an early-termination fee set out in the contract.",
  },

  {
    q: "Do LLM costs come on top?",
    a: "Model usage is metered per call and reported in the platform, so you can see exactly what each workflow costs with the provider you choose.",
  },
  {
    q: "Can we start with one product line?",
    a: "Yes. You can start with one line of business and grow into individual, family and group cover on the same tenant.",
  },
  {
    q: "Which market is it built for?",
    a: "Pakistani insurers: PKR pricing, CNIC handling, takaful as a product type, and PEP and sanctions screening are part of the core.",
  },
  {
    q: "Can it integrate with our existing systems?",
    a: "Yes. Integration support is scoped with each insurer as part of onboarding.",
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        art="stages"
        title="Engagements that grow with your book"
        description="Two simple ways to pay: one flat monthly retainer, or a lower base fee plus AI usage at cost."
      />

      <section className="bg-canvas py-16 sm:py-20 2xl:py-28">
        <div className="mx-auto w-full max-w-[150rem] px-4 sm:px-6 lg:px-10 2xl:px-16">
          <BlockHeader
            eyebrow="Two ways to pay"
            title="A flat retainer, or a base fee plus usage"
            description="Both include 24/7 availability of the platform, 24/7 technical support, and full observability and audit trails. They differ only in how the bill is worked out. Try your own volume in the calculator below."
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

      <PricingCalculator />

      <CompareBand
        tone="canvas"
        eyebrow="What a month costs"
        title="The same month, under each model"
        description="Illustrative monthly bills at three case volumes for a large life insurer, with a typical mix of individual, family and corporate cases."
        heads={["Lighter year · ~5,400 cases/month", "Expected · ~6,300 cases/month", "Busier year · ~8,000 cases/month"]}
        rows={[
          { label: "Enterprise Retainer", cells: ["$11,500", "$11,500", "$11,500"] },
          {
            label: "Cost + Hybrid",
            cells: [
              "$10,950 ($9,050 base + $1,900 AI usage)",
              "$11,333 ($9,050 base + $2,283 AI usage)",
              "$12,196 ($9,050 base + $3,146 AI usage)",
            ],
          },
          {
            label: "Case mix behind it",
            cells: [
              "~4,580 individual · ~830 family · ~25 corporate",
              "~5,000 individual · ~1,250 family · ~33 corporate",
              "~5,540 individual · ~2,375 family · ~58 corporate",
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
