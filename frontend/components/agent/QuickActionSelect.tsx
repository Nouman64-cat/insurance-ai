"use client";

import React, { useState } from "react";
import type { QuickAction } from "@/lib/agent/types";

/**
 * The dropdown form of a quick action.
 *
 * Chips work for three or four fixed choices. They stop working the moment the
 * choice is a live list — every rule category in the catalogue, every policy a
 * customer could claim against, every legal next status. Those are what this
 * renders instead: one `<select>` plus a confirm button, so the user still
 * never types.
 *
 * Choosing a value runs `action.payload` with `{value}` substituted (or the
 * bare value, when the payload carries no placeholder) through `onRun` — which
 * is the host's normal submit path, so it resumes a pending clarify interrupt
 * or opens a new turn without this component needing to know which.
 */
export function QuickActionSelect({
  action,
  onRun,
  variant = "chip",
}: {
  action: QuickAction;
  onRun: (text: string) => void;
  variant?: "chip" | "card";
}) {
  const [value, setValue] = useState("");
  const options = action.options ?? [];
  if (options.length === 0) return null;

  const run = (chosen: string) => {
    if (!chosen) return;
    const text = action.payload?.includes("{value}")
      ? action.payload.replace("{value}", chosen)
      : action.payload || chosen;
    onRun(text);
  };

  // A single option is not a choice — render it as a one-click chip so the
  // user isn't asked to "pick" from a list of one.
  if (options.length === 1) {
    return (
      <button
        type="button"
        onClick={() => run(options[0].value)}
        className="px-3 py-1.5 text-[12px] font-bold rounded-full border bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200 shadow-sm transition-all active:scale-95"
      >
        {action.label}: {options[0].label}
      </button>
    );
  }

  const compact = variant === "chip";

  return (
    <div
      className={`flex items-center gap-1.5 rounded-2xl border border-blue-200 bg-blue-50/70 ${
        compact ? "px-2 py-1.5" : "px-3 py-2"
      }`}
    >
      <label className="text-[11px] font-bold uppercase tracking-wide text-blue-700 whitespace-nowrap">
        {action.label}
      </label>
      <select
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          // Selecting IS the decision — no second click to hunt for.
          run(e.target.value);
        }}
        className={`min-w-0 flex-1 rounded-lg border border-blue-200 bg-white font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${
          compact ? "max-w-[16rem] px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
        }`}
      >
        <option value="">{action.placeholder || "Choose one…"}</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
