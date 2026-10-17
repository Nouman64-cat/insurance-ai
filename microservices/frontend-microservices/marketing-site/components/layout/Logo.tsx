import Image from "next/image";
import Link from "next/link";

// The GetInsuredAI horizontal logo, linking home. At 28–32px tall it is ~110–125px wide, which fits
// the navbar pill next to the menu button even on a 320px screen, so it is used at every width.
// `unoptimized`: the site builds as standalone without sharp, so the PNG is served as-is.
export function Logo({ intro = false, className = "h-7 sm:h-8" }: Readonly<{ intro?: boolean; className?: string }>) {
  return (
    <Link
      href="/"
      data-logo-target={intro ? "" : undefined}
      className="inline-flex shrink-0 items-center rounded-md transition-opacity duration-200 hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Image
        src="/brand/logo-horizontal.png"
        alt="GetInsuredAI"
        width={1000}
        height={258}
        priority={intro}
        unoptimized
        className={`w-auto ${className}`}
      />
    </Link>
  );
}
