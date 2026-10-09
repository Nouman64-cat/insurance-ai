"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Thin top-of-page progress bar for client-side navigations. The App Router has
// no route-change events, so we start on any click of an internal <a> (which is
// what next/link renders) and finish when the pathname/search actually changes.
export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimers = () => {
    if (trickle.current) clearInterval(trickle.current);
    if (hide.current) clearTimeout(hide.current);
    trickle.current = null;
    hide.current = null;
  };

  useEffect(() => {
    const start = () => {
      stopTimers();
      setVisible(true);
      setProgress(8);
      // Ease towards 90% without ever reaching it; completion jumps to 100%.
      trickle.current = setInterval(() => {
        setProgress((p) => (p < 90 ? p + (90 - p) * 0.08 : p));
      }, 150);
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest("a");
      if (!anchor || !anchor.href || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page (or just a #hash jump): nothing to load.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      start();
    };

    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      stopTimers();
    };
  }, []);

  // Route committed: finish the bar and fade it out.
  useEffect(() => {
    if (!trickle.current) return;
    stopTimers();
    setProgress(100);
    hide.current = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 250);
  }, [pathname, searchParams]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[9999] h-[3px]"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms ease" }}
    >
      <div
        className="h-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.7)]"
        style={{ width: `${progress}%`, transition: "width 200ms ease" }}
      />
    </div>
  );
}
