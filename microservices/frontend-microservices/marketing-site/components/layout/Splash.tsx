"use client";

import { useEffect, useRef, useState } from "react";
import { LogoMark } from "./LogoMark";

// First-visit landing screen: the logo mark pops in on a white screen with the tagline under it,
// holds until 2 s after the page began loading, then the screen fades away and the header logo
// appears beneath it. Visibility before JS runs is handled by CSS (globals.css,
// html[data-splash="pending"]), including a failsafe that hides the screen if JS never runs.
const HOLD_MS = 2000;
const FADE_MS = 700;

export function Splash() {
  const [gone, setGone] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);

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

    const wait = Math.max(0, HOLD_MS - performance.now());
    const fade = layerRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: FADE_MS,
      delay: wait,
      easing: "ease-in-out",
      fill: "forwards",
    });
    const timers = [
      // Reveal the header logo as the screen starts fading, so it is already there underneath
      window.setTimeout(() => {
        root.dataset.logoReady = "1";
      }, wait),
      window.setTimeout(() => setGone(true), wait + FADE_MS + 60),
      // Page animations finish by ~4 s; switching earlier would make them jump.
      window.setTimeout(() => {
        root.dataset.splash = "seen";
      }, wait + FADE_MS + 1400),
    ];

    return () => {
      timers.forEach(window.clearTimeout);
      fade?.cancel();
    };
  }, []);

  if (gone) return null;

  return (
    <div ref={layerRef} aria-hidden="true" className="splash-layer fixed inset-0 z-[100] bg-canvas">
      <div className="flex h-full flex-col items-center justify-center gap-6 px-4">
        <span className="splash-mark">
          <LogoMark className="h-24 w-auto" />
        </span>
        <p className="splash-tag text-center text-sm text-muted">From lead to claim, on one auditable platform</p>
      </div>
    </div>
  );
}
