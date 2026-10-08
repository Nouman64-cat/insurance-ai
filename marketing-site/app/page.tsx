import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Container, Section, SectionHeader } from "@/components/ui/Section";
import { HeroIllustration } from "@/components/art/HeroIllustration";
import { HeroFlow } from "@/components/sections/HeroFlow";
import { UnderwritingMock } from "@/components/mocks/UnderwritingMock";
import { CopilotMock } from "@/components/mocks/CopilotMock";
import { AgentMock } from "@/components/mocks/AgentMock";
import { Lifecycle } from "@/components/sections/Lifecycle";
import { ProductCards } from "@/components/sections/FeatureCards";
import { Faq } from "@/components/sections/Faq";
import { CtaBand } from "@/components/sections/CtaBand";
import { CountUp } from "@/components/effects/CountUp";
import { facts, homeFaq, pillars } from "@/content/home";
import { stagger } from "@/lib/utils";

const verdicts = [
  "Auto Approve",
  "Approve with Loading",
  "Human Review",
  "Request Additional Evidence",
  "Fraud Investigation",
  "Postpone",
  "Decline",
];

export default function HomePage() {
  return (
    <>
      <section className="relative -mt-16 overflow-hidden bg-base">
        {/* Pale blue wash behind the hero. Static layers: painted once. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -left-[10%] top-[-35%] h-[48rem] w-[48rem] rounded-full bg-[radial-gradient(closest-side,rgba(37,99,235,0.14),transparent)]" />
          <div className="absolute -right-[12%] top-[0%] h-[52rem] w-[52rem] rounded-full bg-[radial-gradient(closest-side,rgba(96,165,250,0.2),transparent)]" />
        </div>

        <Container className="relative grid items-start gap-12 pb-16 pt-[calc(4rem+3rem)] sm:pb-24 sm:pt-[calc(4rem+4rem)] lg:grid-cols-[1fr_1.1fr] lg:pb-32 2xl:gap-24 2xl:pb-40 2xl:pt-[calc(4rem+5rem)]">
          <div className="lg:pt-6 2xl:pt-12">
            <p className="eyebrow intro-left" style={stagger(0)}>
              AI-assisted underwriting for life and takaful insurers
            </p>
            <h1
              className="intro-left mt-3 text-4xl font-semibold tracking-tight sm:text-5xl lg:text-[4rem] lg:leading-[1.08] 2xl:text-[5rem]"
              style={stagger(1)}
            >
              From lead to claim, on one auditable platform.
            </h1>
            <p className="intro-left mt-5 max-w-xl text-lg leading-relaxed text-body 2xl:max-w-2xl" style={stagger(2)}>
              Insurance AI scores medical, financial and fraud risk with language models, then lets deterministic
              rules make the call. Every step, from the first quote to the final payout, leaves a record you can
              replay.
            </p>
            <div className="intro-left mt-8 flex flex-wrap gap-3" style={stagger(3)}>
              <ButtonLink href="/contact">Request a demo</ButtonLink>
              <ButtonLink href="/platform" variant="ghost">
                Explore the platform
              </ButtonLink>
            </div>
            <HeroFlow />
          </div>
          <div className="intro-right relative" style={stagger(2)}>
            <HeroIllustration kind="family" className="mx-auto h-auto w-full max-w-[44rem]" />
            <div className="relative mt-4 lg:-mt-16 lg:ml-2 lg:w-[19rem] 2xl:w-[22rem]">
              <UnderwritingMock />
            </div>
          </div>
        </Container>
      </section>

      <Section tone="white">
        <dl className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          {facts.map((f, i) => (
            <div key={f.label} data-reveal style={stagger(i)} className="border-l-2 border-brand pl-4">
              <dt className="sr-only">{f.label}</dt>
              <dd className="text-3xl font-semibold tabular-nums text-ink">
                <CountUp value={Number(f.value)} />
              </dd>
              <p className="mt-1 text-sm text-body">{f.label}</p>
            </div>
          ))}
        </dl>
      </Section>

      <Section tone="muted" id="journey">
        <SectionHeader
          eyebrow="The policy journey"
          title="One platform for every stage of a policy"
          description="Seven connected stages share the same customer, case and policy records, so nothing is re-entered and nothing is lost between teams."
        />
        <div className="mt-10">
          <Lifecycle />
        </div>
      </Section>

      <Section>
        <div className="grid items-start gap-12 lg:grid-cols-2 2xl:gap-24">
          <div>
            <SectionHeader
              eyebrow="AI underwriting"
              title="Models assess. Rules decide."
              description="A language model reading a medical report is useful. A language model deciding whether to decline someone is not auditable. We keep the first and replace the second with a rule chain."
            />
            <ul className="mt-8 grid gap-2 sm:grid-cols-2">
              {verdicts.map((v, i) => (
                <li key={v} data-reveal style={stagger(i)} className="flex items-center gap-2 text-sm text-body">
                  <Icon name="check" className="h-4 w-4 shrink-0 text-emerald-600" />
                  {v}
                </li>
              ))}
            </ul>
            <div data-reveal className="mt-8">
              <ButtonLink href="/platform/ai-underwriting" variant="ghost">
                How underwriting works
                <Icon name="arrow" className="h-4 w-4" />
              </ButtonLink>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {pillars.map((p, i) => (
              <div key={p.title} data-reveal="right" style={stagger(i)} className="card p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/15 text-accent">
                  <Icon name={p.icon} />
                </span>
                <h3 className="mt-3 text-sm font-semibold text-ink">{p.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-body">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section tone="muted">
        <div className="grid items-center gap-12 lg:grid-cols-2 2xl:gap-24">
          <div data-reveal="left">
            <CopilotMock />
          </div>
          <div>
            <SectionHeader
              eyebrow="AI copilot"
              title="A teammate that asks before it acts"
              description="The copilot can onboard a lead, open a case and run the underwriting pipeline from a chat message. Anything that changes data pauses for a yes or no, enforced in code rather than left to the prompt."
            />
            <div data-reveal className="mt-8">
              <ButtonLink href="/platform/ai-copilot" variant="ghost">
                Meet the copilot
                <Icon name="arrow" className="h-4 w-4" />
              </ButtonLink>
            </div>
          </div>
        </div>
      </Section>

      <Section>
        <SectionHeader
          eyebrow="Products"
          title="Individual, family and corporate cover"
          description="Conventional and takaful plans share one lifecycle, with the differences modelled where they matter."
        />
        <div className="mt-10">
          <ProductCards />
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
              <ButtonLink href="/platform/agent-app" variant="ghost">
                See the agent app
                <Icon name="arrow" className="h-4 w-4" />
              </ButtonLink>
            </div>
          </div>
          <div data-reveal="right">
            <AgentMock />
          </div>
        </div>
      </Section>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <SectionHeader eyebrow="Questions" title="What teams usually ask first" />
          <Faq items={homeFaq} />
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
