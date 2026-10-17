"use client";
import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { tx } from "@/lib/i18n/tx";

export type CaseTab = "overview" | "requirements" | "documents" | "applicant";
export const CASE_TABS: { id: CaseTab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "requirements", label: "Requirements" },
  { id: "documents", label: "Documents" }, { id: "applicant", label: "Applicant & Policy" },
];
export default function CaseWorkspaceHeader({ name, reference, status, fields, actions, extraStatus, tab, onTab, documentCount, headerRef, backLabel = "Underwriting" }: {
  name: string; reference: string; status: ReactNode; fields: { label: string; value: ReactNode }[];
  actions?: ReactNode; extraStatus?: ReactNode; tab: CaseTab; onTab: (tab: CaseTab) => void;
  documentCount: number; headerRef?: Ref<HTMLDivElement>; backLabel?: string;
}) {
  return <div ref={headerRef} className="sticky top-0 z-20 -mx-6 border-b border-slate-200 bg-white/95 px-6 pt-5 backdrop-blur supports-[backdrop-filter]:bg-white/80">
    <Link href="/underwriting?tab=pre-underwriting" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-blue-700">← {tx(backLabel)} <span className="text-slate-300">·</span><span className="font-mono text-xs text-slate-400">{reference.replace(/^CASE-/, "APP-")}</span></Link>
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-4"><div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-base font-bold text-white shadow-sm">{name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</div>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-2xl font-bold tracking-tight text-slate-900">{name}</h1>{status}{extraStatus}</div>
          <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">{fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "").map((f) => <div key={f.label} className="flex items-baseline gap-1.5"><dt className="text-slate-400">{tx(f.label)}</dt><dd className="font-medium text-slate-700">{f.value}</dd></div>)}</dl>
        </div>
      </div>{actions}
    </div>
    <div className="-mb-px mt-4 flex gap-1 overflow-x-auto" role="tablist" aria-label={tx("Case sections")}>{CASE_TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)} className={`inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${tab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{tx(t.label)}{t.id === "documents" && documentCount > 0 && <span className="rounded-full bg-slate-100 px-1.5 text-xs">{documentCount}</span>}</button>)}</div>
  </div>;
}
