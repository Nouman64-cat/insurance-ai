import type { ReactNode } from "react";
import { HeroIllustration, type IllustrationKind } from "@/components/art/HeroIllustration";

// Fluid container: grows with the viewport (and with the rem scale on large displays)
// instead of stopping at a fixed width.
export function Container({ children, className = "" }: Readonly<{ children: ReactNode; className?: string }>) {
  return (
    <div className={`mx-auto w-full max-w-[150rem] px-4 sm:px-6 lg:px-10 2xl:px-16 ${className}`}>{children}</div>
  );
}

export function Section({
  id,
  tone = "white",
  children,
}: Readonly<{
  id?: string;
  tone?: "white" | "muted" | "dark";
  children: ReactNode;
}>) {
  const tones = {
    white: "bg-base",
    muted: "bg-alt",
    dark: "bg-gradient-to-r from-brand-deep via-brand-dark to-brand text-white",
  } as const;
  return (
    <section id={id} className={`cv-auto py-16 sm:py-20 2xl:py-24 ${tones[tone]}`}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "left",
  dark = false,
}: Readonly<{
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
  dark?: boolean;
}>) {
  return (
    <div data-reveal className={`max-w-2xl 2xl:max-w-3xl ${align === "center" ? "mx-auto text-center" : ""}`}>
      {eyebrow && <p className={dark ? "text-xs font-semibold uppercase tracking-widest text-blue-300" : "eyebrow"}>{eyebrow}</p>}
      <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      {description && (
        <p className={`mt-4 text-base leading-relaxed ${dark ? "text-blue-100" : "text-body"}`}>{description}</p>
      )}
    </div>
  );
}

export function PageHero({
  eyebrow,
  title,
  description,
  art = "platform",
  children,
}: Readonly<{
  eyebrow?: string;
  title: string;
  description: string;
  art?: IllustrationKind | "none";
  children?: ReactNode;
}>) {
  return (
    <section className="relative -mt-16 overflow-hidden bg-base pb-14 pt-[calc(4rem+3.5rem)] sm:pb-20 sm:pt-[calc(4rem+5rem)] 2xl:pb-24 2xl:pt-[calc(4rem+6rem)]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-[10%] top-[-40%] h-[40rem] w-[40rem] rounded-full bg-[radial-gradient(closest-side,rgba(37,99,235,0.12),transparent)]" />
      </div>
      {art !== "none" && (
        <div className="pointer-events-none absolute bottom-0 right-[2%] top-16 hidden w-[min(44rem,48vw)] items-center justify-end lg:flex">
          <HeroIllustration kind={art} className="h-[94%] w-auto max-w-full" />
        </div>
      )}
      <Container className="relative">
        <div className="max-w-3xl lg:max-w-[min(46rem,52%)] 2xl:max-w-4xl">
          {eyebrow && (
            <p className="eyebrow fade-up" style={{ "--i": 0 } as React.CSSProperties}>
              {eyebrow}
            </p>
          )}
          <h1
            className="fade-up mt-2 text-4xl font-semibold tracking-tight sm:text-5xl"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            {title}
          </h1>
          <p
            className="fade-up mt-5 text-lg leading-relaxed text-body"
            style={{ "--i": 2 } as React.CSSProperties}
          >
            {description}
          </p>
          {children && (
            <div className="fade-up mt-8 flex flex-wrap gap-3" style={{ "--i": 3 } as React.CSSProperties}>
              {children}
            </div>
          )}
        </div>
      </Container>
    </section>
  );
}
