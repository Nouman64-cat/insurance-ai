import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHero, Section, SectionHeader } from "@/components/ui/Section";
import { CtaBand } from "@/components/sections/CtaBand";
import { FeatureGrid, StatementBand } from "@/components/blocks/Blocks";
import { TrustSection } from "@/components/sections/TrustSection";
import { pageMetadata } from "@/lib/seo";
import { stagger } from "@/lib/utils";

export const metadata = pageMetadata(
  "About",
  "Why Insurance AI keeps decisions deterministic, humans in the loop and every change auditable.",
  "/about"
);

const principles: { title: string; body: string; icon: IconName }[] = [
  {
    title: "Deterministic where it matters",
    body: "Pricing, requirements and underwriting verdicts are computed by rules that can be read, tested and replayed. Language models stay on the interpretation side of the line.",
    icon: "shield",
  },
  {
    title: "Humans stay in the loop",
    body: "Borderline risks, large claims and every data-changing copilot action stop for a person. Automation removes busywork, not accountability.",
    icon: "users",
  },
  {
    title: "Everything leaves a trail",
    body: "One policy state machine, immutable lifecycle events and persisted assessments mean you can answer why something happened months later.",
    icon: "file",
  },
  {
    title: "Local from the start",
    body: "CNIC validation, PKR pricing, takaful as a first-class product type and sanctions screening are part of the core, not an add-on.",
    icon: "building",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title="Insurance technology that can explain itself"
        description="Insurance AI is an AI-powered, multi-tenant life insurance platform built for Pakistani insurers, designed so that every automated step can be justified to an underwriter, an auditor or a customer. It is developed by Rizviz International Impex."
      />

      <Section>
        <SectionHeader eyebrow="Principles" title="How we build" />
        <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {principles.map((p, i) => (
            <div key={p.title} data-reveal style={stagger(i)} className="card p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/15 text-accent">
                <Icon name={p.icon} />
              </span>
              <h3 className="mt-4 text-base font-semibold text-ink">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-body">{p.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <StatementBand
        tone="alt"
        lines={[
          { word: "Models advise.", note: "Language models read evidence and score risk. Their output is advice, and it is always labelled as advice." },
          { word: "Rules decide.", note: "A deterministic, versioned rule chain chooses the verdict, so the same inputs always give the same outcome." },
          { word: "Audit proves.", note: "Every input, rule and outcome is recorded, so a decision can be replayed months later." },
        ]}
      />

      <FeatureGrid
        eyebrow="Status"
        title="A working prototype, built end to end"
        description="Plans, rates and customer data on this site are demo data while we work with early insurers on real catalogues and integrations."
        items={[
          { icon: "spark", title: "Underwriting pipeline", body: "Medical, financial and fraud scoring, then a rule-based verdict with reasons." },
          { icon: "chat", title: "AI copilot", body: "Onboards leads and runs workflows from chat, pausing for confirmation before any change." },
          { icon: "coin", title: "Claims journey", body: "Triage, fraud checks, adjudication, payout and recovery, with a human wherever it matters." },
          { icon: "graph", title: "Fraud graph", body: "A relationship graph that finds what a single application cannot show." },
          { icon: "users", title: "Group and family workflows", body: "Census upload for employers, nominee shares for families, on the same lifecycle." },
          { icon: "phone", title: "Agent mobile app", body: "Lead board, e-application links, the confidential agent report and commissions." },
        ]}
      />

      <TrustSection />

      <CtaBand title="Want to see it with your own scenarios?" />
    </>
  );
}
