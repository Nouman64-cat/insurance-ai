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
  "Specialist underwriting, role-specific copilots, claims, Finance, commissions and customer channels on one platform.",
  "/platform"
);

export default function PlatformPage() {
  return (
    <>
      <PageHero
        art="stages"
        eyebrow="Platform"
        title="Everything between a lead and a claim"
        description="Connected workspaces share operational records while preserving each team’s responsibilities."
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
          { icon: "file", title: "One policy state machine", body: "Policy lifecycle transitions use shared rules and event records. Specialist reviews and claim settlement maintain their own approval controls." },
          { icon: "spark", title: "Three LLM providers", body: "Gemini, OpenAI and Anthropic, with a primary and a fallback chosen at runtime. Credentials are encrypted at rest." },
          { icon: "graph", title: "Fraud graph", body: "Relationships between customers, policies and claims are analysed as a graph, so a single application is never judged in isolation." },
          { icon: "building", title: "Built for Pakistan", body: "CNIC handling, PKR pricing, takaful as a distinct product type, and PEP and sanctions screening." },
          { icon: "chat", title: "Role-specific copilots", body: "Tools follow role and tenant permissions. Assistants act on requested work, ask for missing evidence and preserve human decision gates." },
        ]}
      />
      <TrustSection />
      <CtaBand />
    </>
  );
}
