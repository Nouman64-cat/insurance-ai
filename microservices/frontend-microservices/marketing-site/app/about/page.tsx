import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHero, Section, SectionHeader } from "@/components/ui/Section";
import { CtaBand } from "@/components/sections/CtaBand";
import { FeatureGrid, StatementBand } from "@/components/blocks/Blocks";
import { TrustSection } from "@/components/sections/TrustSection";
import { pageMetadata } from "@/lib/seo";
import { stagger } from "@/lib/utils";

export const metadata = pageMetadata(
  "About",
  "How GetInsuredAI connects insurance teams with advisory AI, configurable rules and human approval controls.",
  "/about"
);

const principles: { title: string; body: string; icon: IconName }[] = [
  {
    title: "Deterministic where it matters",
    body: "Configured rules support premium calculations, requirements, risk recommendations and commissions. Authorised staff retain the reviews and decisions assigned to their roles.",
    icon: "shield",
  },
  {
    title: "Humans stay in the loop",
    body: "Specialists record their own findings. Admin records claim-referral underwriting outcomes, Claims Managers decide claims and authorise settlements, and Finance records external payments.",
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
        description="GetInsuredAI is an AI-powered, multi-tenant life insurance platform built for Pakistani insurers, designed so that every automated step can be justified to an underwriter, an auditor or a customer. It is developed by Rizviz International Impex."
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
          { word: "People decide.", note: "Rules and AI support evidence review. Human reviews, claim decisions and settlement authorisation remain explicit, separate records." },
          { word: "Audit proves.", note: "Recorded assessments, rule results and human rationale help teams trace how an outcome was reached." },
        ]}
      />

      <FeatureGrid
        eyebrow="Status"
        title="Connected workflows for insurance operations"
        description="The platform connects underwriting, claims, Finance and servicing. Website examples use illustrative records; each insurer configures its catalogue, rules, roles and integrations."
        items={[
          { icon: "spark", title: "Underwriting pipeline", body: "Lead screening, medical and financial specialist reviews, and advisory AI findings." },
          { icon: "chat", title: "AI copilot", body: "Role-specific tools and skills for requested work in chat and English or Urdu live voice." },
          { icon: "coin", title: "Claims journey", body: "Evidence review, human claim decisions, payee verification, manager authorisation and Finance reconciliation." },
          { icon: "coin", title: "Finance and commissions", body: "External-payment records and reconciliation, plus receipt-driven commission earnings and adjustment history." },
          { icon: "users", title: "Group and family workflows", body: "Census upload for employers, nominee shares for families, on the same lifecycle." },
          { icon: "phone", title: "Agent mobile app", body: "Lead board, e-application links, the confidential agent report and commissions." },
        ]}
      />

      <TrustSection />

      <CtaBand title="Want to see it with your own scenarios?" />
    </>
  );
}
