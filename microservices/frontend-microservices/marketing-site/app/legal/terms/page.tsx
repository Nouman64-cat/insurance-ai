import { PageHero, Section } from "@/components/ui/Section";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata("Terms", "Terms of use for the Insurance AI prototype site.", "/legal/terms");

export default function TermsPage() {
  return (
    <>
      <PageHero art="none" eyebrow="Legal" title="Terms of use" description="Draft terms for the prototype marketing site." />
      <Section>
        <div className="mx-auto max-w-3xl space-y-5 leading-relaxed text-body">
          <p>
            This is placeholder text for a prototype and has not been reviewed by counsel. It will be replaced before
            any public launch.
          </p>
          <h2 className="pt-2 text-lg font-semibold text-ink">Demo content</h2>
          <p>
            Plans, rates, figures, names and screens on this site are illustrative. Nothing here is an offer of
            insurance, a quotation or financial advice.
          </p>
          <h2 className="pt-2 text-lg font-semibold text-ink">Availability</h2>
          <p>The site is provided as is during the prototype phase and may change without notice.</p>
        </div>
      </Section>
    </>
  );
}
