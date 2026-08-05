"use client";

import { useEffect, useState } from "react";

export interface NewLeadInfo {
  id: string;
  name: string;
  type: "INDIVIDUAL" | "FAMILY" | "CORPORATE";
  contact_info: string;
  /** Who the lead is assigned to. Null when nobody owns it yet. */
  agentName?: string | null;
  createdAt: string;
}

const TYPE_LABEL: Record<NewLeadInfo["type"], string> = {
  INDIVIDUAL: "Individual",
  FAMILY: "Family",
  CORPORATE: "Corporate",
};

/**
 * Interrupting popup for leads that appear while the board is open — typically
 * created by an agent in the mobile app. The toast alone is easy to miss when
 * the user is mid-task, and knowing a lead just landed is the whole point of
 * the two-way sync.
 *
 * Batched: if several arrive at once the dialog names the first and counts the
 * rest, rather than stacking one dialog per lead.
 */
export default function NewLeadAlert({
  leads,
  onDismiss,
  onView,
}: {
  leads: NewLeadInfo[];
  onDismiss: () => void;
  onView: (lead: NewLeadInfo) => void;
}) {
  const [entered, setEntered] = useState(false);

  // Mount first, animate on the next frame — a transition from an element's
  // initial render is not animated by the browser.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Escape should close, matching every other dialog on the site.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  if (leads.length === 0) return null;

  const primary = leads[0];
  const extra = leads.length - 1;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-lead-alert-title"
    >
      <div
        className={`absolute inset-0 bg-slate-900/40 transition-opacity duration-200 ${entered ? "opacity-100" : "opacity-0"}`}
        onClick={onDismiss}
      />

      <div
        className={`relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 transition-all duration-200
          ${entered ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-95"}`}
      >
        <div className="p-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 border border-emerald-200">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-7 w-7 text-emerald-600"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" y1="8" x2="19" y2="14" />
              <line x1="22" y1="11" x2="16" y2="11" />
            </svg>
          </div>

          <h2 id="new-lead-alert-title" className="text-lg font-bold text-slate-900">
            {extra > 0 ? `${leads.length} new leads added` : "New lead added"}
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            <span className="font-semibold text-slate-700">{primary.name}</span>
            {" · "}
            {TYPE_LABEL[primary.type]}
            {extra > 0 ? ` and ${extra} more` : ""}
          </p>

          <dl className="mt-5 space-y-2 rounded-xl bg-slate-50 border border-slate-100 p-4 text-left text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Contact</dt>
              <dd className="font-medium text-slate-800 truncate">{primary.contact_info}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Added by</dt>
              <dd className="font-medium text-slate-800 truncate">
                {primary.agentName ?? "Unassigned"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Received</dt>
              <dd className="font-medium text-slate-800">
                {new Date(primary.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </dd>
            </div>
          </dl>

          <div className="mt-6 flex gap-3">
            <button
              onClick={onDismiss}
              className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Dismiss
            </button>
            <button
              onClick={() => onView(primary)}
              className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
            >
              View lead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
