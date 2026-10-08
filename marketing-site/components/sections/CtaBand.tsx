import { ButtonLink } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";

export function CtaBand({
  title = "See the full journey on demo data",
  description = "We will walk you through a lead becoming a policy and a claim, with the copilot driving where it helps.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Section tone="dark">
      <div data-reveal className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
        <div className="max-w-xl">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
          <p className="mt-3 text-blue-100">{description}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/contact" variant="onDark">
            Request a demo
          </ButtonLink>
          <ButtonLink href="/platform" variant="ghostOnDark">
            Explore the platform
          </ButtonLink>
        </div>
      </div>
    </Section>
  );
}
