import Link from "next/link";
import { Logo } from "./Logo";
import { Container } from "@/components/ui/Section";
import { footerNav, siteConfig } from "@/lib/site-config";

export function Footer() {
  return (
    <footer className="border-t border-line bg-canvas">
      <Container className="py-12 2xl:py-16">
        {/* Two link columns on phones, four on tablets (logo on its own row), logo + four on desktop */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="col-span-2 sm:col-span-4 lg:col-span-1">
            <Logo className="h-9" />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-body">{siteConfig.tagline}.</p>
          </div>
          {footerNav.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-faint">{group.title}</h3>
              <ul className="mt-3 space-y-2">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="rounded text-sm text-body transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 border-t border-line pt-6 text-xs leading-relaxed text-muted">
          <p className="max-w-3xl">
            Insurance AI is a prototype. Plans, rates, figures and people shown on this site are illustrative demo
            data and do not describe a live insurance product or real customers.
          </p>
          <p className="mt-2">
            © {new Date().getFullYear()} {siteConfig.name}. Developed by{" "}
            <span className="font-medium text-body">{siteConfig.developer}</span>.
          </p>
        </div>
      </Container>
    </footer>
  );
}
