import { Container } from "@/components/ui/Section";
import { Icon } from "@/components/ui/Icon";
import { ContactForm } from "@/components/forms/ContactForm";
import { HeroIllustration } from "@/components/art/HeroIllustration";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Request a demo",
  "Book a walkthrough of the Insurance AI platform on demo data.",
  "/contact"
);

const expect = [
  "A lead taken through quote, case, underwriting and issuance",
  "A claim handled end to end, including manager review",
  "The copilot driving a workflow, with confirmation gates",
  "Your questions on takaful, group schemes and rules",
];

export default function ContactPage() {
  return (
    <section className="relative -mt-16 flex-1 overflow-hidden bg-base pb-14 pt-[calc(4rem+3.5rem)] sm:pb-20 sm:pt-[calc(4rem+5rem)] 2xl:pb-24 2xl:pt-[calc(4rem+6rem)]">
      <div aria-hidden="true" className="pointer-events-none absolute -left-[10%] top-[-30%] h-[44rem] w-[44rem] rounded-full bg-[radial-gradient(closest-side,rgba(37,99,235,0.12),transparent)]" />
      <Container className="relative grid items-start gap-12 lg:grid-cols-[1fr_minmax(0,36rem)] 2xl:grid-cols-[minmax(0,28rem)_1fr_minmax(0,36rem)] 2xl:gap-16">
        <div className="fade-up">
          <p className="eyebrow">Request a demo</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">See it work on demo data</h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-body">
            Tell us a little about your team and we will tailor a walkthrough to the lines of business you care about.
          </p>
          <h2 className="mt-8 text-sm font-semibold text-ink">What the session covers</h2>
          <ul className="mt-3 space-y-2.5">
            {expect.map((e) => (
              <li key={e} className="flex items-start gap-2.5 text-sm text-body">
                <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                {e}
              </li>
            ))}
          </ul>
          <HeroIllustration kind="family" className="mt-10 hidden h-auto w-full max-w-[34rem] lg:block 2xl:hidden" />
        </div>
        <div className="hidden items-center justify-center 2xl:flex">
          <HeroIllustration kind="family" className="h-auto w-full max-w-[44rem]" />
        </div>
        <div className="fade-up w-full" style={{ "--i": 2 } as React.CSSProperties}>
          <ContactForm />
        </div>
      </Container>
    </section>
  );
}
