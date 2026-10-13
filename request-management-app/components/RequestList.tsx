"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { requestsApi, RequestsError, type Page, type RequestRow } from "@/lib/requestsApi";
import {
  Card, Empty, ErrorNote, ExecutionBadge, PRIORITY_LABEL, Pager, PriorityText, REVIEW_LABEL, ReviewBadge, Spinner, TYPE_LABEL,
  formatDate, inputClass, useDebounced,
} from "./ui";

// One list for the three queues. Filtering, search and paging happen on the server; text filters are debounced.

type Scope = "mine" | "review" | "tenant";

const PAGE_SIZE = 20;

export default function RequestList({ scope, showRequester = true, showAssignee = true, emptyTitle, emptyHint }: {
  scope: Scope;
  showRequester?: boolean;
  showAssignee?: boolean;
  emptyTitle: string;
  emptyHint?: string;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [priority, setPriority] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [assignee, setAssignee] = useState("");
  const [branch, setBranch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<RequestRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const search = useDebounced(q);
  const branchId = useDebounced(branch);

  // Any filter change starts again from the first page.
  useEffect(() => { setPage(1); }, [search, status, type, priority, overdue, from, to, assignee, branchId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await requestsApi.list({
        scope, page, page_size: PAGE_SIZE, q: search || undefined, status: status || undefined, type: type || undefined,
        priority: priority || undefined, overdue: overdue ? "true" : undefined, created_from: from || undefined, created_to: to || undefined,
        assignee: assignee || undefined, branch: branchId.trim() || undefined,
      });
      setResult(data);
    } catch (e) {
      setError(e instanceof RequestsError ? e.message : tx("Couldn't load requests."));
    }
  }, [scope, page, search, status, type, priority, overdue, from, to, assignee, branchId]);

  useEffect(() => { load(); }, [load, reload]);

  const filtered = !!(search || status || type || priority || overdue || from || to || assignee || branchId);

  return (
    <Card>
      <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <input className={`${inputClass} lg:col-span-2`} placeholder={tx("Search reference, title, customer…")} value={q}
          onChange={(e) => setQ(e.target.value)} aria-label={tx("Search")} />
        <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={tx("Status")}>
          <option value="">{tx("Any status")}</option>
          {Object.entries(REVIEW_LABEL).filter(([s]) => scope === "mine" || s !== "DRAFT").map(([s, l]) => <option key={s} value={s}>{tx(l)}</option>)}
        </select>
        <select className={inputClass} value={type} onChange={(e) => setType(e.target.value)} aria-label={tx("Type")}>
          <option value="">{tx("Any type")}</option>
          {Object.entries(TYPE_LABEL).map(([c, l]) => <option key={c} value={c}>{tx(l)}</option>)}
        </select>
        <select className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value)} aria-label={tx("Priority")}>
          <option value="">{tx("Any priority")}</option>
          {Object.entries(PRIORITY_LABEL).map(([p, l]) => <option key={p} value={p}>{tx(l)}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> {tx("Overdue only")}
        </label>
        <label className="text-xs text-slate-500">{tx("Created from")}
          <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">{tx("Created to")}
          <input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {scope === "tenant" && (
          <>
            <select className={inputClass} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label={tx("Assignee")}>
              <option value="">{tx("Any assignee")}</option>
              <option value="unassigned">{tx("Unassigned (in a team queue)")}</option>
            </select>
            <input className={inputClass} placeholder={tx("Branch id")} value={branch} onChange={(e) => setBranch(e.target.value)} aria-label={tx("Branch")} />
          </>
        )}
      </div>

      {error ? <div className="p-4"><ErrorNote message={error} onRetry={() => setReload((n) => n + 1)} /></div>
        : !result ? <Spinner />
          : result.items.length === 0 ? <Empty title={filtered ? tx("No requests match these filters.") : emptyTitle} hint={filtered ? undefined : emptyHint} />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 text-start font-semibold">{tx("Request")}</th>
                      <th className="px-4 py-2.5 text-start font-semibold">{tx("Status")}</th>
                      <th className="px-4 py-2.5 text-start font-semibold">{tx("Priority")}</th>
                      {showRequester && <th className="px-4 py-2.5 text-start font-semibold">{tx("Requester")}</th>}
                      {showAssignee && <th className="px-4 py-2.5 text-start font-semibold">{tx("Responsible")}</th>}
                      <th className="px-4 py-2.5 text-start font-semibold">{tx("Due")}</th>
                      <th className="px-4 py-2.5 text-start font-semibold">{tx("Updated")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <Link href={`/requests/${r.id}`} className="font-semibold text-slate-900 hover:text-blue-700">{r.title}</Link>
                          <p className="text-[11px] text-slate-500">{r.reference_no} · {tx(TYPE_LABEL[r.request_type] ?? r.request_type)}{r.subject_label ? ` · ${r.subject_label}` : ""}</p>
                        </td>
                        <td className="px-4 py-3"><div className="flex flex-wrap gap-1"><ReviewBadge status={r.review_status} /><ExecutionBadge status={r.execution_status} /></div></td>
                        <td className="px-4 py-3"><PriorityText priority={r.priority} /></td>
                        {showRequester && <td className="px-4 py-3 text-xs text-slate-700">{r.requester_name}</td>}
                        {showAssignee && <td className="px-4 py-3 text-xs text-slate-700">{r.assignee_name ?? (r.queue_role ? tx("{role} queue", { role: r.queue_role }) : "—")}</td>}
                        <td className={`px-4 py-3 text-xs ${r.overdue ? "font-semibold text-red-700" : "text-slate-500"}`}>
                          {formatDate(r.due_at)}{r.overdue ? ` · ${tx("Overdue")}` : ""}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">{formatDate(r.updated_at, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pager page={page} pageSize={PAGE_SIZE} total={result.total} onPage={setPage} />
              </div>
            )}
    </Card>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, tone = "slate" }: { label: string; value: number | undefined; tone?: "slate" | "amber" | "red" | "blue" }) {
  const tones = { slate: "text-slate-900", amber: "text-amber-700", red: "text-red-700", blue: "text-blue-700" };
  return (
    <Card className="px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tones[tone]}`}>{value ?? "—"}</p>
    </Card>
  );
}
