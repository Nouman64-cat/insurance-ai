"use client";

// "Scroll to explore": an outlined mouse with a dot sliding down it, and a hairline that draws
// itself towards the next section. Clicking scrolls smoothly to the product story.
export function ScrollCue({ targetId = "product-story" }: Readonly<{ targetId?: string }>) {
  const go = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const el = document.getElementById(targetId);
    if (!el) return;
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  return (
    <a
      href={`#${targetId}`}
      onClick={go}
      className="fade-up-intro group mx-auto mt-14 flex w-max flex-col items-center gap-3 rounded-lg px-4 py-2 text-xs font-medium text-muted transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 2xl:mt-20"
      style={{ "--i": 8 } as React.CSSProperties}
    >
      <span className="relative flex h-10 w-6 justify-center rounded-full ring-[1.5px] ring-line-strong transition-shadow group-hover:ring-accent/60" aria-hidden="true">
        <span className="cue-dot mt-2 h-1.5 w-1.5 rounded-full bg-brand" />
      </span>
      <span className="tracking-wide">Scroll to explore</span>
      <span className="relative h-10 w-px overflow-hidden bg-line" aria-hidden="true">
        <span className="cue-line absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-transparent via-brand to-transparent" />
      </span>
    </a>
  );
}
