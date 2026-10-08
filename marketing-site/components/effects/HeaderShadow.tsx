"use client";

import { useEffect } from "react";

// Marks the page as scrolled so the header can show a soft shadow instead of a divider line.
export function HeaderShadow() {
  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      if (window.scrollY > 8) root.dataset.scrolled = "1";
      else delete root.dataset.scrolled;
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return null;
}
