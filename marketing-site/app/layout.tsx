import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Splash } from "@/components/layout/Splash";
import { ScrollReveal } from "@/components/effects/ScrollReveal";
import { CursorEffects } from "@/components/effects/CursorEffects";
import { ClickRipple } from "@/components/effects/ClickRipple";
import { HeaderShadow } from "@/components/effects/HeaderShadow";
import { siteConfig } from "@/lib/site-config";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: `${siteConfig.name} | ${siteConfig.tagline}`,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  authors: [{ name: siteConfig.developer }],
  creator: siteConfig.developer,
  publisher: siteConfig.developer,
  openGraph: {
    siteName: siteConfig.name,
    type: "website",
    title: siteConfig.name,
    description: siteConfig.description,
  },
};

// Runs before first paint. Adds `.js` (enables scroll-reveal hiding) and decides whether
// the landing splash plays: first visit to "/" in a session, and no reduced-motion preference.
const bootScript = `(function(d){var e=d.documentElement;e.classList.add('js');try{var p=location.pathname==='/'&&!sessionStorage.getItem('splash-seen')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;e.dataset.splash=p?'pending':'seen'}catch(_){e.dataset.splash='seen'}})(document);`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootScript }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <Splash />
        <ScrollReveal />
        <CursorEffects />
        <ClickRipple />
        <HeaderShadow />
        <Header />
        <main className="flex flex-1 flex-col">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
