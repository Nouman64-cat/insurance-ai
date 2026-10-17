import Image from "next/image";

// The GetInsuredAI shield mark on its own. Size it with a height class; the width follows.
// `unoptimized`: the site builds as standalone without sharp, so the PNG is served as-is.
export function LogoMark({ className = "h-8 w-auto" }: Readonly<{ className?: string }>) {
  return <Image src="/brand/logo-mark.png" alt="" width={314} height={343} unoptimized className={className} />;
}
