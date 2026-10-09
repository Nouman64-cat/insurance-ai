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
        {/* Pale blue wash behind the hero. Static layers: painted once. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -left-[10%] top-[-35%] h-[48rem] w-[48rem] rounded-full bg-[radial-gradient(closest-side,rgba(37,99,235,0.12),transparent)]" />
          <div className="absolute -right-[12%] top-[0%] h-[52rem] w-[52rem] rounded-full bg-[radial-gradient(closest-side,rgba(96,165,250,0.18),transparent)]" />
        </div>

        <Container className="relative pb-16 pt-[calc(4rem+3.5rem)] sm:pt-[calc(4rem+5rem)] lg:pb-20 2xl:pb-28 2xl:pt-[calc(4rem+7rem)]">
          <HeroDecisionFeed className="intro-right absolute right-10 top-[calc(4rem+5rem)] hidden w-[38%] max-w-[38rem] min-[1400px]:block 2xl:right-16 2xl:top-[calc(4rem+7rem)]" />
          <p className="eyebrow fade-up-intro" style={stagger(0)}>
            AI-powered insurance intelligence
          </p>
          <h1 className="mt-5 text-[clamp(2.75rem,6.4vw,6.75rem)] font-semibold leading-[1.02] tracking-[-0.035em] text-ink">
            <span className="hero-line">
              <span style={stagger(0)}>From lead to claim.</span>
            </span>
            <span className="hero-line">
              <span style={stagger(1)}>Every decision, explained.</span>
            </span>
          </h1>

          <div className="mt-8 grid gap-10 lg:mt-12 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-6 xl:col-span-5">
              <p className="fade-up-intro max-w-xl text-lg leading-relaxed text-body 2xl:max-w-2xl 2xl:text-xl" style={stagger(3)}>
                AI-assisted underwriting for life and takaful insurers. Analyze medical, financial, and fraud risk,
                apply deterministic rules, and maintain a complete audit trail from quote to payout.
              </p>
              <div className="fade-up-intro mt-8 flex flex-wrap gap-3" style={stagger(4)}>
                <ButtonLink href="/contact" arrow>
                  Request a demo
                </ButtonLink>
                <ButtonLink href="/platform" variant="ghost">
                  Explore the platform
                </ButtonLink>
              </div>
            </div>

            <ul className="fade-up-intro grid gap-4 sm:grid-cols-3 lg:col-span-6 lg:col-start-7 xl:col-span-6 xl:col-start-7" style={stagger(5)}>
              {cues.map((c) => (
                <li key={c.title} className="border-t-2 border-brand pt-3">
                  <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <Icon name={c.icon} className="h-4 w-4 text-brand" />
                    {c.title}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{c.body}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="fade-up-intro mt-12 lg:mt-16 2xl:mt-20" style={stagger(6)}>
            <ProductSurface stage={3} />
          </div>

          <ScrollCue />
        </Container>
      </section>

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
