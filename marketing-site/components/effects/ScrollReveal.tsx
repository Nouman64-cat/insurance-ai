"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

// Reveals every [data-reveal] element as it scrolls into view. Once an element has
// finished animating its attribute is removed, so hover transitions are left alone.
export function ScrollReveal() {
  const pathname = usePathname();

  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const finish = (el: HTMLElement) => {
      el.classList.add("is-visible");
      window.setTimeout(() => el.removeAttribute("data-reveal"), 1800);
    };

    if (!("IntersectionObserver" in window)) {
      targets.forEach(finish);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          finish(entry.target as HTMLElement);
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" }
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pathname]);

  return null;
}
