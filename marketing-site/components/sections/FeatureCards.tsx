import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/Icon";
import { products } from "@/content/products";
import { platformFeatures } from "@/content/platform";
import { stagger } from "@/lib/utils";

type Card = { href: string; name: string; tagline: string; icon: IconName; bullets?: string[] };

// Card widths per breakpoint. A centred flex-wrap (not a grid) so a short last row sits in the middle
// instead of leaving an orphan card hanging on the left.
const widths = {
  three: "md:w-[calc((100%-1rem)/2)] lg:w-[calc((100%-2rem)/3)] 2xl:w-[calc((100%-3rem)/3)]",
  five: "md:w-[calc((100%-1rem)/2)] lg:w-[calc((100%-2rem)/3)] 2xl:w-[calc((100%-6rem)/5)]",
} as const;

function CardGrid({ cards, cols }: Readonly<{ cards: Card[]; cols: keyof typeof widths }>) {
  return (
    <div className="flex flex-wrap justify-center gap-4 2xl:gap-6">
      {cards.map((c, i) => (
        <div key={c.href} data-reveal style={stagger(i)} className={`flex w-full ${widths[cols]}`}>
          <Link
            href={c.href}
            className="glass glass-hover glow group flex w-full flex-col rounded-2xl p-6 transition-transform duration-300 hover:-translate-y-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 2xl:p-7"
          >
            {/* Strong gradient: the white icon keeps 3:1+ against the cyan end */}
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-gradient-strong text-white shadow-glow">
              <Icon name={c.icon} />
            </span>
            <h3 className="mt-5 text-base font-semibold text-ink 2xl:text-lg">{c.name}</h3>
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
            <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
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
      cols="three"
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
      cols="five"
      cards={platformFeatures.map((f) => ({
        href: `/platform/${f.slug}`,
        name: f.name,
        tagline: f.tagline,
        icon: f.icon,
      }))}
    />
  );
}
