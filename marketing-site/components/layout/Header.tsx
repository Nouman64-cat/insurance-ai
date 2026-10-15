import Link from "next/link";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";
import { NavLinks } from "./NavLinks";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { siteConfig } from "@/lib/site-config";

// Floating pill navbar. The header itself is a transparent 4rem strip (pages pull their first
// section up under it with -mt-16) that ignores the pointer, so only the pill can cover content.
export function Header() {
  return (
    <header className="pointer-events-none sticky top-0 z-40 h-16 px-4 pt-4 sm:px-6">
      <div className="glass pointer-events-auto relative mx-auto flex h-12 w-full max-w-[56rem] items-center justify-between gap-4 rounded-full bg-white/80 pl-4 pr-1.5 shadow-card">
        <Logo intro />
        <nav
          className="intro-drop hidden items-center md:flex"
          style={{ "--i": 0 } as React.CSSProperties}
          aria-label="Main"
        >
          <NavLinks />
        </nav>
        <div
          className="intro-drop hidden items-center gap-2 md:flex"
          style={{ "--i": 2 } as React.CSSProperties}
        >
          {/* <a
            href={`${siteConfig.portalUrl}/login`}
            className="rounded-lg px-3 py-2 text-sm font-medium text-body hover:text-ink"
          >
            Sign in
          </a> */}
          <Link href="/contact" className={buttonClass("primary", "sm")}>
            Request a demo
            <Icon
              name="arrow"
              className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>
        </div>
        <MobileNav />
      </div>
    </header>
  );
}
