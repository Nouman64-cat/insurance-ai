import { PageHero, Section, SectionHeader } from "@/components/ui/Section";
import { PlatformCards } from "@/components/sections/FeatureCards";
import { Lifecycle } from "@/components/sections/Lifecycle";
import { WhyInsuranceAI } from "@/components/sections/WhyInsuranceAI";
import { TrustSection } from "@/components/sections/TrustSection";
import { FeatureGrid } from "@/components/blocks/Blocks";
import { CtaBand } from "@/components/sections/CtaBand";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Platform",
  "AI underwriting, an AI copilot, claims, fraud intelligence and a field-agent app on one multi-tenant platform.",
  "/platform"
);

export default function PlatformPage() {
  return (
    <>
      <PageHero
        art="stages"
        eyebrow="Platform"
        title="Everything between a lead and a claim"
        description="Five capabilities share one data model, one event stream and one audit trail."
      />
      <Section>
        <PlatformCards />
      </Section>
      <WhyInsuranceAI />
      <Section tone="muted">
        <SectionHeader eyebrow="Lifecycle" title="Where each capability fits" />
        <div className="mt-10">
          <Lifecycle />
        </div>
      </Section>
      <FeatureGrid
        eyebrow="Under the hood"
        title="One foundation under every capability"
        description="The same building blocks serve the portal, the agent app and the copilot."
        items={[
          { icon: "lock", title: "Multi-tenant and role-aware", body: "Each insurer runs in an isolated tenant with its own plans, rules and users, behind JWT authentication." },
          { icon: "file", title: "One policy state machine", body: "Every status change runs through the same state machine and leaves an immutable event behind." },
          { icon: "spark", title: "Three LLM providers", body: "Gemini, OpenAI and Anthropic, with a primary and a fallback chosen at runtime. Credentials are encrypted at rest." },
          { icon: "graph", title: "Fraud graph", body: "Relationships between customers, policies and claims are analysed as a graph, so a single application is never judged in isolation." },
          { icon: "building", title: "Built for Pakistan", body: "CNIC handling, PKR pricing, takaful as a distinct product type, and PEP and sanctions screening." },
          { icon: "chat", title: "A copilot with confirmation gates", body: "Anything that changes data pauses for a yes or no, enforced in code rather than left to the prompt." },
        ]}
      />
      <TrustSection />
      <CtaBand />
    </>
  );
}
