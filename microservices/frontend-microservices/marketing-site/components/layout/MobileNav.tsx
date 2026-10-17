"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { buttonClass } from "@/components/ui/Button";
import { mainNav, siteConfig } from "@/lib/site-config";
import { isActivePath } from "./NavLinks";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        className="btn rounded-full p-2 text-body hover:bg-chip"
      >
        <Icon name={open ? "close" : "menu"} />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-[calc(100%+0.5rem)] rounded-2xl border border-line bg-white/95 shadow-float backdrop-blur-xl">
          <nav className="flex flex-col gap-1 p-3">
            {mainNav.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-lg px-3 py-2.5 text-sm font-medium ${
                    active ? "bg-brand/10 text-accent" : "text-body hover:bg-alt"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {/* <a
              href={`${siteConfig.portalUrl}/login`}
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-body hover:bg-alt"
            >
              Sign in
            </a> */}
            <Link
              href="/contact"
              onClick={() => setOpen(false)}
              className={`${buttonClass("primary")} mt-2`}
            >
              Request a demo
            </Link>
          </nav>
        </div>
      )}
    </div>
  );
}
