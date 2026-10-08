import Link from "next/link";
import { LogoMark } from "./LogoMark";
import { siteConfig } from "@/lib/site-config";

export function Logo({ light = false, intro = false }: { light?: boolean; intro?: boolean }) {
  return (
    <Link href="/" data-logo-target={intro ? "" : undefined} className="group inline-flex items-center gap-2" aria-label={`${siteConfig.name} home`}>
      <LogoMark className="h-8 w-8 rounded-lg transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-110" />
      <span className={`text-base font-semibold tracking-tight ${light ? "text-white" : "text-ink"}`}>
        {siteConfig.name}
      </span>
    </Link>
  );
}
