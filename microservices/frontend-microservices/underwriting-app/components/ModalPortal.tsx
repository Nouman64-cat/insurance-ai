"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Renders its children on <body>, outside whatever stacking context the caller sits in. A position:sticky ancestor
// (like the case page's pinned left column) makes its own stacking context, so a fixed z-50 modal inside it would still
// be painted *under* later siblings that have a z-index of their own. On <body> a z-50 modal is above all of them.
export default function ModalPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(children, document.body) : null;
}
