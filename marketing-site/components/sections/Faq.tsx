"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/ui/Icon";

function FaqItem({ q, a }: Readonly<{ q: string; a: string }>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <h3>
        <button
          type="button"
          id={`${id}-q`}
          aria-expanded={open}
          aria-controls={`${id}-a`}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-4 rounded-xl px-5 py-4 text-left text-sm font-semibold text-ink transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 2xl:px-6 2xl:py-5 2xl:text-base"
        >
          {q}
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-chip text-accent transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          >
            <Icon name="chevron" className="h-4 w-4" />
          </span>
        </button>
      </h3>
      {/* Rows animate 0fr → 1fr for a smooth height change; invisible keeps the closed answer out of the tab order and screen readers */}
      <div
        id={`${id}-a`}
        role="region"
        aria-labelledby={`${id}-q`}
        className={`grid transition-[grid-template-rows,visibility] duration-300 ease-out ${open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <p className="px-5 pb-5 text-sm leading-relaxed text-body 2xl:px-6 2xl:text-base">{a}</p>
        </div>
      </div>
    </div>
  );
}

export function Faq({ items }: Readonly<{ items: { q: string; a: string }[] }>) {
  return (
    <div data-reveal className="glass divide-y divide-line self-start rounded-2xl">
      {items.map((item) => (
        <FaqItem key={item.q} q={item.q} a={item.a} />
      ))}
    </div>
  );
}
