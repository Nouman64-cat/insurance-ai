"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { buttonClass } from "@/components/ui/Button";
import { mainNav, siteConfig } from "@/lib/site-config";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        className="btn rounded-lg p-2 text-body hover:bg-chip"
      >
        <Icon name={open ? "close" : "menu"} />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full bg-card shadow-float">
          <nav className="mx-auto flex max-w-[150rem] flex-col gap-1 px-4 py-4">
            {mainNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-body hover:bg-alt"
              >
                {item.label}
              </Link>
            ))}
            <a
              href={`${siteConfig.portalUrl}/login`}
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-body hover:bg-alt"
            >
              Sign in
            </a>
            <Link href="/contact" onClick={() => setOpen(false)} className={`${buttonClass("primary")} mt-2`}>
              Request a demo
            </Link>
          </nav>
        </div>
      )}
    </div>
  );
}
