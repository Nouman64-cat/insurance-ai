import Link from "next/link";
import { Logo } from "./Logo";
import { Container } from "@/components/ui/Section";
import { footerNav, siteConfig } from "@/lib/site-config";

export function Footer() {
  return (
    <footer className="bg-alt">
      <Container className="py-12">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <Logo className="h-9" />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-body">{siteConfig.tagline}.</p>
          </div>
          {footerNav.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-faint">{group.title}</h3>
              <ul className="mt-3 space-y-2">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-sm text-body hover:text-ink">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 border-t border-line pt-6 text-xs leading-relaxed text-muted">
          <p>
            Plans, rates, amounts, people and interface examples shown on this site are illustrative demo
            data. Available workflows and integrations depend on the insurer’s configuration. This site does not offer an insurance policy.
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
