"use client";

import { useEffect } from "react";

// Click feedback for every button: a ripple that spreads from the click point, plus a brief
// ring pulse around the button (the press-down scale is plain CSS, `.btn:active`).
// Works for mouse, touch and keyboard activation. Skipped for reduced motion.
export function ClickRipple() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const burst = (el: HTMLElement, x: number, y: number) => {
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const ripple = document.createElement("span");
      ripple.className = "ripple";
      ripple.setAttribute("aria-hidden", "true");
      ripple.style.cssText = `width:${size}px;height:${size}px;left:${x - rect.left - size / 2}px;top:${y - rect.top - size / 2}px`;
      el.appendChild(ripple);
      ripple.addEventListener("animationend", () => ripple.remove(), { once: true });

      // Restart the ring pulse if the button is clicked again quickly
      el.classList.remove("btn-pulse");
      void el.offsetWidth;
      el.classList.add("btn-pulse");
      window.setTimeout(() => el.classList.remove("btn-pulse"), 750);
    };

    const target = (e: Event) => (e.target as Element | null)?.closest?.<HTMLElement>(".btn");

    const onPointerDown = (e: PointerEvent) => {
      const el = target(e);
      if (el && !(el as HTMLButtonElement).disabled) burst(el, e.clientX, e.clientY);
    };
    // Keyboard activation (Enter / Space) fires click with no pointer position
    const onClick = (e: MouseEvent) => {
      if (e.detail !== 0) return;
      const el = target(e);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      burst(el, rect.left + rect.width / 2, rect.top + rect.height / 2);
    };

    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("click", onClick);
    };
  }, []);

  return null;
}
