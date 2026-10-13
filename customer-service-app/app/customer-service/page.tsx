"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { IS_DEMO } from "@/lib/envMode";
import { api, type Me, type Status, type Ticket } from "@/lib/api";
import { CATEGORY_LABEL, STATUS_LABEL, STATUS_TONE } from "@/lib/labels";
import AppHeader from "@/components/satellite/AppHeader";
import {
  Badge, Card, DueLabel, Empty, ErrorNote, Pager, Priority, Segmented, SkeletonRows, inputClass, primaryButton, relativeTime, useDebounced,
} from "@/components/satellite/ui";
import NewTicketDialog from "@/components/NewTicketDialog";
import TicketPanel from "@/components/TicketPanel";

// The service desk: the ticket queue on the left, the open ticket on the right. Staff see the tenant's tickets and
// work them; everyone else sees the tickets they raised.

const PAGE_SIZE = 20;
type Tab = "" | Status;

function Desk() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("ticket");
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const select = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("ticket", id); else next.delete("ticket");
    router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };

  useEffect(() => { api.get("/me").then((r) => setMe(r.data)).catch((e) => setError(e.message)); }, []);
  useEffect(() => { setPage(1); }, [tab, q]);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/tickets", { params: { page, page_size: PAGE_SIZE, status: tab || undefined, q: q || undefined } });
      setRows(r.data.items); setTotal(r.data.total); setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, tab, q]);
  useEffect(() => { setRows(null); load(); }, [load]);

  const seed = async () => {
    setSeeding(true);
    try { await api.post("/demo/seed"); await load(); } catch (e) { setError((e as Error).message); } finally { setSeeding(false); }
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: "", label: tx("All") },
    ...(["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED", "CANCELLED"] as Status[]).map((s) => ({ value: s, label: tx(STATUS_LABEL[s]) })),
  ];

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
                className="hidden rounded-lg border border-dashed border-violet-300 bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 sm:inline-flex">
                {seeding ? tx("Adding…") : tx("Load demo tickets")}
              </button>
            )}
            <button type="button" className={`${primaryButton} !px-3 !py-1.5 text-xs`} onClick={() => setCreating(true)}>{tx("+ New ticket")}</button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 p-4 lg:p-6">
        <Card className={`flex min-h-0 flex-col overflow-hidden ${selected ? "hidden w-full lg:flex lg:w-[44%]" : "w-full"}`}>
          <div className="space-y-3 border-b border-slate-100 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h1 className="text-base font-bold text-slate-900">{me?.staff ? tx("Service queue") : tx("My tickets")}</h1>
                <p className="text-[11px] text-slate-500">
                  {me?.staff ? tx("Customer enquiries, policy servicing, billing questions and complaints for your tenant.") : tx("Tickets you raised for customers, and their progress.")}
                </p>
              </div>
            </div>
            <Segmented label={tx("Status")} value={tab} onChange={setTab} options={tabs} />
            <div className="relative">
              <svg viewBox="0 0 20 20" fill="currentColor" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true">
                <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
              </svg>
              <input className={`${inputClass} !py-1.5 ps-9 text-xs`} placeholder={tx("Search subject or description…")} value={search}
                onChange={(e) => setSearch(e.target.value)} aria-label={tx("Search tickets")} />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? <div className="p-4"><ErrorNote message={error} onRetry={load} /></div>
              : !rows ? <SkeletonRows rows={6} />
                : rows.length === 0 ? (
                  <Empty
                    title={q || tab ? tx("No tickets match.") : me?.staff ? tx("The queue is empty.") : tx("You haven't raised any tickets yet.")}
                    hint={q || tab ? tx("Try another status or search.") : tx("Log a customer's enquiry or complaint with “New ticket”.")}
                    action={!q && !tab ? <button type="button" className={`${primaryButton} mt-2`} onClick={() => setCreating(true)}>{tx("+ New ticket")}</button> : undefined}
                  />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {rows.map((t) => {
                      const active = t.id === selected;
                      const open = !["RESOLVED", "CLOSED", "CANCELLED"].includes(t.status);
                      return (
                        <li key={t.id}>
                          <button type="button" onClick={() => select(t.id)} aria-current={active ? "true" : undefined}
                            className={`w-full px-4 py-3 text-start transition-colors focus:outline-none ${active ? "bg-blue-50/70 shadow-[inset_3px_0_0_#2563eb]" : "hover:bg-slate-50"}`}>
                            <div className="flex items-start justify-between gap-3">
                              <span className="min-w-0">
                                <span className="flex items-center gap-2">
                                  <span className="truncate text-sm font-semibold text-slate-900">{t.title}</span>
                                  {t.overdue && <span className="shrink-0 rounded bg-red-600 px-1.5 text-[10px] font-bold uppercase text-white">{tx("Overdue")}</span>}
                                </span>
                                <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                                  {tx(CATEGORY_LABEL[t.category] ?? t.category)} · {t.requester_name}
                                  {t.assignee_name ? ` → ${t.assignee_name}` : ` · ${tx("Unassigned")}`}
                                </span>
                              </span>
                              <Badge tone={STATUS_TONE[t.status]}>{tx(STATUS_LABEL[t.status])}</Badge>
                            </div>
                            <div className="mt-2 flex items-center justify-between">
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

        {selected && me ? (
          <Card className="flex min-h-0 w-full flex-col overflow-hidden lg:flex-1">
            <TicketPanel id={selected} me={me} onChanged={load} onClose={() => select(null)} />
          </Card>
        ) : (
          <div className="hidden flex-1 items-center justify-center rounded-xl border border-dashed border-slate-300 lg:flex">
            <Empty title={tx("Select a ticket")} hint={tx("Its details, next step and conversation open here.")} />
          </div>
        )}
      </div>

      <NewTicketDialog open={creating} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); setTab(""); load(); select(id); }} />
    </div>
  );
}

export default function CustomerServicePage() {
  return <Suspense fallback={null}><Desk /></Suspense>;
}
