"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { TEMPLATES_ROUTE, searchStudio, studioHref, type SearchGroup, type SearchItem } from "@/lib/evalStudio";

export interface Command { id: string; title: string; sub?: string; href: string; group: string }

/** Where a search hit leads: always somewhere that exists, always opened in the Studio's own panels. */
export function hitHref(kind: SearchGroup["kind"], item: SearchItem): string {
  switch (kind) {
    case "dataset": return studioHref({ node: `dataset:${item.id}` });
    case "case": return studioHref({ tool: "datasets", dataset: item.dataset });
    case "benchmark": return studioHref({ mode: "investigate", sub: "benchmarks", bench: item.id });
    case "run": return studioHref({ mode: "investigate", extra: { ir: item.id } });
    case "model": return studioHref({ node: `provider:${item.provider}` });
    case "rule": return studioHref({ lens: "impact", impact: item.id });
    case "finding": return studioHref({ tool: "drift", extra: { item: item.id } });
  }
}

export const COMMANDS: Command[] = [
  { id: "explore", title: "Explore the ecosystem", sub: "The map and its health", href: studioHref(), group: "Go to" },
  { id: "impact", title: "Follow a change", sub: "Rule, plan or template change → cases → review → regression", href: studioHref({ lens: "impact" }), group: "Go to" },
  { id: "simulate", title: "Start an evaluation or a model benchmark", sub: "Estimate first, then run", href: studioHref({ mode: "simulate" }), group: "Go to" },
  { id: "investigate", title: "Investigate executions", sub: "Failures, traces and replay", href: studioHref({ mode: "investigate" }), group: "Go to" },
  { id: "analytics", title: "Analytics", sub: "Pass rates, DeepEval layers, routing, latency, reliability, drift", href: studioHref({ mode: "investigate", sub: "analytics" }), group: "Go to" },
  { id: "compare-runs", title: "Compare two runs", sub: "What got worse, what got better, cost and latency", href: studioHref({ mode: "investigate", sub: "runs" }), group: "Go to" },
  { id: "failures", title: "Show only the failures", sub: "Across every real-model run", href: studioHref({ mode: "investigate", extra: { st: "failed" } }), group: "Go to" },
  { id: "compare", title: "Compare models by quality, speed and cost", href: studioHref({ mode: "investigate", sub: "compare" }), group: "Go to" },
  { id: "datasets", title: "Golden datasets", sub: "Create, edit, approve and publish cases", href: studioHref({ tool: "datasets" }), group: "Workbench" },
  { id: "drift", title: "Drift review queue", sub: "Decide on findings and suggested cases", href: studioHref({ tool: "drift" }), group: "Workbench" },
  { id: "costs", title: "Costs & budgets", sub: "Limits, bills, usage records, rates", href: studioHref({ tool: "costs" }), group: "Workbench" },
  { id: "bills", title: "Enter a provider bill", href: studioHref({ tool: "costs", extra: { view: "reconcile" } }), group: "Workbench" },
  { id: "templates", title: "Form templates", sub: "Shared lead and proposal configuration", href: TEMPLATES_ROUTE, group: "Workbench" },
];

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (open) { setQ(""); setGroups([]); setAt(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setGroups([]); return; }
    setBusy(true);
    const t = setTimeout(() => { searchStudio(q.trim()).then((r) => setGroups(r.groups)).catch(() => setGroups([])).finally(() => setBusy(false)); }, 200);
    return () => clearTimeout(t);
  }, [q, open]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const cmds = COMMANDS.filter((c) => !needle || `${c.title} ${c.sub ?? ""}`.toLowerCase().includes(needle)).map((c) => ({ key: `c:${c.id}`, title: tx(c.title), sub: c.sub ? tx(c.sub) : undefined, href: c.href, group: tx(c.group) }));
    const hits = groups.flatMap((g) => g.items.map((i) => ({ key: `${g.kind}:${i.id}`, title: i.title, sub: i.sub, href: hitHref(g.kind, i), group: tx(g.label) })));
    return [...hits, ...cmds];
  }, [q, groups]);
  useEffect(() => { setAt(0); }, [rows.length]);
  if (!open) return null;
  const go = (href: string) => { onClose(); router.push(href); };
  return (
    <div className="fixed inset-0 z-[400] flex items-start justify-center bg-slate-900/50 p-4 pt-[12vh] backdrop-blur-sm" onClick={onClose} data-testid="palette">
      <div role="dialog" aria-modal="true" aria-label={tx("Search the evaluation studio")} className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
          else if (e.key === "Enter" && rows[at]) go(rows[at].href);
        }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx("Search datasets, cases, runs, models, rules… or type a command")} aria-label={tx("Search")} data-testid="palette-input"
          className="w-full border-b border-slate-100 bg-transparent px-4 py-3.5 text-sm text-slate-900 outline-none dark:border-slate-800 dark:text-slate-50" />
        <ul className="max-h-[55vh] overflow-y-auto py-1.5" role="listbox">
          {rows.length === 0 && <li className="px-4 py-8 text-center text-xs text-slate-400">{busy ? tx("Searching…") : q.trim().length < 2 ? tx("Type at least two letters.") : tx("Nothing matches.")}</li>}
          {rows.map((r, i) => (
            <li key={r.key} role="option" aria-selected={i === at}>
              {(i === 0 || rows[i - 1].group !== r.group) && <p className="px-4 pb-0.5 pt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">{r.group}</p>}
              <button type="button" onMouseEnter={() => setAt(i)} onClick={() => go(r.href)} className={`flex w-full flex-col px-4 py-2 text-left ${i === at ? "bg-sky-50 dark:bg-slate-800" : ""}`} data-testid="palette-row">
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.title}</span>{r.sub && <span className="text-[11px] text-slate-400">{r.sub}</span>}
              </button>
            </li>))}
        </ul>
        <p className="border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400 dark:border-slate-800">↑↓ {tx("to move")} · Enter {tx("to open")} · Esc {tx("to close")}</p>
      </div>
    </div>
  );
}
