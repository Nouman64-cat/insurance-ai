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
        <div className="max-w-3xl">
          <h2 className="text-3xl font-semibold leading-[1.06] tracking-[-0.03em] text-white sm:text-5xl 2xl:text-6xl">{title}</h2>
          <p className="mt-4 max-w-xl text-base text-blue-100 2xl:text-lg">{description}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/contact" variant="onDark" arrow>
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
