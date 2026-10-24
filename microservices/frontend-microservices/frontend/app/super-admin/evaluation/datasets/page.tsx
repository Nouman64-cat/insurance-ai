"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import DatasetsWorkspace from "@/components/evaluation/DatasetsWorkspace";
import { tx } from "@/lib/i18n/tx";
import { TEMPLATES_ROUTE } from "@/lib/evaluationCenter";
import { listTemplates, type TemplateSummary } from "@/lib/templates";

/** The form templates the datasets test. They are shared product configuration, so they stay managed on their own page and are shown here for context. */
function TemplatesStrip() {
  const [list, setList] = useState<TemplateSummary[]>([]);
  useEffect(() => { listTemplates().then(setList).catch(() => setList([])); }, []);
  if (list.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="templates-strip">
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{tx("Form templates under test")}</span>
      {list.map((t) => (
        <Link key={t.key} href={`${TEMPLATES_ROUTE}?key=${encodeURIComponent(t.key)}`} className="text-xs text-slate-700 hover:text-blue-600">
          {t.title} <span className="text-slate-400">v{t.published_version ?? "–"}{t.has_draft ? ` · ${tx("draft")}` : ""}</span>
        </Link>
      ))}
      <Link href={TEMPLATES_ROUTE} className="ml-auto text-xs font-semibold text-blue-600 hover:underline">{tx("Manage templates")} →</Link>
    </div>
  );
}

export default function Page() {
  return (
    <>
      <TemplatesStrip />
      <DatasetsWorkspace />
    </>
  );
}
