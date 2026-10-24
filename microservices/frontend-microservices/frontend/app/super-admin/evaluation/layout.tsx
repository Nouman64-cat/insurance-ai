"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CENTER_TABS, TEMPLATES_ROUTE, crumbsFor } from "@/lib/evaluationCenter";
import { getOverview } from "@/lib/evalDrift";
import { tx } from "@/lib/i18n/tx";

function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "";
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { getOverview().then((o) => setOpen(o.open)).catch(() => setOpen(null)); }, [path]);
  const crumbs = crumbsFor(path);
  return (
    <div className="px-6 py-5 space-y-4 max-w-screen-2xl mx-auto w-full min-w-0 font-sans">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav aria-label="Breadcrumb" className="text-[11px] text-slate-400 flex gap-1 items-center" data-testid="breadcrumbs">
            <Link href="/super-admin/tenants" className="hover:text-slate-600">{tx("Super Admin")}</Link>
            {crumbs.map((c) => (
              <span key={c.label} className="flex gap-1 items-center"><span>/</span>{c.href ? <Link href={c.href} className="hover:text-slate-600">{tx(c.label)}</Link> : <span className="text-slate-600" aria-current="page">{tx(c.label)}</span>}</span>
            ))}
          </nav>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight mt-1">{tx("AI Evaluation Center")}</h1>
          <p className="text-sm text-slate-500 mt-0.5 max-w-3xl">{tx("Datasets, change review and model benchmarking in one place. Every finding links to the dataset, form template or benchmark it concerns.")}</p>
        </div>
        <Link href={TEMPLATES_ROUTE} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-slate-300" data-testid="templates-link">{tx("Manage form templates")} →</Link>
      </div>
      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto" role="tablist" data-testid="center-tabs">
        {CENTER_TABS.map((t) => {
          const active = t.match(path);
          return (
            <Link key={t.id} href={t.href} role="tab" aria-selected={active} className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px whitespace-nowrap ${active ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
              {tx(t.label)}{t.id === "drift" && open ? <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px]" data-testid="drift-count">{open}</span> : null}
            </Link>
          );
        })}
      </div>
      <div>{children}</div>
    </div>
  );
}

export default function EvaluationCenterLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}><Frame>{children}</Frame></Suspense>;
}
