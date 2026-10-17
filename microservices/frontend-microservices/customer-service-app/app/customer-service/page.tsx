"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { IS_DEMO } from "@/lib/envMode";
import { OPEN_DESK, api, type Category, type Me, type Priority, type Status, type Summary, type Ticket, type View } from "@/lib/api";
import { CATEGORY_LABEL, STATUS_LABEL } from "@/lib/labels";
import AppHeader from "@/components/satellite/AppHeader";
import { Card, Empty, ErrorNote, Pager, PRIORITY_LABEL, SkeletonRows, inputClass, primaryButton, secondaryButton, useDebounced } from "@/components/satellite/ui";
import NewTicketDialog from "@/components/NewTicketDialog";
import TicketPanel from "@/components/TicketPanel";
import SummaryCards from "@/components/SummaryCards";
import TicketTable, { type Sort, type SortKey } from "@/components/TicketTable";

// The service desk. A sidebar of queues, four counts, and the tickets as a table. A ticket opens in a workspace beside the
// table. Staff see the tenant's tickets and work them; everyone else sees the tickets they raised.

const PAGE_SIZE = 20;
const PRIORITY_RANK: Record<Priority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };
const ICON = {
  queue: "M4 6h16M4 12h16M4 18h10", clock: "M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", users: "M15 19a4 4 0 0 0-8 0m4-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0", pause: "M10 9v6m4-6v6m7-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", check: "M5 13l4 4L19 7", all: "M4 7h16M4 12h16M4 17h16",
};

