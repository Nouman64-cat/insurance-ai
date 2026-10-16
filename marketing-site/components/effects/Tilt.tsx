"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Pointer-driven 3D tilt with a soft glare that follows the cursor. Everything runs on transform
// and opacity inside requestAnimationFrame (no React state, so no re-renders per frame), and the
// card eases back to flat when the pointer leaves. will-change is only set while hovering.
// Off for touch / coarse pointers and for people who prefer reduced motion: the card renders flat
// and no listeners are attached. The glare layer ignores the pointer, so clicks, focus rings and
// text selection inside the card behave as normal.
export const enabledQuery = "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";

export function Tilt({
  children,
  className = "",
  max = 6,
}: Readonly<{ children: ReactNode; className?: string; max?: number }>) {
  const ref = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    const glare = glareRef.current;
    if (!el || !glare) return;
    const mq = window.matchMedia(enabledQuery);
    let detach = () => {};

    const attach = () => {
      detach();
      if (!mq.matches) return;

      // Current and target values: rotation in degrees, glare offset as a fraction of the card (-0.5…0.5)
      const cur = { rx: 0, ry: 0, gx: 0, gy: 0 };
      const tgt = { rx: 0, ry: 0, gx: 0, gy: 0 };
      let frame = 0;
      let hovering = false;

      const render = () => {
        cur.rx += (tgt.rx - cur.rx) * 0.14;
        cur.ry += (tgt.ry - cur.ry) * 0.14;
        cur.gx += (tgt.gx - cur.gx) * 0.14;
        cur.gy += (tgt.gy - cur.gy) * 0.14;
        const settled =
          Math.abs(tgt.rx - cur.rx) < 0.01 && Math.abs(tgt.ry - cur.ry) < 0.01 &&
          Math.abs(tgt.gx - cur.gx) < 0.001 && Math.abs(tgt.gy - cur.gy) < 0.001;
        if (settled && !hovering) {
          // Back to flat: drop the inline transform so the card is exactly as it was
          el.style.transform = "";
          el.style.willChange = "";
          glare.style.transform = "";
          frame = 0;
          return;
        }
        el.style.transform = `perspective(1000px) rotateX(${cur.rx.toFixed(2)}deg) rotateY(${cur.ry.toFixed(2)}deg)`;
        glare.style.transform = `translate3d(${(cur.gx * 100).toFixed(1)}%, ${(cur.gy * 100).toFixed(1)}%, 0)`;
        frame = settled ? 0 : requestAnimationFrame(render);
      };
      const kick = () => {
        if (!frame) frame = requestAnimationFrame(render);
      };

      const onEnter = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        hovering = true;
        el.style.willChange = "transform";
        glare.style.opacity = "1";
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        if (!hovering) onEnter(e);
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        tgt.ry = px * 2 * max;
        tgt.rx = -py * 2 * max;
        tgt.gx = px;
        tgt.gy = py;
        kick();
      };
      const onLeave = () => {
        hovering = false;
        tgt.rx = tgt.ry = tgt.gx = tgt.gy = 0;
        glare.style.opacity = "0";
        kick();
      };

      el.addEventListener("pointerenter", onEnter);
      el.addEventListener("pointermove", onMove, { passive: true });
      el.addEventListener("pointerleave", onLeave);
      detach = () => {
        el.removeEventListener("pointerenter", onEnter);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
        if (frame) cancelAnimationFrame(frame);
        el.style.transform = "";
        el.style.willChange = "";
        glare.style.transform = "";
        glare.style.opacity = "0";
        detach = () => {};
      };
    };

    attach();
    // Re-check if the user toggles reduced motion or plugs in / removes a mouse
    mq.addEventListener("change", attach);
    return () => {
      mq.removeEventListener("change", attach);
      detach();
    };
  }, [max]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      {children}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
        <span
          ref={glareRef}
          className="absolute inset-0 opacity-0 transition-opacity duration-300 [background:radial-gradient(closest-side,rgb(255_255_255/0.4),rgb(34_184_214/0.06)_45%,transparent_75%)]"
        />
      </span>
    </div>
  );
}
