"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { IS_DEMO } from "@/lib/envMode";
import { api, type Me, type Status, type Summary, type Ticket, type View } from "@/lib/api";
import { CATEGORY_ICON, CATEGORY_LABEL, STATUS_LABEL, STATUS_TONE, nextHint } from "@/lib/labels";
import AppHeader from "@/components/satellite/AppHeader";
import {
  Badge, Card, DueLabel, Empty, ErrorNote, Pager, Priority, SkeletonRows, inputClass, primaryButton, relativeTime, secondaryButton, useDebounced,
} from "@/components/satellite/ui";
import NewTicketDialog from "@/components/NewTicketDialog";
import TicketPanel from "@/components/TicketPanel";
import SummaryCards from "@/components/SummaryCards";
import { GuideBanner, StatusLegend, useGuide } from "@/components/Guide";

// The service desk. Left: what needs attention, then the tickets. Right: the open ticket, with what to do next.
// Staff see the tenant's tickets and work them; everyone else sees the tickets they raised.

const PAGE_SIZE = 20;

function Desk() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("ticket");
  const guide = useGuide();
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("active");
  const [status, setStatus] = useState<Status | "">("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const select = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("ticket", id); else next.delete("ticket");
    router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };

  useEffect(() => { api.get("/me").then((r) => setMe(r.data)).catch((e) => setError(e.message)); }, []);
  useEffect(() => { setPage(1); }, [view, status, q]);

  const loadSummary = useCallback(() => { api.get("/tickets/summary").then((r) => setSummary(r.data)).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    try {
      const r = await api.get("/tickets", { params: { page, page_size: PAGE_SIZE, status: status || undefined, view: view || undefined, q: q || undefined } });
      setRows(r.data.items); setTotal(r.data.total); setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    loadSummary();
  }, [page, status, view, q, loadSummary]);
  useEffect(() => { setRows(null); load(); }, [load]);

  // Stay current without anyone pressing refresh: a new ticket or a colleague taking one shows up on its own.
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const seed = async () => {
    setSeeding(true);
    try { await api.post("/demo/seed"); await load(); } catch (e) { setError((e as Error).message); } finally { setSeeding(false); }
  };

  const staff = !!me?.staff;
  const views: { value: View; label: string; count?: number }[] = staff
    ? [
      { value: "active", label: tx("All open"), count: summary?.active }, { value: "overdue", label: tx("Late"), count: summary?.overdue },
      { value: "unassigned", label: tx("Not taken yet"), count: summary?.unassigned }, { value: "mine", label: tx("Mine"), count: summary?.mine },
      { value: "waiting", label: tx("Waiting on customer"), count: summary?.waiting }, { value: "finished", label: tx("Finished"), count: summary?.finished }, { value: "", label: tx("Everything"), count: summary?.total },
    ]
    : [{ value: "active", label: tx("Open"), count: summary?.active }, { value: "finished", label: tx("Finished"), count: summary?.finished }, { value: "", label: tx("Everything"), count: summary?.total }];
  const filtered = view !== "active" || !!status || !!q;
  const reset = () => { setView("active"); setStatus(""); setSearch(""); };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <AppHeader
        title={tx("Customer Service")}
        home="/customer-service"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        }
        actions={
          <>
            {IS_DEMO && me?.role_name === "Admin" && (
              <button type="button" onClick={seed} disabled={seeding} title={tx("Add sample tickets to this tenant")}
                className="hidden rounded-lg border border-dashed border-violet-300 bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 md:inline-flex">
                {seeding ? tx("Adding…") : tx("Load demo tickets")}
              </button>
            )}
            <button type="button" onClick={() => (guide.shown ? guide.hide() : guide.show())} aria-pressed={guide.shown}
              className={`${secondaryButton} !px-3 !py-1.5 text-xs`}>{tx("? How it works")}</button>
            <button type="button" className={`${primaryButton} !px-3 !py-1.5 text-xs`} onClick={() => setCreating(true)}>{tx("+ New ticket")}</button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 p-4 lg:p-6">
        <div className={`flex min-h-0 flex-col gap-3 ${selected ? "hidden w-full lg:flex lg:w-[46%]" : "w-full"}`}>
          {guide.shown && me && <GuideBanner staff={staff} onHide={guide.hide} />}
          {staff && <SummaryCards summary={summary} view={view} onPick={setView} />}

          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="space-y-3 border-b border-slate-100 px-4 py-3">
              <div>
                <h1 className="text-base font-bold text-slate-900">{staff ? tx("Tickets") : tx("My tickets")}</h1>
                <p className="text-[11px] text-slate-500">
                  {staff ? tx("Click a ticket to open it. The most urgent are at the top.") : tx("Click a ticket to see its progress and reply.")}
                </p>
              </div>
              <div role="tablist" aria-label={tx("Show")} className="flex gap-1 overflow-x-auto pb-0.5">
                {views.map((o) => (
                  <button key={o.value || "all"} type="button" role="tab" aria-selected={view === o.value && !status} onClick={() => { setView(o.value); setStatus(""); }}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${view === o.value && !status ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                    {o.label}
                    {o.count !== undefined && <span className={`rounded-full px-1.5 text-[10px] ${view === o.value && !status ? "bg-white/20" : "bg-slate-200 text-slate-700"}`}>{o.count}</span>}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="relative min-w-[12rem] flex-1">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true">
                    <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
                  </svg>
                  <input className={`${inputClass} !py-1.5 ps-9 text-xs`} placeholder={tx("Search by subject or description…")} value={search}
                    onChange={(e) => setSearch(e.target.value)} aria-label={tx("Search tickets")} />
                </div>
                <select className={`${inputClass} !w-auto !py-1.5 text-xs`} value={status} aria-label={tx("Filter by status")}
                  onChange={(e) => { setStatus(e.target.value as Status | ""); if (e.target.value) setView(""); }}>
                  <option value="">{tx("Any status")}</option>
                  {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{tx(STATUS_LABEL[s])}</option>)}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {error ? <div className="p-4"><ErrorNote message={error} onRetry={load} /></div>
                : !rows ? <SkeletonRows rows={6} />
                  : rows.length === 0 ? (
                    <Empty
                      title={filtered ? tx("No tickets match what you chose.") : staff ? tx("Nothing needs doing right now.") : tx("You haven't raised any tickets yet.")}
                      hint={filtered ? tx("Try “All open” or clear the search.") : staff ? tx("When a customer request comes in, it will appear here by itself.") : tx("Press “New ticket” to ask the service team for something.")}
                      action={filtered
                        ? <button type="button" className={`${secondaryButton} mt-2`} onClick={reset}>{tx("Show all open tickets")}</button>
                        : <button type="button" className={`${primaryButton} mt-2`} onClick={() => setCreating(true)}>{tx("+ New ticket")}</button>}
                    />
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {rows.map((t) => {
                        const active = t.id === selected;
                        const open = !["RESOLVED", "CLOSED", "CANCELLED"].includes(t.status);
                        const hint = nextHint(t, me);
                        return (
                          <li key={t.id}>
                            <button type="button" onClick={() => select(t.id)} aria-current={active ? "true" : undefined}
                              className={`w-full px-4 py-3 text-start transition-colors focus:outline-none ${active ? "bg-blue-50/70 shadow-[inset_3px_0_0_#2563eb]" : "hover:bg-slate-50"}`}>
                              <div className="flex items-start justify-between gap-3">
                                <span className="min-w-0">
                                  <span className="flex items-center gap-2">
                                    <span className="truncate text-sm font-semibold text-slate-900">{t.title}</span>
                                    {t.overdue && <span className="shrink-0 rounded bg-red-600 px-1.5 text-[10px] font-bold uppercase text-white">{tx("Late")}</span>}
                                  </span>
                                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                                    {CATEGORY_ICON[t.category]} {tx(CATEGORY_LABEL[t.category] ?? t.category)} · {tx("from")} {t.requester_name}
                                    {" · "}{t.assignee_name ? `${tx("handled by")} ${t.assignee_name}` : <span className={open ? "font-semibold text-amber-700" : ""}>{tx("not taken yet")}</span>}
                                  </span>
                                </span>
                                <Badge tone={STATUS_TONE[t.status]}>{tx(STATUS_LABEL[t.status])}</Badge>
                              </div>
                              {hint && <p className="mt-1.5 text-[11px] text-slate-600"><span className="font-semibold text-blue-700">{tx("Next")}:</span> {tx(hint)}</p>}
                              <div className="mt-1.5 flex items-center justify-between">
                                <Priority value={t.priority} />
                                {open ? <DueLabel due={t.due_at} open overdue={t.overdue} />
                                  : <span className="text-[11px] text-slate-400">{t.updated_at ? tx("Updated {when}", { when: relativeTime(t.updated_at) }) : ""}</span>}
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
            </div>
            {rows && rows.length > 0 && <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />}
          </Card>
        </div>

        {selected && me ? (
          <Card className="flex min-h-0 w-full flex-col overflow-hidden lg:flex-1">
            <TicketPanel id={selected} me={me} onChanged={load} onClose={() => select(null)} />
          </Card>
        ) : (
          <div className="hidden min-h-0 flex-1 overflow-y-auto rounded-xl border border-dashed border-slate-300 bg-white/60 p-6 lg:block">
            <div className="mx-auto max-w-md space-y-5 pt-4">
              <div className="text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-2xl" aria-hidden="true">👈</span>
                <h2 className="mt-3 text-base font-bold text-slate-900">{tx("Pick a ticket on the left")}</h2>
                <p className="mt-1 text-sm text-slate-500">{staff ? tx("Its details, what to do next, and the conversation open here.") : tx("You will see its progress and can reply here.")}</p>
              </div>
              {staff && (
                <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                  <p className="mb-1.5 font-bold text-slate-800">{tx("Where to start")}</p>
                  <ol className="list-decimal space-y-1 ps-4">
                    <li>{tx("Open anything marked")} <span className="rounded bg-red-600 px-1 text-[10px] font-bold uppercase text-white">{tx("Late")}</span>.</li>
                    <li>{tx("Then the tickets that are “not taken yet”: take one so a colleague doesn't duplicate your work.")}</li>
                    <li>{tx("Reply to the customer, and mark it solved when it is sorted.")}</li>
                  </ol>
                </div>
              )}
              <div>
                <p className="mb-2 text-xs font-bold text-slate-800">{tx("What the labels mean")}</p>
                <StatusLegend compact />
              </div>
              <div className="text-center"><button type="button" className={primaryButton} onClick={() => setCreating(true)}>{tx("+ New ticket")}</button></div>
            </div>
          </div>
        )}
      </div>

      <NewTicketDialog open={creating} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); setView("active"); setStatus(""); load(); select(id); }} />
    </div>
  );
}

export default function CustomerServicePage() {
  return <Suspense fallback={null}><Desk /></Suspense>;
}
