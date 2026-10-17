import type { CSSProperties } from "react";

// Sets the --i custom property that drives staggered animation delays in globals.css.
export function stagger(index: number, max = 6): CSSProperties {
  return { "--i": Math.min(index, max) } as CSSProperties;
}
