"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import TraceDrawer from "@/components/benchmarking/TraceDrawer";
import { Decision } from "@/components/evaluation/DriftWorkspace";
import { tx } from "@/lib/i18n/tx";
import { show } from "@/lib/evalCosts";
import { getDraft, type DriftAction, type DriftItem } from "@/lib/evalDrift";
import { TEMPLATES_ROUTE, getImpact, listImpactCandidates, studioHref, type Impact, type ImpactCandidate, type ImpactSuggestion } from "@/lib/evalStudio";
import { useQueryState } from "@/lib/useQueryState";

// Change impact, in two moments. FIRST you choose a change: a full-width search with type filters and a "needs attention" switch, over a grid of cards that say what changed and
// what is waiting. THEN you follow that one change: a header that says where you are and lets you switch, the one thing to do next, the numbers that matter, and the seven stages
// of the chain as a vertical timeline you can open one at a time. Everything shown is read from the recorded data; a stage with nothing says so.

const chip = "inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap";
const SEV: Record<string, string> = { critical: "bg-red-50 text-red-700 border-red-200", high: "bg-red-50 text-red-700 border-red-200", medium: "bg-amber-50 text-amber-700 border-amber-200", low: "bg-slate-50 text-slate-500 border-slate-200" };
const btn = "rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400";
const btnPrimary = "rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400";
const TYPE_LABEL: Record<string, string> = { template: "Templates", rule: "Rules", plan: "Plans", workflow: "Workflows", calc: "Calculations", gate: "Gates", access: "Access rules" };
const TYPE_TONE: Record<string, string> = { template: "bg-violet-50 text-violet-700 border-violet-200", rule: "bg-amber-50 text-amber-700 border-amber-200", plan: "bg-sky-50 text-sky-700 border-sky-200", workflow: "bg-emerald-50 text-emerald-700 border-emerald-200" };
const typeName = (t: string) => TYPE_LABEL[t] ?? `${t[0].toUpperCase()}${t.slice(1)}s`;
const typeOne = (t: string) => ({ template: "Template", rule: "Rule", plan: "Plan", workflow: "Workflow", calc: "Calculation", gate: "Gate", access: "Access rule" } as Record<string, string>)[t] ?? t;

/** "3 days ago" style, from an ISO time. */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} days ago` : new Date(iso).toLocaleDateString();
}

/** The changes that match a search, a type and the "needs attention" switch, in the order asked for. Needs-attention means open review items. */
export function filterChanges(list: ImpactCandidate[], f: { q: string; type: string; attention: boolean; sort: "recent" | "cases" | "name" }): ImpactCandidate[] {
  const q = f.q.trim().toLowerCase();
  const out = list.filter((c) => (!f.type || c.type === f.type) && (!f.attention || c.open_findings > 0) && (!q || `${c.title} ${c.key} ${typeOne(c.type)}`.toLowerCase().includes(q)));
  const by = { recent: (a: ImpactCandidate, b: ImpactCandidate) => (b.open_findings > 0 ? 1 : 0) - (a.open_findings > 0 ? 1 : 0) || (b.changed_at ?? "").localeCompare(a.changed_at ?? "") || a.title.localeCompare(b.title),
    cases: (a: ImpactCandidate, b: ImpactCandidate) => b.dependent_cases - a.dependent_cases || a.title.localeCompare(b.title), name: (a: ImpactCandidate, b: ImpactCandidate) => a.title.localeCompare(b.title) }[f.sort];
  return [...out].sort(by);
}

function Mark({ text, q }: { text: string; q: string }) {
  const i = q.trim() ? text.toLowerCase().indexOf(q.trim().toLowerCase()) : -1;
  return i < 0 ? <>{text}</> : <>{text.slice(0, i)}<mark className="rounded bg-yellow-100 px-0.5 text-inherit dark:bg-yellow-900/50">{text.slice(i, i + q.trim().length)}</mark>{text.slice(i + q.trim().length)}</>;
}

/** One change as a card (landing) or a row (switcher menu): what it is, how it changed, how many cases lean on it, and whether something is waiting. */
function ChangeOption({ c, q, id, active, selected, compact, onPick }: { c: ImpactCandidate; q: string; id: string; active: boolean; selected: boolean; compact: boolean; onPick: () => void }) {
  return (
    <li role="option" id={id} aria-selected={selected} data-change={c.key}>
      <button type="button" tabIndex={-1} onClick={onPick} onMouseDown={(e) => e.preventDefault()}
        className={`w-full rounded-xl border text-left transition-colors ${compact ? "px-3 py-2" : "p-3.5"} ${active ? "border-blue-500 bg-blue-50/60 dark:bg-blue-950/30" : "border-slate-200 bg-white hover:border-sky-300 dark:border-slate-700 dark:bg-slate-900"}`}>
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="block break-words text-xs font-semibold text-slate-900 dark:text-slate-50"><Mark text={c.title} q={q} /></span>
            <span className="mt-0.5 block text-[10px] text-slate-400">{c.version ? `v${c.version}` : ""}{c.changed_at ? ` · ${tx("changed")} ${ago(c.changed_at)}` : ` · ${tx("never changed since first recorded")}`}</span>
          </span>
          <span className={`${chip} ${TYPE_TONE[c.type] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}>{tx(typeOne(c.type))}</span>
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{c.dependent_cases} {c.dependent_cases === 1 ? tx("case depends on it") : tx("cases depend on it")}</span>
          {c.open_findings > 0 ? <span className="rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-800">{c.open_findings} {tx("waiting for review")}</span> : c.changed_at ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700">{tx("nothing waiting")}</span> : null}
        </span>
      </button>
    </li>
  );
}

