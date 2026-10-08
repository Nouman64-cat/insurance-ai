import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHero, Section, SectionHeader } from "@/components/ui/Section";
import { CtaBand } from "@/components/sections/CtaBand";
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
        description="Insurance AI is an AI-powered, multi-tenant life insurance platform built for Pakistani insurers, designed so that every automated step can be justified to an underwriter, an auditor or a customer."
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

      <Section tone="muted">
        <div className="mx-auto max-w-3xl 2xl:max-w-4xl">
          <SectionHeader eyebrow="Status" title="A working prototype" />
          <p className="mt-5 leading-relaxed text-body">
            The underwriting pipeline, copilot, claims journey, fraud graph, group and family workflows and the agent
            app are built and running end to end. Plans, rates and customer data on this site are demo data while we
            work with early insurers on real catalogues and integrations.
          </p>
        </div>
      </Section>

      <CtaBand title="Want to see it with your own scenarios?" />
    </>
  );
}
