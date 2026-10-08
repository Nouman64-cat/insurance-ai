import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/Icon";
import { products } from "@/content/products";
import { platformFeatures } from "@/content/platform";
import { stagger } from "@/lib/utils";

type Card = { href: string; name: string; tagline: string; icon: IconName; bullets?: string[] };

function CardGrid({ cards, cols }: Readonly<{ cards: Card[]; cols: string }>) {
  return (
    <div className={`grid gap-4 2xl:gap-6 ${cols}`}>
      {cards.map((c, i) => (
        <div key={c.href} data-reveal style={stagger(i)} className="flex">
          <Link
            href={c.href}
            className="card group flex w-full flex-col p-6 transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-1 hover:border-line-strong hover:shadow-float"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/15 text-accent transition-colors duration-300 group-hover:bg-brand group-hover:text-white">
              <Icon name={c.icon} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-ink">{c.name}</h3>
            <p className="mt-2 text-sm leading-relaxed text-body">{c.tagline}</p>
            {c.bullets && (
              <ul className="mt-4 flex-1 space-y-2 border-t border-line pt-4">
                {c.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-sm text-body">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    {b}
                  </li>
                ))}
              </ul>
            )}
            {!c.bullets && <div className="flex-1" />}
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
              Learn more
              <Icon name="arrow" className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </span>
          </Link>
        </div>
      ))}
    </div>
  );
}

export function ProductCards() {
  return (
    <CardGrid
      cols="md:grid-cols-3"
      cards={products.map((p) => ({
        href: `/products/${p.slug}`,
        name: p.name,
        tagline: p.tagline,
        icon: p.icon,
        bullets: p.highlights.slice(0, 3).map((h) => h.title),
      }))}
    />
  );
}

export function PlatformCards() {
  return (
    <CardGrid
      cols="md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5"
      cards={platformFeatures.map((f) => ({
        href: `/platform/${f.slug}`,
        name: f.name,
        tagline: f.tagline,
        icon: f.icon,
      }))}
    />
  );
}
