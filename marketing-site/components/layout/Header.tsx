import Link from "next/link";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { mainNav, siteConfig } from "@/lib/site-config";

export function Header() {
  return (
    <header className="site-header sticky top-0 z-40">
      <div className="relative mx-auto flex h-16 w-full max-w-[150rem] items-center justify-between px-4 sm:px-6 lg:px-10 2xl:px-16">
        <Logo intro />
        <nav className="intro-drop hidden items-center gap-1 md:flex" style={{ "--i": 0 } as React.CSSProperties} aria-label="Main">
          {mainNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link rounded-lg px-3 py-2 text-sm font-medium text-body hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="intro-drop hidden items-center gap-2 md:flex" style={{ "--i": 2 } as React.CSSProperties}>
          <a
            href={`${siteConfig.portalUrl}/login`}
            className="rounded-lg px-3 py-2 text-sm font-medium text-body hover:text-ink"
          >
            Sign in
          </a>
          <Link href="/contact" className={buttonClass("primary")}>
            Request a demo
            <Icon name="arrow" className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </div>
        <MobileNav />
      </div>
    </header>
  );
}
