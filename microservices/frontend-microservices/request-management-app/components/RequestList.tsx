"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";
import { requestsApi, RequestsError, type Page, type RequestRow } from "@/lib/requestsApi";
import { useRequestEvents } from "./RequestsShell";
import {
  Card, DueLabel, Empty, ErrorNote, ExecutionBadge, OPEN_STATUSES, PRIORITY_LABEL, Pager, PriorityText, REVIEW_LABEL, ReviewBadge,
  Segmented, SkeletonRows, TYPE_LABEL, TypeIcon, ghostButton, inputClass, relativeTime, useDebounced,
} from "./ui";

// One list for the three queues. Filtering, search and paging happen on the server; the search box is debounced.
// Each page passes quick tabs ("Needs your input", "Overdue", …) that set a filter in one click.

type Scope = "mine" | "review" | "tenant";
export interface Filters {
  status?: string; type?: string; priority?: string; overdue?: boolean; execution_status?: string;
  assignee?: string; created_from?: string; created_to?: string;
}
export interface Preset { key: string; label: string; count?: number; filters: Filters }

const PAGE_SIZE = 20;
const selectClass = `${inputClass} !w-auto !py-1.5 text-xs`;

export default function RequestList({ scope, presets, showRequester = true, showAssignee = true, emptyTitle, emptyHint, emptyAction }: {
  scope: Scope;
  presets: Preset[];
  showRequester?: boolean;
  showAssignee?: boolean;
  emptyTitle: string;
  emptyHint?: string;
  emptyAction?: ReactNode;
}) {
  const router = useRouter();
  const [preset, setPreset] = useState(presets[0]?.key ?? "all");
  const [q, setQ] = useState("");
  const [extra, setExtra] = useState<Filters>({});
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<RequestRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const search = useDebounced(q);

  const filters = useMemo<Filters>(() => ({ ...(presets.find((p) => p.key === preset)?.filters ?? {}), ...extra }), [presets, preset, extra]);
  const key = JSON.stringify(filters);
  useEffect(() => { setPage(1); }, [key, search]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setResult(await requestsApi.list({
        scope, page, page_size: PAGE_SIZE, q: search || undefined, status: filters.status, type: filters.type, priority: filters.priority,
        overdue: filters.overdue ? "true" : undefined, execution_status: filters.execution_status, assignee: filters.assignee,
        created_from: filters.created_from, created_to: filters.created_to,
      }));
    } catch (e) {
      setError(e instanceof RequestsError ? e.message : tx("Couldn't load requests."));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, page, search, key]);

  useEffect(() => { setResult(null); load(); }, [load, reload]);

  // A status changed somewhere this user can see: reload the page in place (no skeleton), once per burst.
  const liveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(liveTimer.current), []);
  useRequestEvents(() => {
    clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(load, 400);
  });

  const set = (patch: Filters) => setExtra((f) => {
    const next = { ...f, ...patch };
    (Object.keys(next) as (keyof Filters)[]).forEach((k) => { if (next[k] === "" || next[k] === undefined || next[k] === false) delete next[k]; });
    return next;
  });

  const chips: { label: string; clear: () => void }[] = [];
  if (extra.status) chips.push({ label: tx(REVIEW_LABEL[extra.status as keyof typeof REVIEW_LABEL] ?? extra.status), clear: () => set({ status: undefined }) });
  if (extra.type) chips.push({ label: tx(TYPE_LABEL[extra.type] ?? extra.type), clear: () => set({ type: undefined }) });
  if (extra.priority) chips.push({ label: tx(PRIORITY_LABEL[extra.priority as keyof typeof PRIORITY_LABEL] ?? extra.priority), clear: () => set({ priority: undefined }) });
  if (extra.created_from) chips.push({ label: tx("From {date}", { date: extra.created_from }), clear: () => set({ created_from: undefined }) });
  if (extra.created_to) chips.push({ label: tx("To {date}", { date: extra.created_to }), clear: () => set({ created_to: undefined }) });
  if (extra.assignee) chips.push({ label: tx("Unassigned"), clear: () => set({ assignee: undefined }) });
  const filtered = !!(search || chips.length || preset !== presets[0]?.key);

  return (
    <Card>
      <div className="space-y-3 border-b border-slate-100 px-4 py-3">
        <Segmented label={tx("Quick filters")} value={preset} onChange={(v) => setPreset(v)}
          options={presets.map((p) => ({ value: p.key, label: p.label, count: p.count }))} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <svg viewBox="0 0 20 20" fill="currentColor" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
            </svg>
            <input className={`${inputClass} !py-1.5 ps-9 text-xs`} placeholder={tx("Search reference, title, customer, requester…")} value={q}
              onChange={(e) => setQ(e.target.value)} aria-label={tx("Search")} />
          </div>
          <select className={selectClass} value={extra.status ?? ""} onChange={(e) => set({ status: e.target.value })} aria-label={tx("Status")}>
            <option value="">{tx("Any status")}</option>
            {Object.entries(REVIEW_LABEL).filter(([s]) => scope === "mine" || s !== "DRAFT").map(([s, l]) => <option key={s} value={s}>{tx(l)}</option>)}
          </select>
          <select className={selectClass} value={extra.type ?? ""} onChange={(e) => set({ type: e.target.value })} aria-label={tx("Type")}>
            <option value="">{tx("Any type")}</option>
            {Object.entries(TYPE_LABEL).map(([c, l]) => <option key={c} value={c}>{tx(l)}</option>)}
          </select>
          <select className={selectClass} value={extra.priority ?? ""} onChange={(e) => set({ priority: e.target.value })} aria-label={tx("Priority")}>
            <option value="">{tx("Any priority")}</option>
            {Object.entries(PRIORITY_LABEL).map(([p, l]) => <option key={p} value={p}>{tx(l)}</option>)}
          </select>
          <button type="button" className={ghostButton} onClick={() => setMore((m) => !m)} aria-expanded={more}>
            {more ? tx("Fewer filters") : tx("More filters")}
          </button>
        </div>
        {more && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3">
            <label className="text-[11px] font-semibold text-slate-500">{tx("Created from")}
              <input type="date" className={`${inputClass} mt-1 !py-1.5 text-xs`} value={extra.created_from ?? ""} onChange={(e) => set({ created_from: e.target.value })} />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">{tx("Created to")}
              <input type="date" className={`${inputClass} mt-1 !py-1.5 text-xs`} value={extra.created_to ?? ""} onChange={(e) => set({ created_to: e.target.value })} />
            </label>
            {scope === "tenant" && (
              <label className="flex items-center gap-2 pb-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={extra.assignee === "unassigned"} onChange={(e) => set({ assignee: e.target.checked ? "unassigned" : undefined })} />
                {tx("Only unassigned (waiting in a team queue)")}
              </label>
            )}
          </div>
        )}
        {(chips.length > 0 || search) && (
          <div className="flex flex-wrap items-center gap-2">
            {chips.map((c) => (
              <button key={c.label} type="button" onClick={c.clear}
                className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100">
                {c.label} <span aria-hidden="true">×</span><span className="sr-only">{tx("Remove filter")}</span>
              </button>
            ))}
            <button type="button" className="text-[11px] font-semibold text-slate-500 underline" onClick={() => { setExtra({}); setQ(""); }}>
              {tx("Clear all")}
            </button>
          </div>
        )}
      </div>

      {error ? <div className="p-4"><ErrorNote message={error} onRetry={() => setReload((n) => n + 1)} /></div>
        : !result ? <SkeletonRows />
          : result.items.length === 0 ? (
            <Empty title={filtered ? tx("No requests match these filters.") : emptyTitle} hint={filtered ? tx("Try another quick filter or clear the search.") : emptyHint}
              action={filtered ? undefined : emptyAction} />
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {result.items.map((r) => {
                  const open = OPEN_STATUSES.includes(r.review_status);
                  const responsible = r.assignee_name ?? (r.queue_role ? tx("{role} queue", { role: r.queue_role }) : null);
                  return (
                    <li key={r.id}>
                      <button type="button" onClick={() => router.push(`/requests/${r.id}`)}
                        className="grid w-full grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 px-4 py-3 text-start transition-colors hover:bg-slate-50 focus:bg-blue-50/50 focus:outline-none md:grid-cols-[auto_minmax(0,2.4fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                        <TypeIcon type={r.request_type} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-slate-900">{r.title}</span>
                            {r.overdue && <span className="shrink-0 rounded bg-red-600 px-1.5 text-[10px] font-bold uppercase text-white">{tx("Overdue")}</span>}
                          </span>
                          <span className="block truncate text-[11px] text-slate-500">
                            {r.reference_no} · {tx(TYPE_LABEL[r.request_type] ?? r.request_type)}{r.subject_label ? ` · ${r.subject_label}` : ""}
                          </span>
                        </span>
                        <span className="col-start-2 flex flex-wrap items-center gap-1.5 md:col-start-auto">
                          <ReviewBadge status={r.review_status} />
                          <ExecutionBadge status={r.execution_status} />
                        </span>
                        <span className="col-start-2 min-w-0 text-xs text-slate-600 md:col-start-auto">
                          {showRequester && <span className="block truncate">{r.requester_name}</span>}
                          {showAssignee && <span className="block truncate text-slate-400">{responsible ? `→ ${responsible}` : "—"}</span>}
                          {!showRequester && !showAssignee && <PriorityText priority={r.priority} />}
                        </span>
                        <span className="col-start-2 flex flex-col gap-0.5 text-start md:col-start-auto md:items-end md:text-end">
                          <PriorityText priority={r.priority} />
                          {open ? <DueLabel due={r.due_at} open overdue={r.overdue} /> : <span className="text-[11px] text-slate-400">{tx("Updated {when}", { when: relativeTime(r.updated_at) })}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <Pager page={page} pageSize={PAGE_SIZE} total={result.total} onPage={setPage} />
            </>
          )}
    </Card>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** A headline number. Clickable stats jump to the matching quick filter. */
export function Stat({ label, value, tone = "slate", hint }: { label: string; value: number | undefined; tone?: "slate" | "amber" | "red" | "blue"; hint?: string }) {
  const tones = { slate: "text-slate-900", amber: "text-amber-700", red: "text-red-700", blue: "text-blue-700" };
  const bars = { slate: "bg-slate-300", amber: "bg-amber-400", red: "bg-red-500", blue: "bg-blue-500" };
  return (
    <Card className="relative overflow-hidden px-4 py-3">
      <span className={`absolute inset-y-0 start-0 w-1 ${bars[tone]}`} aria-hidden="true" />
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold ${tones[tone]}`}>{value ?? "—"}</p>
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </Card>
  );
}
