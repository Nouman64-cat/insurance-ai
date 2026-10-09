import { Container } from "@/components/ui/Section";
import { Icon } from "@/components/ui/Icon";
import { ContactForm } from "@/components/forms/ContactForm";
import { StageLoop } from "@/components/sections/StageLoop";
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

const next = [
  { title: "We read your note", body: "Tell us about your team and the lines of business you care about." },
  { title: "We shape a walkthrough", body: "A session built around your scenarios, on demo data." },
  { title: "You see it working", body: "A lead through to a claim, with the AI advising and your rules deciding." },
];

function Next() {
  return (
    <div className="space-y-6">
      <StageLoop className="w-full" />
      <ol className="space-y-5 rounded-2xl bg-alt p-6">
        <li className="text-xs font-semibold uppercase tracking-wider text-muted">What happens next</li>
        {next.map((n, i) => (
          <li key={n.title} className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">{i + 1}</span>
            <div>
              <p className="text-sm font-semibold text-ink">{n.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-body">{n.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function ContactPage() {
  return (
    <section className="relative -mt-16 flex-1 overflow-hidden bg-canvas pb-14 pt-[calc(4rem+3.5rem)] sm:pb-20 sm:pt-[calc(4rem+5rem)] 2xl:pb-24 2xl:pt-[calc(4rem+6rem)]">
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
          <div className="mt-10 2xl:hidden">
            <Next />
          </div>
        </div>
        <div className="hidden 2xl:block">
          <Next />
        </div>
        <div className="fade-up w-full" style={{ "--i": 2 } as React.CSSProperties}>
          <ContactForm />
        </div>
      </Container>
    </section>
  );
}