function Desk() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("ticket");
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("active");
  const [status, setStatus] = useState<Status | "">("");
  const [priority, setPriority] = useState<Priority | "">("");
  const [category, setCategory] = useState<Category | "">("");
  const [sort, setSort] = useState<Sort>(null);
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const notify = (tone: "ok" | "err", text: string) => { setToast({ tone, text }); window.setTimeout(() => setToast(null), 4000); };
  const select = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("ticket", id); else next.delete("ticket");
    router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };

  useEffect(() => { api.get("/me").then((r) => setMe(r.data)).catch((e) => setError(e.message)); }, []);
  useEffect(() => { setPage(1); }, [view, status, q, priority, category, sort]);

  // Priority, category and sorting are not options of the service's list call, so while one is chosen the whole matching queue is
  // read (100 at a time) and narrowed here: the totals and pages then describe what is shown, not just one server page.
  const local = !!(priority || category || sort);
  const loadSummary = useCallback(() => { api.get("/tickets/summary").then((r) => setSummary(r.data)).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    try {
      const base = { status: status || undefined, view: view || undefined, q: q || undefined };
      if (!local) {
        const r = await api.get("/tickets", { params: { ...base, page, page_size: PAGE_SIZE } });
        setRows(r.data.items); setTotal(r.data.total);
      } else {
        const all: Ticket[] = [];
        for (let p = 1; p <= 20; p++) {
          const r = await api.get("/tickets", { params: { ...base, page: p, page_size: 100 } });
          all.push(...r.data.items);
          if (all.length >= r.data.total) break;
        }
        setRows(all); setTotal(all.length);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    loadSummary();
  }, [page, status, view, q, local, loadSummary]);
  useEffect(() => { setRows(null); load(); }, [load]);

  // Stay current without anyone pressing refresh: a new ticket or a colleague taking one shows up on its own.
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const shown = useMemo(() => {
    if (!rows) return null;
    if (!local) return rows;
    let list = rows.filter((t) => (!priority || t.priority === priority) && (!category || t.category === category));
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      const val = (t: Ticket) => sort.key === "priority" ? PRIORITY_RANK[t.priority] : sort.key === "sla" ? new Date(t.due_at).getTime() : sort.key === "status" ? t.status : t.created_at ?? t.id;
      list = [...list].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir);
    }
    return list;
  }, [rows, local, priority, category, sort]);
  const count = local ? shown?.length ?? 0 : total;
  const pageRows = shown ? (local ? shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : shown) : null;

  const onSort = (key: SortKey) => setSort((s) => (!s || s.key !== key ? { key, dir: key === "priority" ? "desc" : "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));

  const take = async (t: Ticket) => {
    if (!me) return;
    setBusyId(t.id);
    try {
      await api.post(`/tickets/${t.id}/assignment`, { version: t.version, user_id: me.id });
      notify("ok", tx("You took this ticket."));
      await load();
    } catch (e) {
      notify("err", (e as Error).message);
      await load();                                  // someone else may have taken it first: show the latest
    } finally { setBusyId(null); }
  };
  const seed = async () => {
    setSeeding(true);
    try { await api.post("/demo/seed"); await load(); } catch (e) { setError((e as Error).message); } finally { setSeeding(false); }
  };

  const staff = !!me?.staff;
  const queues: { value: View; label: string; count?: number; icon: string }[] = staff
    ? [
      { value: "active", label: tx("All open"), count: summary?.active, icon: ICON.queue }, { value: "overdue", label: tx("Overdue"), count: summary?.overdue, icon: ICON.clock },
      { value: "unassigned", label: tx("Unassigned"), count: summary?.unassigned, icon: ICON.users }, { value: "mine", label: tx("My tickets"), count: summary?.mine, icon: ICON.user },
      { value: "waiting", label: tx("Waiting on customer"), count: summary?.waiting, icon: ICON.pause }, { value: "finished", label: tx("Finished"), count: summary?.finished, icon: ICON.check },
      { value: "", label: tx("Everything"), count: summary?.total, icon: ICON.all },
    ]
    : [{ value: "active", label: tx("Open"), count: summary?.active, icon: ICON.queue }, { value: "finished", label: tx("Finished"), count: summary?.finished, icon: ICON.check }, { value: "", label: tx("Everything"), count: summary?.total, icon: ICON.all }];
  const filtered = view !== "active" || !!status || !!q || local;
  const reset = () => { setView("active"); setStatus(""); setSearch(""); setPriority(""); setCategory(""); setSort(null); };
  const queueButton = (o: (typeof queues)[number], compact = false) => {
    const on = view === o.value && !status;
    return (
      <button key={o.value || "all"} type="button" aria-current={on ? "page" : undefined} onClick={() => { setView(o.value); setStatus(""); }}
        className={`flex items-center gap-2.5 whitespace-nowrap rounded-lg text-[13px] font-medium transition-colors ${compact ? "px-3 py-1.5" : "w-full px-3 py-2"} ${on ? "bg-blue-50 font-semibold text-blue-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}>
        {!compact && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`h-[18px] w-[18px] shrink-0 ${on ? "text-blue-600" : "text-slate-400"}`} aria-hidden="true"><path d={o.icon} /></svg>}
        <span className="flex-1 truncate text-start">{o.label}</span>
        {o.count !== undefined && <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"}`}>{o.count}</span>}
      </button>
    );
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <AppHeader
        open={OPEN_DESK}
        title={tx("Service Desk")}
        home="/customer-service"
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>}
        actions={
          <>
            {IS_DEMO && me?.role_name === "Admin" && (
              <button type="button" onClick={seed} disabled={seeding} title={tx("Add sample tickets to this tenant")}
                className="hidden rounded-lg border border-dashed border-violet-300 bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 md:inline-flex">
                {seeding ? tx("Adding…") : tx("Load demo tickets")}
              </button>
            )}
            <button type="button" className={`${primaryButton} !px-3 !py-1.5 text-xs`} onClick={() => setCreating(true)}>+ {tx("New ticket")}</button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 flex-col gap-1 border-e border-slate-200 bg-white p-3 lg:flex" aria-label={tx("Queues")}>
          <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{staff ? tx("Queues") : tx("My requests")}</p>
          {queues.map((o) => queueButton(o))}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:p-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">{staff ? tx("Tickets") : tx("My tickets")}</h1>
            <p className="text-xs text-slate-500">{staff ? tx("Most urgent first. Open a ticket to work on it.") : tx("Open a ticket to see its progress and reply.")}</p>
          </div>
          {staff && <SummaryCards summary={summary} view={view} onPick={(v) => { setView(v); setStatus(""); }} />}
          <div className="flex gap-1 overflow-x-auto lg:hidden" role="tablist" aria-label={tx("Queues")}>{queues.map((o) => queueButton(o, true))}</div>

          <Card className="flex min-h-[24rem] flex-1 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
              <div className="relative min-w-[12rem] flex-1">
                <svg viewBox="0 0 20 20" fill="currentColor" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true">
                  <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
                </svg>
                <input className={`${inputClass} !py-1.5 ps-9 text-xs`} placeholder={tx("Search by subject or description…")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={tx("Search tickets")} />
              </div>
              <select className={`${inputClass} !w-auto !py-1.5 text-xs`} value={status} aria-label={tx("Filter by status")} onChange={(e) => { setStatus(e.target.value as Status | ""); if (e.target.value) setView(""); }}>
                <option value="">{tx("Any status")}</option>
                {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{tx(STATUS_LABEL[s])}</option>)}
              </select>
              <select className={`${inputClass} !w-auto !py-1.5 text-xs`} value={priority} aria-label={tx("Filter by priority")} onChange={(e) => setPriority(e.target.value as Priority | "")}>
                <option value="">{tx("Any priority")}</option>
                {(Object.keys(PRIORITY_LABEL) as Priority[]).reverse().map((p) => <option key={p} value={p}>{tx(PRIORITY_LABEL[p])}</option>)}
              </select>
              <select className={`${inputClass} !w-auto !py-1.5 text-xs`} value={category} aria-label={tx("Filter by category")} onChange={(e) => setCategory(e.target.value as Category | "")}>
                <option value="">{tx("Any category")}</option>
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <option key={c} value={c}>{tx(CATEGORY_LABEL[c])}</option>)}
              </select>
              {filtered && <button type="button" onClick={reset} className="text-xs font-semibold text-blue-600 hover:text-blue-800">{tx("Clear")}</button>}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {error ? <div className="p-4"><ErrorNote message={error} onRetry={load} /></div>
                : !pageRows || !me ? <SkeletonRows rows={7} />
                  : pageRows.length === 0 ? (
                    <Empty
                      title={filtered ? tx("No tickets match your filters.") : staff ? tx("Nothing needs doing right now.") : tx("You haven't raised any tickets yet.")}
                      hint={filtered ? undefined : staff ? tx("New customer requests appear here by themselves.") : tx("Press “New ticket” to ask the service team for something.")}
                      action={filtered ? <button type="button" className={`${secondaryButton} mt-2`} onClick={reset}>{tx("Show all open tickets")}</button>
                        : <button type="button" className={`${primaryButton} mt-2`} onClick={() => setCreating(true)}>+ {tx("New ticket")}</button>}
                    />
                  ) : <TicketTable rows={pageRows} me={me} selected={selected} sort={sort} onSort={onSort} onOpen={select} onTake={take} busyId={busyId} />}
            </div>
            {pageRows && pageRows.length > 0 && <Pager page={page} pageSize={PAGE_SIZE} total={count} onPage={setPage} />}
          </Card>
        </main>
      </div>

      {selected && me && (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={tx("Ticket")}>
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => select(null)} aria-hidden="true" />
          <div className="relative flex h-full w-full max-w-5xl flex-col bg-white shadow-2xl">
            <TicketPanel id={selected} me={me} onChanged={() => { load(); }} onClose={() => select(null)} notify={notify} />
          </div>
        </div>
      )}

      {toast && (
        <div role="status" className={`fixed bottom-5 start-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-lg ${toast.tone === "ok" ? "bg-slate-900" : "bg-red-600"}`}>{toast.text}</div>
      )}

      <NewTicketDialog open={creating} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); setView("active"); setStatus(""); load(); select(id); notify("ok", tx("Ticket created.")); }} />
    </div>
  );
}

export default function CustomerServicePage() {
  return <Suspense fallback={null}><Desk /></Suspense>;
}
