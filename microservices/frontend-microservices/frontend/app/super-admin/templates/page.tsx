"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import History from "@/components/templates/History";
import TemplateEditor from "@/components/templates/TemplateEditor";
import { tx } from "@/lib/i18n/tx";
import { useQueryState } from "@/lib/useQueryState";
import { getTemplate, listTemplates, type TemplateDetail, type TemplateSummary } from "@/lib/templates";

type Notice = { kind: "ok" | "error"; text: string } | null;

function TemplatesContent() {
  const [list, setList] = useState<TemplateSummary[]>([]);
  const [keyParam, setKeyParam] = useQueryState("key");
  const key = keyParam || list[0]?.key || null;
  const setKey = (k: string) => setKeyParam(k);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [tabParam, setTab] = useQueryState("view", "edit");
  const tab = (tabParam === "history" ? "history" : "edit") as "edit" | "history";
  const [notice, setNotice] = useState<Notice>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => listTemplates().then((l) => { setList(l); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load templates.")), []);
  const loadOne = useCallback((k: string) => getTemplate(k).then(setDetail).catch((e) => setError(e instanceof Error ? e.message : "Could not load the template.")), []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (key) { setDetail(null); loadOne(key); } }, [key, loadOne]);
  const reload = () => { loadList(); if (key) loadOne(key); };

  const groups: { title: string; items: TemplateSummary[] }[] = [
    { title: tx("Lead acquisition"), items: list.filter((t) => t.kind === "lead") },
    { title: tx("Proposal"), items: list.filter((t) => t.kind === "proposal") },
  ];

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full min-w-0 font-sans">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Templates")}</h1>
        <p className="text-sm text-slate-500 mt-0.5 max-w-3xl">{tx("The lead acquisition form and the Proposal, exactly as the product asks them today. Add, remove or reword fields, save a draft, then publish. A published change becomes the live version, is recorded with your reason, and the evaluation team is told which tests depend on it.")}</p>
      </div>
      <div className="flex flex-wrap gap-3 text-xs" data-testid="template-links">
        <Link className="text-blue-600 hover:underline" href={`/super-admin/evaluation/drift?q=${encodeURIComponent(key ? (list.find((t) => t.key === key)?.title ?? "") : "")}`}>{tx("Review items caused by template changes")}</Link>
        <Link className="text-blue-600 hover:underline" href="/super-admin/evaluation/drift?view=knowledge">{tx("Assistant knowledge for these templates")}</Link>
        <Link className="text-blue-600 hover:underline" href="/super-admin/evaluation/datasets">{tx("Evaluation datasets that test these forms")}</Link>
      </div>
      {notice && (
        <div className={`text-xs rounded-lg px-3 py-2 border flex justify-between gap-3 ${notice.kind === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-red-50 border-red-200 text-red-600"}`} role="status">
          <span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label={tx("Dismiss")}>×</button>
        </div>
      )}
      {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
      <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <nav aria-label={tx("Templates")} className="space-y-4">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{g.title}</div>
              <ul className="space-y-1">
                {g.items.map((t) => (
                  <li key={t.key}>
                    <button type="button" onClick={() => { setKey(t.key); }} aria-current={key === t.key}
                      className={`w-full text-left rounded-lg border px-3 py-2 text-xs ${key === t.key ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"}`}>
                      <span className="font-semibold text-slate-800">{t.title}</span>
                      <span className="block text-[10px] text-slate-400">v{t.published_version ?? "–"} · {t.fields} {tx("fields")}{t.has_draft ? ` · ${tx("draft")}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main className="min-w-0">
          <div className="flex gap-1 border-b border-slate-200 mb-4" role="tablist">
            {(["edit", "history"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px ${tab === t ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{t === "edit" ? tx("Edit") : tx("History")}</button>
            ))}
          </div>
          {!detail ? <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>
            : tab === "edit" ? <TemplateEditor key={`${detail.key}-${detail.draft?.updated_at ?? "p"}-${detail.published?.version}`} detail={detail} onReload={reload} onNotice={setNotice} />
              : <History detail={detail} onReload={reload} onNotice={setNotice} />}
        </main>
      </div>
    </div>
  );
}

export default function TemplatesPage() {
  return (
    <Suspense fallback={null}>
      <TemplatesContent />
    </Suspense>
  );
}
