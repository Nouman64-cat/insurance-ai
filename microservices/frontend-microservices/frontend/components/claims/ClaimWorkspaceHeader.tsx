"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";

// The claim page's frame, the same pattern as the Underwriting Workbench's case page: a sticky header with who and what,
// the facts that matter inline, the actions on the right, and the sections as tabs underneath. Stays in view while the
// page scrolls, so the status and the next action are always one glance away.
export interface ClaimTab { id: string; label: string; count?: number }

export default function ClaimWorkspaceHeader({ name, reference, status, fields, actions, tabs, tab, onTab }: {
  name: string;
  reference: string;
  status: ReactNode;
  fields: { label: string; value: ReactNode }[];
  actions?: ReactNode;
  tabs: ClaimTab[];
  tab: string;
  onTab: (id: string) => void;
}) {
  const initials = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  return (
    <div className="sticky top-0 z-20 -mx-6 border-b border-slate-200 bg-white/95 px-6 pt-5 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <Link href="/claims" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-blue-700">
        ← {tx("Claims Register")} <span className="text-slate-300">·</span>
        <span className="font-mono text-xs text-slate-400">{reference}</span>
      </Link>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-base font-bold text-white shadow-sm" aria-hidden="true">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900">{name}</h1>
              {status}
            </div>
            <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              {fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "" && f.value !== "—").map((f) => (
                <div key={f.label} className="flex items-baseline gap-1.5">
                  <dt className="text-slate-400">{f.label}</dt>
                  <dd className="font-medium text-slate-700">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2 lg:justify-end">{actions}</div>}
      </div>
      <div className="-mb-px mt-4 flex gap-1 overflow-x-auto" role="tablist" aria-label={tx("Claim sections")}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            className={`inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
              tab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
          >
            {t.label}
            {!!t.count && <span className="rounded-full bg-slate-100 px-1.5 text-xs">{t.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
