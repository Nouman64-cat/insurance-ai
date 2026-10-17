"use client";

import { tx } from "@/lib/i18n/tx";
import type { Me, Ticket } from "@/lib/api";
import { CATEGORY_ICON, CATEGORY_LABEL, SLA_LABEL, SLA_TONE, STATUS_LABEL, STATUS_TONE, isOpenStatus, shortId, slaState } from "@/lib/labels";
import { Avatar, Badge, DueLabel, Priority } from "@/components/satellite/ui";

export type SortKey = "id" | "priority" | "status" | "sla";
export type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

const COLS: { key: SortKey | null; label: string; staffOnly?: boolean; className?: string }[] = [
  { key: "id", label: "Ticket" }, { key: null, label: "Customer" }, { key: null, label: "Category" }, { key: "priority", label: "Priority" },
  { key: "status", label: "Status" }, { key: null, label: "Assigned to", staffOnly: true }, { key: "sla", label: "SLA" }, { key: null, label: "Actions", className: "text-end" },
];

/** The ticket queue as a compact table. Status, assignment and SLA are three separate columns, so each reads on its own. */
export default function TicketTable({ rows, me, selected, sort, onSort, onOpen, onTake, busyId }: {
  rows: Ticket[]; me: Me; selected: string | null; sort: Sort; onSort: (k: SortKey) => void; onOpen: (id: string) => void; onTake: (t: Ticket) => void; busyId: string | null;
}) {
  const cols = COLS.filter((c) => !c.staffOnly || me.staff);
  return (
    <table className="w-full min-w-[56rem] text-sm">
      <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <tr>
          {cols.map((c) => {
            const on = c.key && sort?.key === c.key;
            return (
              <th key={c.label} scope="col" className={`px-4 py-2.5 text-start font-semibold ${c.className ?? ""}`} aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                {c.key ? (
                  <button type="button" onClick={() => onSort(c.key!)} className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-900 ${on ? "text-blue-700" : ""}`}>
                    {tx(c.label)}<span aria-hidden="true" className="text-[10px]">{on ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                ) : tx(c.label)}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((t) => {
          const open = isOpenStatus(t.status);
          const sla = slaState(t);
          const canTake = me.staff && me.can_work !== false && open && !t.assignee_name;
          return (
            <tr key={t.id} onClick={() => onOpen(t.id)} aria-selected={t.id === selected}
              className={`cursor-pointer transition-colors hover:bg-blue-50/40 ${t.id === selected ? "bg-blue-50/70" : ""}`}>
              <td className="max-w-[18rem] px-4 py-3">
                <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} className="block max-w-full text-start focus:outline-none focus-visible:underline">
                  <span className="block font-mono text-[11px] font-semibold text-blue-700">{shortId(t.id)}</span>
                  <span className="block truncate text-sm font-semibold text-slate-900">{t.title}</span>
                </button>
              </td>
              <td className="px-4 py-3 text-slate-700">{t.requester_name}</td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-600"><span aria-hidden="true">{CATEGORY_ICON[t.category]}</span> {tx(CATEGORY_LABEL[t.category] ?? t.category)}</td>
              <td className="px-4 py-3"><Priority value={t.priority} /></td>
              <td className="px-4 py-3"><Badge tone={STATUS_TONE[t.status]}>{tx(STATUS_LABEL[t.status])}</Badge></td>
              {me.staff && (
                <td className="px-4 py-3">
                  {t.assignee_name
                    ? <span className="flex items-center gap-2 text-xs text-slate-700"><span className="scale-75 -mx-1"><Avatar name={t.assignee_name} /></span><span className="truncate">{t.assignee_name}</span></span>
                    : <span className={`text-xs ${open ? "font-semibold text-amber-700" : "text-slate-400"}`}>{tx("Unassigned")}</span>}
                </td>
              )}
              <td className="whitespace-nowrap px-4 py-3">
                <span className="flex flex-col items-start gap-0.5">
                  {open ? <DueLabel due={t.due_at} open overdue={t.overdue} /> : <span className="text-xs text-slate-400">—</span>}
                  <Badge tone={SLA_TONE[sla]} dot={false}>{tx(SLA_LABEL[sla])}</Badge>
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-end" onClick={(e) => e.stopPropagation()}>
                {canTake && (
                  <button type="button" disabled={busyId === t.id} onClick={() => onTake(t)}
                    className="me-2 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">{busyId === t.id ? tx("Taking…") : tx("Take")}</button>
                )}
                <button type="button" onClick={() => onOpen(t.id)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">{tx("Open")}</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
