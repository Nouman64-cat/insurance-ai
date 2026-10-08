import { PageHero, Section } from "@/components/ui/Section";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata("Privacy", "How the Insurance AI prototype site handles information.", "/legal/privacy");

export default function PrivacyPage() {
  return (
    <>
      <PageHero art="none" eyebrow="Legal" title="Privacy" description="Draft notice for the prototype marketing site." />
      <Section>
        <div className="mx-auto max-w-3xl space-y-5 leading-relaxed text-body">
          <p>
            This is placeholder text for a prototype and has not been reviewed by counsel. It will be replaced before
            any public launch.
          </p>
          <h2 className="pt-2 text-lg font-semibold text-ink">What the site collects</h2>
          <p>
            The demo request form collects your name, work email, company, area and an optional message. In the current
            prototype this information is validated and logged by the server and is not sent to a third party.
          </p>
          <h2 className="pt-2 text-lg font-semibold text-ink">Cookies and tracking</h2>
          <p>The site does not set analytics or advertising cookies.</p>
          <h2 className="pt-2 text-lg font-semibold text-ink">Contact</h2>
          <p>Questions about this notice can be sent through the demo request form.</p>
        </div>
      </Section>
    </>
  );
}
