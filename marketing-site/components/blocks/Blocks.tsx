import { ButtonLink } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Container } from "@/components/ui/Section";
import { Faq } from "@/components/sections/Faq";
import { stagger } from "@/lib/utils";

// Reusable page blocks for the inner pages. Each one is a full-width band, so a page is built
// by stacking them and the tones alternate (canvas / alt) to give every page a steady rhythm.

type Tone = "canvas" | "alt";
const band = (tone: Tone) => (tone === "alt" ? "bg-alt" : "bg-canvas");
const pad = "py-16 sm:py-20 2xl:py-28";

export function BlockHeader({ eyebrow, title, description }: Readonly<{ eyebrow: string; title: string; description?: string }>) {
  return (
    <div data-reveal className="max-w-4xl">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold leading-[1.06] tracking-[-0.03em] text-ink sm:text-4xl 2xl:text-5xl">{title}</h2>
      {description && <p className="mt-4 max-w-2xl text-[1rem] leading-relaxed text-body 2xl:text-lg">{description}</p>}
    </div>
  );
}

/** A grid of icon + title + sentence tiles. */
export function FeatureGrid({
  tone = "canvas",
  eyebrow,
  title,
  description,
  items,
  columns = 3,
}: Readonly<{
  tone?: Tone;
  eyebrow: string;
  title: string;
  description?: string;
  items: { icon: IconName; title: string; body: string }[];
  columns?: 2 | 3 | 4;
}>) {
  const cols = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[columns];
  return (
    <section className={`${band(tone)} ${pad}`}>
      <Container>
        <BlockHeader eyebrow={eyebrow} title={title} description={description} />
        <ul className={`mt-10 grid gap-4 2xl:mt-14 2xl:gap-6 ${cols}`}>
          {items.map((it, i) => (
            <li key={it.title} data-reveal style={stagger(i)} className={`glow rounded-2xl p-6 shadow-card 2xl:p-8 ${tone === "alt" ? "bg-card" : "bg-alt"}`}>
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-white shadow-glow">
                <Icon name={it.icon} />
              </span>
              <h3 className="mt-5 text-[1.0625rem] font-semibold tracking-tight text-ink 2xl:text-xl">{it.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-body 2xl:text-[1rem]">{it.body}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

/** Numbered steps joined by a line. */
export function StepsBand({
  tone = "alt",
  eyebrow,
  title,
  description,
  steps,
}: Readonly<{
  tone?: Tone;
  eyebrow: string;
  title: string;
  description?: string;
  steps: { title: string; body: string }[];
}>) {
  return (
    <section className={`${band(tone)} ${pad}`}>
      <Container>
        <BlockHeader eyebrow={eyebrow} title={title} description={description} />
        <ol className="relative mt-12 grid gap-8 md:grid-cols-2 lg:grid-cols-4 2xl:mt-16">
          <span className="absolute left-5 right-5 top-5 hidden h-px bg-line-strong lg:block" aria-hidden="true" />
          {steps.map((st, i) => (
            <li key={st.title} data-reveal style={stagger(i)} className="relative">
              <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white shadow-glow">
                {i + 1}
              </span>
              <h3 className="mt-5 text-[1.0625rem] font-semibold tracking-tight text-ink 2xl:text-xl">{st.title}</h3>
              <p className="mt-2 max-w-xs text-sm leading-relaxed text-body 2xl:text-[1rem]">{st.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}

/** Rows compared across columns, e.g. the three products. */
export function CompareBand({
  tone = "canvas",
  eyebrow,
  title,
  description,
  heads,
  rows,
}: Readonly<{
  tone?: Tone;
  eyebrow: string;
  title: string;
  description?: string;
  heads: string[];
  rows: { label: string; cells: string[] }[];
}>) {
  return (
    <section className={`${band(tone)} ${pad}`}>
      <Container>
        <BlockHeader eyebrow={eyebrow} title={title} description={description} />
        <div data-reveal className="mt-10 overflow-x-auto rounded-2xl bg-card shadow-card 2xl:mt-14">
          <div className="min-w-[44rem]">
            <div className="grid grid-cols-[1.1fr_repeat(3,1.4fr)] gap-4 bg-alt px-6 py-4 text-xs font-semibold uppercase tracking-wider text-muted 2xl:px-8">
              <span />
              {heads.map((h) => (
                <span key={h} className="text-brand">
                  {h}
                </span>
              ))}
            </div>
            {rows.map((r, i) => (
              <div
                key={r.label}
                className={`grid grid-cols-[1.1fr_repeat(3,1.4fr)] gap-4 px-6 py-5 text-sm 2xl:px-8 2xl:text-[1rem] ${i % 2 ? "bg-alt/60" : ""}`}
              >
                <span className="font-semibold text-ink">{r.label}</span>
                {r.cells.map((c, j) => (
                  <span key={j} className="leading-relaxed text-body">
                    {c}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

/** Questions on the right, a short pitch and a button on the left. */
export function FaqBand({
  tone = "alt",
  title = "Questions teams usually ask",
  items,
}: Readonly<{ tone?: Tone; title?: string; items: { q: string; a: string }[] }>) {
  return (
    <section className={`${band(tone)} ${pad}`}>
      <Container className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <BlockHeader eyebrow="Questions" title={title} />
          <div data-reveal className="mt-8 max-w-md rounded-2xl bg-card p-5 shadow-card 2xl:max-w-lg 2xl:p-6">
            <p className="text-sm font-semibold text-ink">Want to see it on your own cases?</p>
            <p className="mt-1.5 text-sm leading-relaxed text-body">
              We will walk through a lead becoming a policy and a claim on demo data, and answer anything this page does not.
            </p>
            <div className="mt-4">
              <ButtonLink href="/contact" arrow>
                Request a demo
              </ButtonLink>
            </div>
          </div>
        </div>
        <Faq items={items} />
      </Container>
    </section>
  );
}

/** One big typographic statement, three phrases with a rule under each. */
export function StatementBand({ tone = "canvas", lines }: Readonly<{ tone?: Tone; lines: { word: string; note: string }[] }>) {
  return (
    <section className={`${band(tone)} ${pad}`}>
      <Container className="grid gap-10 lg:grid-cols-3">
        {lines.map((l, i) => (
          <div key={l.word} data-reveal style={stagger(i)}>
            <p className="text-4xl font-semibold leading-[1.04] tracking-[-0.035em] text-ink sm:text-5xl 2xl:text-6xl">{l.word}</p>
            <span className="mt-5 block h-0.5 w-16 bg-brand" aria-hidden="true" />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-body 2xl:text-[1rem]">{l.note}</p>
          </div>
        ))}
      </Container>
    </section>
  );
}
