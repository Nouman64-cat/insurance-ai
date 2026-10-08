"use client";

import { useEffect, useRef } from "react";

// Site-wide pointer effects, all driven by one passive listener:
//  1. a soft blue spotlight that trails the cursor (moved with transform only, so it is
//     composited on the GPU and never forces a repaint of the page)
//  2. --mx / --my on whichever .card / .glow is under the pointer, which the CSS in
//     globals.css turns into a highlight that follows the cursor inside that box
// Skipped on touch devices and for people who prefer reduced motion.
export function CursorEffects() {
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const glow = glowRef.current;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!glow || !finePointer || reduce) return;

    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let frame = 0;
    let shown = false;

    const follow = () => {
      // Ease toward the pointer so the glow trails slightly behind it
      x += (targetX - x) * 0.16;
      y += (targetY - y) * 0.16;
      const half = glow.offsetWidth / 2;
      glow.style.transform = `translate3d(${x - half}px, ${y - half}px, 0)`;
      frame = Math.abs(targetX - x) > 0.5 || Math.abs(targetY - y) > 0.5 ? requestAnimationFrame(follow) : 0;
    };

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!shown) {
        shown = true;
        x = targetX;
        y = targetY;
        glow.style.opacity = "1";
      }
      if (!frame) frame = requestAnimationFrame(follow);

      const box = (e.target as Element | null)?.closest?.<HTMLElement>(".card, .glow");
      if (box) {
        const rect = box.getBoundingClientRect();
        box.style.setProperty("--mx", `${e.clientX - rect.left}px`);
        box.style.setProperty("--my", `${e.clientY - rect.top}px`);
      }
    };

    const onLeave = () => {
      shown = false;
      glow.style.opacity = "0";
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={glowRef} className="cursor-glow" aria-hidden="true" />;
}
