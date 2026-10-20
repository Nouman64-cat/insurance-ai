"use client";

import { tx } from "@/lib/i18n/tx";
import { AuditEvent, Outcome, formatTime, titleCase } from "@/lib/audit";

const OUTCOME: Record<Outcome, { dot: string; text: string; label: string }> = {
  SUCCESS: { dot: "bg-emerald-500", text: "text-slate-700", label: "Success" },
  FAILURE: { dot: "bg-rose-500", text: "text-rose-700", label: "Failure" },
  DENIED: { dot: "bg-amber-500", text: "text-amber-700", label: "Denied" },
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const o = OUTCOME[outcome] ?? OUTCOME.SUCCESS;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${o.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${o.dot}`} aria-hidden="true" />
      {tx(o.label)}
    </span>
  );
}

export function ModuleBadge({ module }: { module: string }) {
  return <span className="inline-block rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600">{titleCase(module)}</span>;
}

export function actorLabel(e: Pick<AuditEvent, "actor_name" | "actor_id" | "actor_type">): string {
  if (e.actor_name) return e.actor_name;
  if (e.actor_id) return `${e.actor_id.slice(0, 8)}…`;
  return e.actor_type === "SYSTEM" ? tx("System") : tx("Unknown");
}

interface Props {
  events: AuditEvent[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  showTenant: boolean;
  tenantLabel: (tenantId: string | null) => string;
}

export default function EventTable({ events, loading, selectedId, onSelect, showTenant, tenantLabel }: Props) {
  return (
    <div className="overflow-x-auto" aria-busy={loading}>
      <table className="min-w-full text-left text-sm">
        <caption className="sr-only">{tx("Audit events, newest first")}</caption>
        <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="whitespace-nowrap px-4 py-2.5 font-medium">{tx("Time")}</th>
            <th scope="col" className="px-3 py-2.5 font-medium">{tx("Module")}</th>
            <th scope="col" className="px-3 py-2.5 font-medium">{tx("Action")}</th>
            <th scope="col" className="px-3 py-2.5 font-medium">{tx("Entity")}</th>
            <th scope="col" className="px-3 py-2.5 font-medium">{tx("Actor")}</th>
            {showTenant && <th scope="col" className="px-3 py-2.5 font-medium">{tx("Tenant")}</th>}
            <th scope="col" className="px-3 py-2.5 font-medium">{tx("Outcome")}</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">{tx("Seq")}</th>
          </tr>
        </thead>
        <tbody className={`divide-y divide-slate-100 transition-opacity ${loading ? "opacity-50" : ""}`}>
          {events.map((e) => {
            const selected = e.event_id === selectedId;
            return (
              <tr
                key={e.event_id}
                tabIndex={0}
                aria-selected={selected}
                onClick={() => onSelect(e.event_id)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect(e.event_id); } }}
                className={`cursor-pointer outline-none transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 ${selected ? "bg-slate-50" : ""}`}
              >
                <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-600 tabular-nums" title={e.timestamp}>{formatTime(e.timestamp)}</td>
                <td className="px-3 py-2.5"><ModuleBadge module={e.module} /></td>
                <td className="px-3 py-2.5">
                  <span className="font-mono text-xs text-slate-800">{e.action}</span>
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-600">
                  <span className="text-slate-700">{titleCase(e.entity_type)}</span>
                  {e.entity_id && <span className="ms-1 font-mono text-[11px] text-slate-400" title={e.entity_id}>{e.entity_id.slice(0, 8)}</span>}
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-700">
                  {actorLabel(e)}
                  {e.actor_role && <span className="ms-1 text-slate-400">· {e.actor_role}</span>}
                </td>
                {showTenant && <td className="px-3 py-2.5 text-xs text-slate-500">{e.tenant_id ? tenantLabel(e.tenant_id) : tx("Platform")}</td>}
                <td className="px-3 py-2.5"><OutcomeBadge outcome={e.outcome} /></td>
                <td className="px-4 py-2.5 text-right text-xs tabular-nums text-slate-500">{e.sequence_number.toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
