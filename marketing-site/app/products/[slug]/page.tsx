import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHero, Section, SectionHeader } from "@/components/ui/Section";
import { Faq } from "@/components/sections/Faq";
import { CtaBand } from "@/components/sections/CtaBand";
import { getProduct, products } from "@/content/products";
import { pageMetadata } from "@/lib/seo";
import type { IllustrationKind } from "@/components/art/HeroIllustration";
import { stagger } from "@/lib/utils";

const artFor: Record<string, IllustrationKind> = {
  "individual-life": "individual",
  "family-takaful": "family",
  "group-life": "group",
};

export function generateStaticParams() {
  return products.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const product = getProduct(params.slug);
  if (!product) return {};
  return pageMetadata(product.name, product.tagline, `/products/${product.slug}`);
}

export default function ProductPage({ params }: { params: { slug: string } }) {
  const product = getProduct(params.slug);
  if (!product) notFound();

  return (
    <>
      <PageHero eyebrow="Product" title={product.name} description={product.tagline} art={artFor[product.slug] ?? "family"}>
        <ButtonLink href="/contact">Request a demo</ButtonLink>
        <ButtonLink href="/platform" variant="ghost">
          Explore the platform
        </ButtonLink>
      </PageHero>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div data-reveal>
            <h2 className="text-2xl font-semibold tracking-tight">Overview</h2>
            <p className="mt-4 leading-relaxed text-body">{product.summary}</p>
            <p className="mt-4 text-sm text-muted">
              <span className="font-semibold text-body">Built for: </span>
              {product.audience}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {product.highlights.map((h, i) => (
              <div key={h.title} data-reveal style={stagger(i)} className="card p-5">
                <Icon name="check" className="h-5 w-5 text-emerald-600" />
                <h3 className="mt-3 text-sm font-semibold text-ink">{h.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-body">{h.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section tone="muted">
        <SectionHeader eyebrow="How it works" title="From first contact to issued policy" />
        <ol className="mt-10 grid gap-4 md:grid-cols-4">
          {product.steps.map((s, i) => (
            <li key={s.title} data-reveal style={stagger(i)} className="card p-5">
              <span className="text-xs font-semibold tabular-nums text-faint">Step 0{i + 1}</span>
              <h3 className="mt-2 text-sm font-semibold text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-body">{s.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section>
        <SectionHeader
          eyebrow="Example plans"
          title="Illustrative plan catalogue"
          description="Demo plans and indicative rates only. Each insurer configures its own catalogue and rate tables."
        />
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {product.plans.map((p, i) => (
            <div key={p.name} data-reveal style={stagger(i)} className="card flex flex-col p-6">
              <h3 className="text-base font-semibold text-ink">{p.name}</h3>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-faint">Term</dt>
                <dd className="text-body">{p.term}</dd>
                <dt className="text-faint">Cover</dt>
                <dd className="text-body">{p.cover}</dd>
              </dl>
              <div className="mt-auto border-t border-line pt-4">
                <p className="mt-4 text-xs uppercase tracking-widest text-faint">Indicative contribution</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{p.from}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="muted">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <SectionHeader eyebrow="Questions" title={`About ${product.name}`} />
          <Faq items={product.faq} />
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