/** The search, the filters and the results as ONE combobox: type to narrow, the arrow keys move through the results, Enter opens one. `menu` is the compact version used to switch changes. */
export interface FinderState { q: string; type: string; attention: string; sort: string; setQ: (v: string) => void; setType: (v: string) => void; setAttention: (v: string) => void; setSort: (v: string) => void }

/** The finder with its search, filters and sort kept in the address (so a search survives a reload and can be shared, and the back button undoes a filter). */
export function ChangeFinder(props: { cands: ImpactCandidate[]; value: string; onPick: (key: string) => void; menu?: boolean; onClose?: () => void }) {
  const menu = !!props.menu;
  const [q, setQ] = useQueryState(menu ? "ifind" : "iq", "", { replace: true });
  const [type, setType] = useQueryState(menu ? "ifindtype" : "itype");
  const [attention, setAttention] = useQueryState(menu ? "ifindattn" : "iattn");
  const [sort, setSort] = useQueryState("isort", "recent", { replace: true });
  return <FinderView {...props} state={{ q, type, attention, sort, setQ, setType, setAttention, setSort }} />;
}

/** The search, the filters and the results as ONE combobox: type to narrow, the arrow keys move through the results, Enter opens one. `menu` is the compact version used to switch changes. */
export function FinderView({ cands, value, onPick, menu = false, onClose, state }: { cands: ImpactCandidate[]; value: string; onPick: (key: string) => void; menu?: boolean; onClose?: () => void; state: FinderState }) {
  const { q, type, attention, sort, setQ, setType, setAttention, setSort } = state;
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const types = useMemo(() => Array.from(new Set(cands.map((c) => c.type))).sort((a, b) => a.localeCompare(b)), [cands]);
  const shown = useMemo(() => filterChanges(cands, { q, type, attention: attention === "1", sort: (["recent", "cases", "name"].includes(sort) ? sort : "recent") as "recent" | "cases" | "name" }), [cands, q, type, attention, sort]);
  const waiting = cands.filter((c) => c.open_findings > 0).length;
  useEffect(() => { setAt(0); }, [q, type, attention, sort]);
  useEffect(() => { if (menu) input.current?.focus(); }, [menu]);
  useEffect(() => {
    if (menu) return;
    const onKey = (e: globalThis.KeyboardEvent) => { const t = e.target as HTMLElement; if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && shown[at]) { e.preventDefault(); onPick(shown[at].key); }
    else if (e.key === "Escape") { if (q) setQ(""); else onClose?.(); }
  };
  const listId = menu ? "change-menu-list" : "change-list";
  const filtered = !!(q || type || attention === "1");
  const pill = (on: boolean) => `rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${on ? "border-blue-500 bg-blue-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"}`;
  return (
    <div className={menu ? "space-y-2" : "space-y-3"} data-testid={menu ? "change-menu" : "change-finder"}>
      <div className="relative">
        <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        <input ref={input} type="search" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={shown[at] ? `${listId}-${at}` : undefined}
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} autoComplete="off" spellCheck={false} data-testid="change-search"
          placeholder={tx("Search by name, type or key: lead form, premium, KYC…")} aria-label={tx("Search changes")}
          className={`w-full rounded-xl border border-slate-200 bg-white pl-10 pr-16 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-900 dark:focus:ring-blue-900 ${menu ? "py-2" : "py-3"}`} />
        {!menu && !q && <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-slate-200 px-1.5 text-[10px] text-slate-400 dark:border-slate-600" aria-hidden>/</kbd>}
        {q && <button type="button" onClick={() => { setQ(""); input.current?.focus(); }} aria-label={tx("Clear the search")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-700">{tx("Clear")}</button>}
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={tx("Filter by type")} data-testid="change-filters">
        <button type="button" aria-pressed={!type} onClick={() => setType("")} className={pill(!type)}>{tx("All")} <span className="opacity-70">{cands.length}</span></button>
        {types.map((t) => <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(type === t ? "" : t)} className={pill(type === t)} data-type={t}>{tx(typeName(t))} <span className="opacity-70">{cands.filter((c) => c.type === t).length}</span></button>)}
        <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:block dark:bg-slate-700" aria-hidden />
        <button type="button" role="switch" aria-checked={attention === "1"} disabled={waiting === 0 && attention !== "1"} onClick={() => setAttention(attention === "1" ? "" : "1")} data-testid="attention-switch"
          className={`${pill(attention === "1")} disabled:opacity-40`}>{tx("Needs review")} <span className="opacity-70">{waiting}</span></button>
        {!menu && (
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-500">{tx("Sort")}
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-slate-700 dark:bg-slate-900" aria-label={tx("Sort the changes")}>
              <option value="recent">{tx("Needs review, then recent")}</option><option value="cases">{tx("Most cases affected")}</option><option value="name">{tx("Name")}</option>
            </select>
          </label>
        )}
      </div>

      <p className="text-[11px] text-slate-500" role="status" aria-live="polite" data-testid="change-count">
        {shown.length === cands.length ? `${cands.length} ${tx("items the evaluation watches")}` : `${shown.length} ${tx("of")} ${cands.length}`}
        {filtered && <button type="button" className="ml-2 font-semibold text-blue-600 hover:underline" onClick={() => { setQ(""); setType(""); setAttention(""); }}>{tx("Clear filters")}</button>}
      </p>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center dark:border-slate-700" data-testid="change-none">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{cands.length === 0 ? tx("Nothing is being watched yet.") : tx("No change matches.")}</p>
          <p className="mt-1 text-xs text-slate-500">{cands.length === 0 ? tx("Rules, plans, workflows and form templates appear here once the change registry has read them.") : tx("Try a shorter search, or clear the filters.")}</p>
        </div>
      ) : (
        <ul role="listbox" id={listId} aria-label={tx("Changes")} className={menu ? "max-h-72 space-y-1.5 overflow-y-auto pr-1" : "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"} data-testid="impact-candidates">
          {shown.map((c, i) => <ChangeOption key={c.key} c={c} q={q} id={`${listId}-${i}`} active={i === at} selected={c.key === value} compact={menu} onPick={() => onPick(c.key)} />)}
        </ul>
      )}
    </div>
  );
}

