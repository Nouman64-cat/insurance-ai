import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";

const base =
  "btn group inline-flex items-center justify-center gap-2 text-sm font-semibold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

const variants = {
  // Brand gradient: the committing action
  primary: "bg-brand-gradient-strong text-white shadow-glow hover:brightness-90",
  brand: "bg-brand text-white hover:bg-brand-dark",
  // Outlined: secondary / reversible
  ghost: "border border-line-strong bg-transparent text-ink hover:border-accent/60 hover:bg-chip",
  // On the blue CTA panel
  onDark: "btn-ring-light bg-white text-brand-deep hover:bg-blue-50",
  ghostOnDark: "btn-ring-light border border-white/40 text-white hover:bg-white/10",
} as const;

const sizes = {
  md: "rounded-lg px-4 py-2.5",
  // Compact pill, for the floating navbar
  sm: "rounded-full px-4 py-2",
} as const;

export type ButtonVariant = keyof typeof variants;

export function buttonClass(variant: ButtonVariant = "primary", size: keyof typeof sizes = "md") {
  return `${base} ${sizes[size]} ${variants[variant]}`;
}

export function ButtonLink({
  href,
  variant = "primary",
  external = false,
  arrow = false,
  children,
}: Readonly<{
  href: string;
  variant?: ButtonVariant;
  external?: boolean;
  arrow?: boolean;
  children: ReactNode;
}>) {
  const content = (
    <>
      {children}
      {arrow && <Icon name="arrow" className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />}
    </>
  );
  if (external) {
    return (
      <a href={href} className={buttonClass(variant)}>
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant)}>
      {content}
    </Link>
  );
}
