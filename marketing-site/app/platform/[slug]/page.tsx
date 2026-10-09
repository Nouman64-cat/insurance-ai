import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Container, Section, SectionHeader } from "@/components/ui/Section";
import { Mock } from "@/components/mocks/Mock";
import { CtaBand } from "@/components/sections/CtaBand";
import { getPlatformFeature, platformFeatures } from "@/content/platform";
import { pageMetadata } from "@/lib/seo";
import { stagger } from "@/lib/utils";

export function generateStaticParams() {
  return platformFeatures.map((f) => ({ slug: f.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const feature = getPlatformFeature(params.slug);
  if (!feature) return {};
  return pageMetadata(feature.name, feature.tagline, `/platform/${feature.slug}`);
}

export default function PlatformFeaturePage({ params }: { params: { slug: string } }) {
  const feature = getPlatformFeature(params.slug);
  if (!feature) notFound();

  return (
    <>
      <section className="relative -mt-16 overflow-hidden bg-canvas">
        <div aria-hidden="true" className="pointer-events-none absolute -left-[10%] top-[-40%] h-[40rem] w-[40rem] rounded-full bg-[radial-gradient(closest-side,rgba(37,99,235,0.12),transparent)]" />
        <Container className="relative grid items-center gap-12 pb-14 pt-[calc(4rem+3.5rem)] sm:pb-20 sm:pt-[calc(4rem+5rem)] 2xl:gap-24 2xl:pb-24 2xl:pt-[calc(4rem+6rem)] lg:grid-cols-2">
          <div className="fade-up">
            <p className="eyebrow">{feature.name}</p>
            <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{feature.tagline}</h1>
            <p className="mt-5 text-lg leading-relaxed text-body">{feature.summary}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/contact">Request a demo</ButtonLink>
              <ButtonLink href="/products" variant="ghost">
                View products
              </ButtonLink>
            </div>
          </div>
          <div className="fade-up" style={stagger(2)}>
            <Mock kind={feature.mock} />
          </div>
        </Container>
      </section>

      <Section>
        <SectionHeader eyebrow="Capabilities" title={`What ${feature.name} covers`} />
        <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {feature.points.map((p, i) => (
            <div key={p.title} data-reveal style={stagger(i)} className="card p-6">
              <h3 className="text-base font-semibold text-ink">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-body">{p.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="muted">
        <SectionHeader eyebrow="Guarantees" title="Built to be trusted" />
        <ul className="mt-8 grid gap-3 md:grid-cols-3">
          {feature.guarantees.map((g, i) => (
            <li key={g} data-reveal style={stagger(i)} className="card flex items-start gap-3 p-5 text-sm text-body">
              <Icon name="check" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              {g}
            </li>
          ))}
        </ul>
      </Section>

      <CtaBand />
    </>
  );
}