// ── the chain ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type StageState = "done" | "pending" | "empty";
const TONE: Record<StageState, string> = { done: "bg-emerald-500", pending: "bg-amber-500", empty: "bg-slate-300 dark:bg-slate-600" };
const WORD: Record<StageState, string> = { done: "done", pending: "waiting", empty: "nothing yet" };

function Step({ n, title, state, summary, open, onToggle, last, children, testId }: { n: number; title: string; state: StageState; summary: string; open: boolean; onToggle: () => void; last: boolean; children: ReactNode; testId: string }) {
  return (
    <li className="relative pb-3 pl-10" id={testId}>
      {!last && <span className="absolute left-[13px] top-7 bottom-0 w-0.5 bg-slate-200 dark:bg-slate-700" aria-hidden />}
      <span className={`absolute left-0 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white ring-4 ring-white dark:ring-slate-950 ${TONE[state]}`} aria-hidden>{state === "done" ? "✓" : n}</span>
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" data-testid={testId.replace("step", "stage")} data-state={state}>
        <h3>
          <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`${testId}-body`} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900 dark:text-slate-50">{title}</span>
              <span className="block text-[11px] text-slate-500">{summary}</span>
            </span>
            <span className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-semibold ${state === "done" ? "bg-emerald-50 text-emerald-700" : state === "pending" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{tx(WORD[state])}</span>
            <span className={`flex-none text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>▾</span>
          </button>
        </h3>
        <div id={`${testId}-body`} hidden={!open} className="space-y-2 border-t border-slate-100 px-4 py-3 text-xs dark:border-slate-800">{children}</div>
      </section>
    </li>
  );
}

const delta = (d: number | null, fmt: (x: number) => string, goodWhenUp: boolean) => d === null ? <span className="text-slate-400">—</span> : <b className={d === 0 ? "text-slate-500" : (d > 0) === goodWhenUp ? "text-emerald-600" : "text-red-600"}>{d > 0 ? "+" : d < 0 ? "−" : ""}{fmt(Math.abs(d))}</b>;

/** The one thing to do next for this change, worked out from the recorded stages (never a guess): review what waits, publish what was accepted, run the regression, or cover an uncovered change. */
export function nextAction(impact: Impact): { text: string; step: number; href?: string; cta: string } | null {
  const s = impact.stages, datasets = Object.keys(impact.dataset_versions);
  const accepted = impact.suggested_updates.filter((u) => u.state === "accepted").length;
  if (s.open_suggestions > 0) return { text: `${s.open_suggestions} ${tx("review item(s) are waiting for a decision.")}`, step: 3, cta: tx("Review them") };
  if (accepted > 0 && s.new_versions === 0 && datasets[0]) return { text: tx("Accepted drafts are waiting to be written into a new dataset version."), step: 5, href: studioHref({ tool: "datasets", dataset: datasets[0] }), cta: tx("Open the dataset manager") };
  if (s.change && datasets.length > 0 && !datasets.some((d) => impact.regression[d]?.runs.some((r) => r.phase === "after"))) return { text: tx("No real-model run exists since the change, so its effect on quality and cost is unknown."), step: 6, href: studioHref({ mode: "simulate", dataset: datasets[0] }), cta: tx("Run a regression") };
  if (s.change && s.affected_cases === 0) return { text: tx("No case declares a dependency on this change, so the dataset does not cover it."), step: 2, cta: tx("See why") };
  return null;
}

/** The whole chain for one changed item, from the real recorded data: the change, the cases that declare a dependency on it, the review items it caused, where each stands, the dataset versions
 *  published since, the real runs before and after, and what that did to quality and cost. A stage with nothing says so; no link is invented. */
export function ImpactView({ impact, onDecide, onOpenTrace, onDraft, draft }: { impact: Impact; onDecide: (s: ImpactSuggestion, a: DriftAction) => void; onOpenTrace: (resultId: string) => void; onDraft: (s: ImpactSuggestion) => void; draft: string | null }) {
  const s = impact.stages;
  const latest = impact.versions[0];
  const byDataset = useMemo(() => { const m: Record<string, Impact["dependents"]> = {}; impact.dependents.forEach((d) => (m[d.dataset] ||= []).push(d)); return m; }, [impact.dependents]);
  const accepted = impact.suggested_updates.filter((u) => u.state === "accepted");
  const datasets = Object.keys(impact.dataset_versions);
  const afterRun = datasets.some((d) => impact.regression[d]?.runs.some((r) => r.phase === "after"));
  const states: StageState[] = [s.change ? "done" : "empty", s.affected_cases > 0 ? "done" : "empty", s.suggestions === 0 ? "empty" : s.open_suggestions > 0 ? "pending" : "done", accepted.length > 0 ? "done" : s.suggestions > 0 ? "pending" : "empty",
    s.new_versions > 0 ? "done" : datasets.length > 0 ? "pending" : "empty", afterRun ? "done" : datasets.length > 0 ? "pending" : "empty", s.regression_pairs > 0 ? "done" : "empty"];
  const next = nextAction(impact);
  const firstPending = states.findIndex((x) => x === "pending");
  const [open, setOpen] = useState<Set<number>>(() => new Set([next?.step ? next.step - 1 : firstPending >= 0 ? firstPending : 0]));
  const flip = (i: number) => setOpen((o) => { const n = new Set(o); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const reveal = (i: number) => { setOpen((o) => new Set(o).add(i)); setTimeout(() => document.getElementById(`step-${["change", "cases", "suggestions", "approval", "versions", "regression", "impact"][i]}`)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), 30); };
  const kpis = [
    { label: tx("Cases affected"), value: s.affected_cases, step: 1, tone: s.affected_cases > 0 ? "" : "text-amber-600" }, { label: tx("Waiting for review"), value: s.open_suggestions, step: 2, tone: s.open_suggestions > 0 ? "text-amber-600" : "" },
    { label: tx("New dataset versions"), value: s.new_versions, step: 4, tone: "" }, { label: tx("Before / after comparisons"), value: s.regression_pairs, step: 6, tone: "" },
  ];
  return (
    <div className="space-y-4" data-testid="impact-view">
      {next && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/30" data-testid="next-action">
          <span className="text-[10px] font-bold uppercase tracking-wide text-blue-700 dark:text-sky-300">{tx("Next")}</span>
          <p className="min-w-0 flex-1 text-xs text-slate-800 dark:text-slate-100">{next.text}</p>
          {next.href ? <Link className={btnPrimary} href={next.href}>{next.cta} →</Link> : <button type="button" className={btnPrimary} onClick={() => reveal(next.step - 1)}>{next.cta}</button>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="impact-kpis">
        {kpis.map((k) => (
          <button key={k.label} type="button" onClick={() => reveal(k.step)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left hover:border-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:border-slate-700 dark:bg-slate-900">
            <span className={`block text-xl font-bold ${k.tone || "text-slate-900 dark:text-slate-50"}`}>{k.value}</span><span className="block text-[11px] text-slate-500">{k.label}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-400">{tx("From the change to its effect")}</h2>
        <button type="button" className="text-[11px] font-semibold text-blue-600 hover:underline" onClick={() => setOpen(open.size >= 7 ? new Set() : new Set([0, 1, 2, 3, 4, 5, 6]))}>{open.size >= 7 ? tx("Collapse all") : tx("Expand all")}</button>
      </div>

      <ol className="m-0 list-none p-0">
        <Step n={1} title={tx("Change")} state={states[0]} testId="step-change" open={open.has(0)} onToggle={() => flip(0)} last={false}
          summary={s.change ? `${tx("Recorded")} ${new Date(impact.changed_at!).toLocaleString()} · v${latest.version - 1} → v${latest.version}` : tx("This item has been recorded once, with no change since.")}>
          <p className="break-words font-semibold text-slate-800 dark:text-slate-100">{impact.item.title}</p>
          <p className="break-all text-[10px] text-slate-400">{impact.item.key}{impact.item.source ? ` · ${impact.item.source}` : ""}</p>
          {latest && latest.diff.length > 0 && (
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1" data-testid="diff-list">
              {latest.diff.slice(0, 14).map((d, i) => (
                <li key={i} className="rounded-md bg-slate-50 px-2 py-1 text-[10px] dark:bg-slate-800"><span className="break-all font-mono text-slate-700 dark:text-slate-200">{d.path || "content"}</span> <span className="text-slate-400">{d.change}</span>
                  {d.before !== null && d.before !== undefined && <div className="break-all text-red-600">− {JSON.stringify(d.before).slice(0, 160)}</div>}
                  {d.after !== null && d.after !== undefined && <div className="break-all text-emerald-700">+ {JSON.stringify(d.after).slice(0, 160)}</div>}</li>))}
            </ul>
          )}
          {impact.item.type === "template" && <Link className={btn} href={`${TEMPLATES_ROUTE}?key=${encodeURIComponent(impact.item.key.slice(9))}`}>{tx("Open the template")}</Link>}
        </Step>
        <Step n={2} title={tx("Affected cases")} state={states[1]} testId="step-cases" open={open.has(1)} onToggle={() => flip(1)} last={false}
          summary={s.affected_cases > 0 ? `${s.affected_cases} ${tx("case(s) declare a dependency on this item")}` : tx("No case declares a dependency on it, so the dataset does not cover this change.")}>
          {Object.entries(byDataset).map(([ds, list]) => (
            <div key={ds}><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{ds} {list[0].version}</p>
              <ul className="mt-1 flex flex-wrap gap-1">{list.map((d) => (
                <li key={d.case_id}>{d.latest_real_result ? (
                  <button type="button" onClick={() => onOpenTrace(d.latest_real_result!.result_id)} title={`${tx("latest real run")}: ${d.latest_real_result.status} (${d.latest_real_result.model ?? ""})`}
                    className={`${chip} ${d.latest_real_result.status === "passed" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`} data-case={d.case_id}>{d.case_id}</button>
                ) : <span className={`${chip} border-slate-200 bg-slate-50 text-slate-500`} title={tx("no real-model run of this case yet")} data-case={d.case_id}>{d.case_id}</span>}</li>))}</ul></div>
          ))}
          {s.affected_cases > 0 && <p className="text-[10px] text-slate-400">{tx("Green passed and red failed in the latest real-model run; grey has none. Click one to read its trace.")}</p>}
        </Step>
        <Step n={3} title={tx("Suggested updates")} state={states[2]} testId="step-suggestions" open={open.has(2)} onToggle={() => flip(2)} last={false}
          summary={s.suggestions === 0 ? tx("The review queue holds nothing about this change.") : `${s.suggestions} ${tx("review item(s)")}, ${s.open_suggestions} ${tx("waiting")}`}>
          <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
            {impact.suggested_updates.map((u) => (
              <li key={u.id} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700" data-suggestion={u.state}>
                <div className="flex flex-wrap items-center gap-1.5"><span className={`${chip} ${SEV[u.severity] ?? SEV.low}`}>{u.severity}</span><span className="text-[10px] text-slate-400">{u.kind.replace("_", " ")} · {u.state.replace("_", " ")}</span></div>
                <p className="mt-1 text-[11px] text-slate-700 dark:text-slate-200">{u.summary}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {u.state === "open" && <><button type="button" className={btnPrimary} onClick={() => onDecide(u, "start")}>{tx("Start review")}</button><button type="button" className={btn} onClick={() => onDecide(u, "dismiss")}>{tx("Dismiss")}</button></>}
                  {u.state === "in_review" && <><button type="button" className={btnPrimary} onClick={() => onDecide(u, "accept")}>{tx("Accept")}</button><button type="button" className={btn} onClick={() => onDecide(u, "reject")}>{tx("Reject")}</button><button type="button" className={btn} onClick={() => onDecide(u, "reopen")}>{tx("Back to open")}</button></>}
                  {(u.state === "rejected" || u.state === "dismissed") && <button type="button" className={btn} onClick={() => onDecide(u, "reopen")}>{tx("Reopen")}</button>}
                </div>
              </li>))}
          </ul>
        </Step>
        <Step n={4} title={tx("Approval")} state={states[3]} testId="step-approval" open={open.has(3)} onToggle={() => flip(3)} last={false}
          summary={accepted.length > 0 ? `${accepted.length} ${tx("accepted: each is a draft case, not a change to the dataset")}` : tx("Nothing accepted yet. You write the expected value yourself; the system never does.")}>
          {accepted.map((u) => <div key={u.id} className="flex items-center justify-between gap-2"><span className="truncate text-[11px] text-slate-600 dark:text-slate-300">{u.summary.slice(0, 80)}</span><span className="flex shrink-0 items-center gap-1.5">{u.needs_expected && <button type="button" className={btn} onClick={() => onDraft(u)}>{tx("Prepare draft")}</button>}
            {u.dataset && <Link className={btn} href={studioHref({ tool: "datasets", dataset: u.dataset })} data-testid="open-in-dataset-manager">{tx("Open in Dataset Manager")}</Link>}</span></div>)}
          {draft && <pre className="max-h-48 overflow-auto rounded-md bg-slate-50 p-2 text-[10px] dark:bg-slate-800" data-testid="draft">{draft}</pre>}
          <p className="text-[10px] text-slate-400">{impact.principle}</p>
        </Step>
        <Step n={5} title={tx("New dataset version")} state={states[4]} testId="step-versions" open={open.has(4)} onToggle={() => flip(4)} last={false}
          summary={s.new_versions > 0 ? `${s.new_versions} ${tx("published since the change")}` : datasets.length > 0 ? tx("None published since the change.") : tx("No dataset is affected.")}>
          {datasets.map((ds) => (
            <div key={ds}><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{ds}</p>
              <ul className="mt-1 space-y-0.5">{impact.dataset_versions[ds].slice(0, 5).map((v) => <li key={v.version} className="flex justify-between text-[11px]"><span className={v.after_change ? "font-semibold text-emerald-700" : "text-slate-500"}>{v.version}{v.after_change ? ` · ${tx("after the change")}` : ""}</span><span className="text-slate-400">{v.published_at ? new Date(v.published_at).toLocaleDateString() : ""} · {v.case_count}</span></li>)}</ul>
              <Link className={`${btn} mt-1 inline-block`} href={studioHref({ tool: "datasets", dataset: ds })}>{tx("Open the dataset manager")}</Link></div>
          ))}
        </Step>
        <Step n={6} title={tx("Regression evaluation")} state={states[5]} testId="step-regression" open={open.has(5)} onToggle={() => flip(5)} last={false}
          summary={afterRun ? tx("Real-model runs exist after the change.") : tx("No real-model run since the change.")}>
          {datasets.map((ds) => (
            <div key={ds}><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{ds}</p>
              <ul className="mt-1 space-y-0.5">{(impact.regression[ds]?.runs ?? []).slice(0, 6).map((r) => <li key={r.run_id} className="flex justify-between text-[11px]"><span className="text-slate-600 dark:text-slate-300">{r.model ?? tx("no model")} · {r.version} · {r.phase ?? tx("(no change recorded)")}</span><span>{r.pass_rate === null ? "—" : `${(r.pass_rate * 100).toFixed(0)}%`}</span></li>)}</ul>
              <Link className={`${btn} mt-1 inline-block`} href={studioHref({ mode: "simulate", dataset: ds })}>{tx("Run a regression")}</Link></div>
          ))}
        </Step>
        <Step n={7} title={tx("Quality & cost impact")} state={states[6]} testId="step-impact" open={open.has(6)} onToggle={() => flip(6)} last
          summary={s.regression_pairs > 0 ? tx("The same model, before and after the change.") : tx("Needs a real-model run on both sides of the change for the same model: none yet, so no impact is claimed.")}>
          {datasets.flatMap((ds) => impact.regression[ds]?.compare ?? []).map((c) => (
            <div key={c.model} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700" data-compare={c.model}>
              <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">{c.model}</p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">{tx("pass rate")} {c.before.pass_rate === null ? "—" : `${(c.before.pass_rate * 100).toFixed(0)}%`} → {c.after.pass_rate === null ? "—" : `${(c.after.pass_rate * 100).toFixed(0)}%`} {delta(c.pass_rate_delta, (x) => `${(x * 100).toFixed(1)} pts`, true)}</p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">{tx("cost per execution")} {show(c.before.ran ? c.before.cost_usd / c.before.ran : null)} → {show(c.after.ran ? c.after.cost_usd / c.after.ran : null)} {delta(c.cost_per_execution_delta, (x) => show(x), false)}</p>
            </div>
          ))}
        </Step>
      </ol>
    </div>
  );
}

/** The bar over a followed change: the way back to all changes, where you are, and a switcher that is a real search (not a short list). */
function ChangeBar({ cands, impact, value, onBack, onPick }: { cands: ImpactCandidate[]; impact: Impact | null; value: string; onBack: () => void; onPick: (k: string) => void }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const cur = cands.find((c) => c.key === value);
  const title = impact?.item.title ?? cur?.title ?? value;
  const type = impact?.item.type ?? cur?.type ?? "";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" data-testid="change-bar">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[11px]">
        <button type="button" onClick={onBack} className="font-semibold text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" data-testid="all-changes">← {tx("All changes")}</button>
        <span className="text-slate-300" aria-hidden>/</span>
      </nav>
      <div className="relative min-w-0" ref={ref}>
        <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="listbox" data-testid="switch-change"
          className="flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:hover:bg-slate-800">
          <span className="truncate text-sm font-bold text-slate-900 dark:text-slate-50">{title}</span>
          {type && <span className={`${chip} ${TYPE_TONE[type] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>{tx(typeOne(type))}</span>}
          <span className="text-slate-400" aria-hidden>▾</span>
        </button>
        {menu && (
          <div className="absolute left-0 z-20 mt-1.5 w-[min(32rem,90vw)] rounded-xl border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <ChangeFinder cands={cands} value={value} menu onClose={() => setMenu(false)} onPick={(k) => { setMenu(false); onPick(k); }} />
          </div>
        )}
      </div>
      {impact?.changed_at && <span className="ml-auto text-[11px] text-slate-500">{tx("changed")} {ago(impact.changed_at)} · v{impact.versions[0].version - 1} → v{impact.versions[0].version}</span>}
    </div>
  );
}

export default function ImpactExplorer() {
  const [key, setKey] = useQueryState("impact");
  const [cands, setCands] = useState<ImpactCandidate[] | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ s: ImpactSuggestion; a: DriftAction } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { listImpactCandidates().then(setCands).catch((e) => setError(e instanceof Error ? e.message : "Could not list the changes.")); }, []);
  const load = useCallback(() => { if (!key) { setImpact(null); return; } getImpact(key).then((i) => { setImpact(i); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the impact.")); }, [key]);
  useEffect(() => { setImpact(null); setDraft(null); load(); }, [load]);
  async function prepare(u: ImpactSuggestion) {
    try { setDraft(JSON.stringify((await getDraft(u.id)).draft, null, 2)); } catch (e) { setError(e instanceof Error ? e.message : "No draft could be prepared."); }
  }
  return (
    <div className="space-y-4" data-testid="impact-explorer">
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>}
      {!key ? (
        <>
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">{tx("What did a change touch?")}</h2>
            <p className="mt-0.5 max-w-3xl text-xs text-slate-500" data-testid="impact-empty">{tx("Choose a rule, plan, workflow or form template. You will see the cases that lean on it, the review it caused, the new dataset version, and what it did to quality and cost.")}</p>
          </div>
          {!cands ? (
            <div aria-busy="true" className="space-y-3"><div className="h-12 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />)}</div></div>
          ) : <ChangeFinder cands={cands} value="" onPick={setKey} />}
        </>
      ) : (
        <>
          <ChangeBar cands={cands ?? []} impact={impact} value={key} onBack={() => setKey("")} onPick={setKey} />
          {!impact && !error && <div aria-busy="true" className="space-y-3"><div className="h-14 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" /><div className="h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" /></div>}
          {impact && <ImpactView key={impact.item.key} impact={impact} draft={draft} onOpenTrace={setTrace} onDraft={prepare} onDecide={(s, a) => setDeciding({ s, a })} />}
        </>
      )}
      {trace && <TraceDrawer resultId={trace} onClose={() => setTrace(null)} />}
      {deciding && <Decision item={{ id: deciding.s.id, kind: deciding.s.kind, summary: deciding.s.summary, needs_expected: deciding.s.needs_expected } as unknown as DriftItem} action={deciding.a} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); load(); }} />}
    </div>
  );
}
