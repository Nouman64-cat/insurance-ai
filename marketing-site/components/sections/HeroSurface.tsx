"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { enabledQuery } from "@/components/effects/Tilt";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ProductSurface } from "@/components/product/ProductSurface";

// The product preview under the hero, with depth:
//  - it leans back (rotateX up to MAX_LEAN) while it sits low in the viewport and straightens as it
//    scrolls into view
//  - a gentle mouse tilt (up to MAX_TILT) on top of that
//  - three glass chips at different depths (translateZ), quoting values the surface itself shows
// All motion is transform-only inside requestAnimationFrame, with no React state. When the surface is
// flat and not hovered the inline transform and will-change are removed. Touch devices and reduced
// motion get the flat surface with no listeners. The chips only appear from lg up, where they sit on
// empty stretches of the top and bottom edges, never on text.
const MAX_LEAN = 9;
const MAX_TILT = 4;

const chips: { icon: IconName; label: string; value: string; ok?: boolean; place: CSSProperties; y: string; z: number; delay: string }[] = [
  // Top edge, between the case ID and the "Demo data" pill; mostly above the surface
  { icon: "chart", label: "Medical risk · AI advisory", value: "38 / 100", place: { top: 0, left: "42%" }, y: "-72%", z: 70, delay: "0s" },
  { icon: "check", label: "Rule chain v12", value: "5 of 5 passed", ok: true, place: { top: 0, right: "16%" }, y: "-62%", z: 40, delay: "-2.4s" },
  // Bottom edge, between the two texts in the decision bar; mostly below the surface
  { icon: "file", label: "Audit trail", value: "Decision recorded 10:05", place: { bottom: 0, left: "36%" }, y: "68%", z: 100, delay: "-4.6s" },
];

export function HeroSurface() {
  const stageRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const plane = planeRef.current;
    if (!stage || !plane) return;
    const mq = window.matchMedia(enabledQuery);
    let detach = () => {};

    const attach = () => {
      detach();
      if (!mq.matches) return;

      // Lean from the untransformed stage's position: 0 when its top meets the bottom of the
      // viewport, fully straight once its top is a quarter of the way down.
      const leanFor = () => {
        const vh = window.innerHeight;
        const p = Math.min(1, Math.max(0, (vh - stage.getBoundingClientRect().top) / (vh * 0.75)));
        return MAX_LEAN * (1 - p * p * (3 - 2 * p));
      };

      const tgt = { lean: leanFor(), rx: 0, ry: 0 };
      const cur = { ...tgt };
      let frame = 0;
      let hovering = false;

      const apply = () => {
        const flat = cur.lean < 0.02 && Math.abs(cur.rx) < 0.02 && Math.abs(cur.ry) < 0.02;
        if (flat && !hovering) {
          plane.style.transform = "";
          plane.style.willChange = "";
        } else {
          plane.style.transform = `rotateX(${(cur.lean + cur.rx).toFixed(2)}deg) rotateY(${cur.ry.toFixed(2)}deg)`;
          plane.style.willChange = "transform";
        }
      };
      const render = () => {
        cur.lean += (tgt.lean - cur.lean) * 0.2;
        cur.rx += (tgt.rx - cur.rx) * 0.12;
        cur.ry += (tgt.ry - cur.ry) * 0.12;
        const settled =
          Math.abs(tgt.lean - cur.lean) < 0.01 && Math.abs(tgt.rx - cur.rx) < 0.01 && Math.abs(tgt.ry - cur.ry) < 0.01;
        if (settled) Object.assign(cur, tgt);
        apply();
        frame = settled ? 0 : requestAnimationFrame(render);
      };
      const kick = () => {
        if (!frame) frame = requestAnimationFrame(render);
      };
      apply();

      const onScroll = () => {
        tgt.lean = leanFor();
        kick();
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        hovering = true;
        const r = stage.getBoundingClientRect();
        tgt.ry = ((e.clientX - r.left) / r.width - 0.5) * 2 * MAX_TILT;
        tgt.rx = -((e.clientY - r.top) / r.height - 0.5) * 2 * MAX_TILT;
        kick();
      };
      const onLeave = () => {
        hovering = false;
        tgt.rx = tgt.ry = 0;
        kick();
      };

      // Only listen to scroll while the surface is near the viewport
      let listening = false;
      const io = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting && !listening) {
            window.addEventListener("scroll", onScroll, { passive: true });
            window.addEventListener("resize", onScroll, { passive: true });
            listening = true;
            onScroll();
          } else if (!entry.isIntersecting && listening) {
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", onScroll);
            listening = false;
          }
        },
        { rootMargin: "200px 0px" },
      );
      io.observe(stage);
      stage.addEventListener("pointermove", onMove, { passive: true });
      stage.addEventListener("pointerleave", onLeave);

      detach = () => {
        io.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
        stage.removeEventListener("pointermove", onMove);
        stage.removeEventListener("pointerleave", onLeave);
        if (frame) cancelAnimationFrame(frame);
        plane.style.transform = "";
        plane.style.willChange = "";
        detach = () => {};
      };
    };

    attach();
    mq.addEventListener("change", attach);
    return () => {
      mq.removeEventListener("change", attach);
      detach();
    };
  }, []);

  return (
    <div ref={stageRef} className="[perspective:1400px] lg:mb-10">
      <div ref={planeRef} className="relative origin-[50%_100%] [transform-style:preserve-3d]">
        <ProductSurface stage={3} />
        {chips.map((c) => (
          <div
            key={c.label}
            data-chip
            aria-hidden="true"
            className="pointer-events-none absolute hidden lg:block"
            style={{ ...c.place, transform: `translate3d(0, ${c.y}, ${c.z}px)` }}
          >
            {/* Floats only where there is a mouse; reduced motion is stopped globally in globals.css */}
            <div
              className="glass flex items-center gap-2.5 whitespace-nowrap rounded-xl py-2 pl-2 pr-3.5 shadow-float [@media(hover:hover)_and_(pointer:fine)]:animate-float"
              style={{ animationDelay: c.delay }}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-gradient-strong text-white">
                <Icon name={c.icon} className="h-4 w-4" />
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-[0.6875rem] font-medium text-muted">{c.label}</span>
                <span className={`text-[0.8125rem] font-semibold tabular-nums ${c.ok ? "text-emerald-700" : "text-ink"}`}>{c.value}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
