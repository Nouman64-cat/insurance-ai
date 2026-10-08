"use client";

import { useEffect, useRef, useState } from "react";
import { LogoMark } from "./LogoMark";
import { siteConfig } from "@/lib/site-config";

// First-visit landing animation, in three beats:
//   1. 0 - 2 s   the logo draws itself in the middle of a deep-blue screen
//   2. 2 - 3 s   the logo flies to the header corner, shrinking and turning dark as it goes while
//                the blue screen fades away, and the page slides in around it (CSS: .intro-*)
//   3. 3 s       the real header logo takes over exactly where the flying one landed
// Visibility before JS runs is handled by CSS (globals.css, html[data-splash="pending"]); this
// component measures the real header logo and runs the flight with the Web Animations API, which
// only moves transform and opacity.
const HOLD_MS = 2000;
const FLY_MS = 1000;
const FADE_MS = 850;
const EASE = "cubic-bezier(0.65, 0, 0.2, 1)";

export function Splash() {
  const [gone, setGone] = useState(false);
  const bgRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const tagRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.splash !== "pending") {
      setGone(true);
      return;
    }
    try {
      sessionStorage.setItem("splash-seen", "1");
    } catch {
      // storage unavailable: the splash may replay on reload, which is harmless
    }

    const bg = bgRef.current;
    const fly = flyRef.current;
    const name = nameRef.current;
    const tag = tagRef.current;
    const target = document.querySelector<HTMLElement>("[data-logo-target]");
    const animations: Animation[] = [];
    const timers: number[] = [];

    // Start the flight 2 s after the page began loading, whatever the hydration time was
    const wait = Math.max(0, HOLD_MS - performance.now());
    const finish = () => {
      root.dataset.logoReady = "1";
      setGone(true);
    };

    if (bg && fly && name && tag && target) {
      const to = target.getBoundingClientRect();
      const from = fly.getBoundingClientRect();
      const dx = to.left - root.clientWidth / 2;
      const dy = to.top - window.innerHeight / 2;
      const scale = to.width / from.width;
      const darkText = getComputedStyle(target.lastElementChild ?? target).color;

      animations.push(
        fly.animate(
          [
            { transform: "translate(-50%, -50%) scale(1)" },
            { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          ],
          { duration: FLY_MS, delay: wait, easing: EASE, fill: "both" },
        ),
        name.animate([{ color: "#ffffff" }, { color: darkText }], { duration: FLY_MS, delay: wait, easing: EASE, fill: "both" }),
        bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, delay: wait + 150, easing: "ease-in-out", fill: "both" }),
        tag.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, delay: Math.max(0, wait - 100), fill: "forwards" }),
      );
      timers.push(window.setTimeout(finish, wait + FLY_MS + 60));
    } else {
      // No header logo to land on: just fade the screen out
      timers.push(window.setTimeout(finish, wait + 600));
    }

    // Page animations finish by ~4 s; switching earlier would make them jump.
    timers.push(
      window.setTimeout(() => {
        root.dataset.splash = "seen";
      }, wait + FLY_MS + 1400),
    );

    return () => {
      timers.forEach(window.clearTimeout);
      animations.forEach((a) => a.cancel());
    };
  }, []);

  if (gone) return null;

  return (
    <div aria-hidden="true">
      <div ref={bgRef} className="splash-layer fixed inset-0 z-[100] bg-brand-deep" />
      {/* Same lockup as the header logo, built 2.5x larger so shrinking it stays sharp */}
      <div
        ref={flyRef}
        className="splash-layer splash-fly fixed z-[101] items-center gap-5 whitespace-nowrap"
        style={{ left: "50%", top: "50%", width: "max-content", transform: "translate(-50%, -50%)", transformOrigin: "0 0" }}
      >
        <span className="splash-mark">
          <LogoMark animated className="h-20 w-20 rounded-[1.25rem]" />
        </span>
        <span ref={nameRef} className="text-[2.5rem] font-semibold tracking-tight text-white">
          {Array.from(siteConfig.name).map((char, i) => (
            <span key={i} className="splash-letter" style={{ "--i": i } as React.CSSProperties}>
              {char === " " ? " " : char}
            </span>
          ))}
        </span>
      </div>
      <p
        ref={tagRef}
        className="splash-layer splash-tag fixed left-1/2 z-[101] -translate-x-1/2 whitespace-nowrap text-sm text-blue-200"
        style={{ top: "calc(50% + 3.75rem)" }}
      >
        From lead to claim, on one auditable platform
      </p>
    </div>
  );
}
