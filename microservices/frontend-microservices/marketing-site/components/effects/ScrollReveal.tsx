"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

// Reveals every [data-reveal] element as it scrolls into view. Once an element has
// finished animating its attribute is removed, so hover transitions are left alone.
//
// Three safety nets keep a section from ever staying blank:
//  - a MutationObserver picks up elements added after first render (route changes, hot reload)
//  - a passive scroll check reveals anything already in view that the IntersectionObserver
//    has not reported (it can lag behind fast wheel scrolling and content-visibility)
//  - a short timer sweeps the first screen after load
export function ScrollReveal() {
  const pathname = usePathname();

  useEffect(() => {
    const pending = new Set<HTMLElement>();
    const finish = (el: HTMLElement) => {
      pending.delete(el);
      observer?.unobserve(el);
      el.classList.add("is-visible");
      window.setTimeout(() => el.removeAttribute("data-reveal"), 1800);
    };

    const inView = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight * 0.96 && r.bottom > 0;
    };

    const sweep = () => pending.forEach((el) => inView(el) && finish(el));

    let observer: IntersectionObserver | undefined;
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(
        (entries) => entries.forEach((e) => e.isIntersecting && finish(e.target as HTMLElement)),
        { threshold: 0, rootMargin: "0px 0px 8% 0px" }
      );
    }

    const track = (el: HTMLElement) => {
      if (el.classList.contains("is-visible") || pending.has(el)) return;
      pending.add(el);
      observer?.observe(el);
    };

    document.querySelectorAll<HTMLElement>("[data-reveal]").forEach(track);
    if (!observer) pending.forEach(finish);

    const mutations = new MutationObserver((records) => {
      records.forEach((rec) =>
        rec.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.hasAttribute("data-reveal")) track(node);
          node.querySelectorAll<HTMLElement>("[data-reveal]").forEach(track);
        })
      );
      sweep();
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    let frame = 0;
    const onScroll = () => {
      if (frame || pending.size === 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sweep();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const timers = [300, 1200].map((ms) => window.setTimeout(sweep, ms));

    return () => {
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener("scroll", onScroll);
      timers.forEach(window.clearTimeout);
      cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return null;
}
