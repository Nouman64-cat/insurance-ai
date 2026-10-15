import { ButtonLink } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Container, Section, SectionHeader } from "@/components/ui/Section";
import { ProductSurface } from "@/components/product/ProductSurface";
import { ProductStory } from "@/components/sections/ProductStory";
import { HeroDecisionFeed } from "@/components/sections/HeroDecisionFeed";
import { ScrollCue } from "@/components/sections/ScrollCue";
import { WhyInsuranceAI } from "@/components/sections/WhyInsuranceAI";
import { JourneyExplorer } from "@/components/sections/JourneyExplorer";
import { TrustSection } from "@/components/sections/TrustSection";
import { CopilotMock } from "@/components/mocks/CopilotMock";
import { AgentMock } from "@/components/mocks/AgentMock";
import { Lifecycle } from "@/components/sections/Lifecycle";
import { ProductCards } from "@/components/sections/FeatureCards";
import { Faq } from "@/components/sections/Faq";
import { CtaBand } from "@/components/sections/CtaBand";
import { homeFaq } from "@/content/home";
import { stagger } from "@/lib/utils";

const cues: { icon: IconName; title: string; body: string }[] = [
  { icon: "spark", title: "AI insights", body: "Medical, financial and fraud risk, scored in parallel" },
  { icon: "shield", title: "Rule-based decisions", body: "Deterministic, configurable, identical every time" },
  { icon: "file", title: "Auditable outcomes", body: "Every step recorded and replayable" },
];

export default function HomePage() {
  return (
    <>
      <section className="relative -mt-16 overflow-hidden bg-canvas">
        {/* Faint grid, and a violet horizon: a glow behind the edge of a huge dark ellipse. Static layers. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="bg-grid absolute inset-0" />
          <div className="glow-arc absolute inset-x-[-20%] bottom-0 h-[26rem]" />
          <div className="absolute left-1/2 top-[calc(100%-7rem)] h-[60rem] w-[200%] -translate-x-1/2 rounded-[50%] border-t border-brand/30 bg-canvas shadow-[0_-24px_90px_-30px_rgb(37_99_235/0.35)] sm:w-[160%]" />
        </div>

        <Container className="relative pb-36 pt-[calc(4rem+3rem)] text-center sm:pb-44 sm:pt-[calc(4rem+4.5rem)] 2xl:pt-[calc(4rem+6rem)]">
          <p className="eyebrow fade-up-intro glass inline-flex rounded-full px-3.5 py-1.5" style={stagger(0)}>
            AI-powered insurance intelligence
          </p>
          <h1 className="mx-auto mt-6 text-[clamp(2.5rem,6vw,5.5rem)] font-semibold leading-[1.04] tracking-[-0.035em] text-ink">
            <span className="hero-line">
              <span style={stagger(0)}>From lead to claim.</span>
            </span>
            <span className="hero-line">
              <span style={stagger(1)}>Every decision, <span className="text-brand-gradient">explained.</span></span>
            </span>
          </h1>

          <p className="fade-up-intro mx-auto mt-6 max-w-[40rem] text-lg leading-relaxed text-body" style={stagger(3)}>
            AI-assisted underwriting for life and takaful insurers. Analyze medical, financial, and fraud risk,
            apply deterministic rules, and maintain a complete audit trail from quote to payout.
          </p>
          <div className="fade-up-intro mt-8 flex flex-wrap justify-center gap-3" style={stagger(4)}>
            <ButtonLink href="/contact" arrow>
              Request a demo
            </ButtonLink>
            <ButtonLink href="/platform" variant="ghost">
              Explore the platform
            </ButtonLink>
          </div>

          <div className="fade-up-intro mx-auto mt-14 max-w-[40rem] text-left" style={stagger(5)}>
            <HeroDecisionFeed className="w-full" />
          </div>

          <ul className="fade-up-intro mx-auto mt-12 grid max-w-[56rem] gap-8 md:grid-cols-3 md:gap-6" style={stagger(6)}>
            {cues.map((c) => (
              <li key={c.title}>
                <p className="flex items-center justify-center gap-2 text-sm font-semibold text-ink">
                  <Icon name={c.icon} className="h-4 w-4 text-accent" />
                  {c.title}
                </p>
                <p className="mx-auto mt-1 max-w-[18rem] text-xs leading-relaxed text-muted">{c.body}</p>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      <Container className="pb-16 lg:pb-20 2xl:pb-28">
        <div className="fade-up-intro" style={stagger(7, 7)}>
          <ProductSurface stage={3} />
        </div>

        <ScrollCue />
      </Container>

      <ProductStory />

      <WhyInsuranceAI />

      <JourneyExplorer />

      <Section>
        <div className="grid items-center gap-12 lg:grid-cols-2 2xl:gap-24">
          <div data-reveal="left" className="min-[1536px]:[zoom:1.22]">
            <CopilotMock />
          </div>
          <div>
            <SectionHeader
              eyebrow="AI copilot"
              title="A teammate that asks before it acts"
              description="The copilot can onboard a lead, open a case and run the underwriting pipeline from a chat message. Anything that changes data pauses for a yes or no, enforced in code rather than left to the prompt."
            />
            <div data-reveal className="mt-8">
              <ButtonLink href="/platform/ai-copilot" variant="ghost" arrow>
                Meet the copilot
              </ButtonLink>
            </div>
          </div>
        </div>
      </Section>

      <Section tone="muted">
        <div className="grid items-center gap-12 lg:grid-cols-2 2xl:gap-24">
          <div>
            <SectionHeader
              eyebrow="Agent app"
              title="Field agents get the whole workflow on their phone"
              description="Lead board, tokenised e-application links, the confidential agent report and commissions. Leads created in the portal show up without a refresh."
            />
            <div data-reveal className="mt-8">
              <ButtonLink href="/platform/agent-app" variant="ghost" arrow>
                See the agent app
              </ButtonLink>
            </div>
          </div>
          <div data-reveal="right" className="min-[1536px]:[zoom:1.22]">
            <AgentMock />
          </div>
        </div>
      </Section>

      <Section id="journey">
        <SectionHeader
          eyebrow="The policy journey"
          title="One platform for every stage of a policy"
          description="Seven connected stages share the same customer, case and policy records, so nothing is re-entered and nothing is lost between teams."
        />
        <div className="mt-10">
          <Lifecycle />
        </div>
      </Section>

      <Section tone="muted">
        <SectionHeader
          eyebrow="Products"
          title="Individual, family and corporate cover"
          description="Conventional and takaful plans share one lifecycle, with the differences modelled where they matter."
        />
        <div className="mt-10">
          <ProductCards />
        </div>
      </Section>

      <TrustSection />

      <Section tone="muted">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <SectionHeader eyebrow="Questions" title="What teams usually ask first" />
            <div data-reveal className="mt-8 max-w-md rounded-2xl bg-card p-5 shadow-card 2xl:max-w-lg 2xl:p-6">
              <p className="text-sm font-semibold text-ink">Want to see it on your own cases?</p>
              <p className="mt-1.5 text-sm leading-relaxed text-body">
                We will walk through a lead becoming a policy and a claim on demo data, and answer anything this page
                does not.
              </p>
              <div className="mt-4">
                <ButtonLink href="/contact" arrow>
                  Request a demo
                </ButtonLink>
              </div>
            </div>
          </div>
          <Faq items={homeFaq} />
        </div>
      </Section>

      <CtaBand
        title="Ready to make insurance decisions clearer?"
        description="We will walk you through a lead becoming a policy and a claim on demo data, with the AI advising and your rules deciding."
      />
    </>
  );
}
