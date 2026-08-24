"use client";

import React from "react";

/**
 * Marks a screen whose figures are generated in the browser rather than read
 * from a system of record.
 *
 * Treasury, settlement, holdbacks, clawbacks, tax and SECP reporting have no
 * backend yet — `app/services/commissions.ts` invents their rows so the
 * screens render. That is fine while the module is being built and dangerous
 * the moment someone screenshots it for a board pack, so every page rendering
 * those generators shows this.
 *
 * Delete the banner from a page as soon as that page reads a real endpoint.
 */
export default function DemoDataBanner({ note }: { note?: string }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <p className="text-xs leading-relaxed text-amber-900">
        <span className="font-semibold">Illustrative data — not a system of record.</span>{" "}
        {note ??
          "This module has no backend yet. Figures are generated in the browser and must not be used for payment, tax filing, or regulatory reporting."}
      </p>
    </div>
  );
}
