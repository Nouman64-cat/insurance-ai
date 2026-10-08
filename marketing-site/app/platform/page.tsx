import { PageHero, Section, SectionHeader } from "@/components/ui/Section";
import { PlatformCards } from "@/components/sections/FeatureCards";
import { Lifecycle } from "@/components/sections/Lifecycle";
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
        art="platform"
        eyebrow="Platform"
        title="Everything between a lead and a claim"
        description="Five capabilities share one data model, one event stream and one audit trail."
      />
      <Section>
        <PlatformCards />
      </Section>
      <Section tone="muted">
        <SectionHeader eyebrow="Lifecycle" title="Where each capability fits" />
        <div className="mt-10">
          <Lifecycle />
        </div>
      </Section>
      <CtaBand />
    </>
  );
}
