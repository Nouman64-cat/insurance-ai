"use client";

import { tx } from "@/lib/i18n/tx";
import { AuditEvent, EMPTY_FILTERS, changeRows, formatTime, showValue, titleCase } from "@/lib/audit";
import { actorLabel } from "./EventTable";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-1.5 text-xs">
      <dt className="text-slate-500">{tx(label)}</dt>
      <dd className="min-w-0 break-words text-slate-800">{children}</dd>
    </div>
  );
}

interface Props {
  event: AuditEvent;
  onNarrow: (patch: Partial<typeof EMPTY_FILTERS>) => void;
  tenantLabel: (tenantId: string | null) => string;
}

export default function EventDetails({ event, onNarrow, tenantLabel }: Props) {
  const rows = changeRows(event.previous_value, event.new_value);
  return <>
              <section aria-label={tx("Event")}>
                <dl className="divide-y divide-slate-100">
                  <Row label="Occurred">{formatTime(event.timestamp)}</Row>
                  <Row label="Recorded in ledger">{formatTime(event.recorded_at)}</Row>
                  <Row label="Actor">
                    {actorLabel(event)} <span className="text-slate-400">· {titleCase(event.actor_type)}{event.actor_role ? ` · ${event.actor_role}` : ""}</span>
                    {event.actor_id && <div className="font-mono text-[11px] text-slate-400">{event.actor_id}</div>}
                  </Row>
                  <Row label="Entity">
                    {titleCase(event.entity_type)}
                    {event.entity_id && (
                      <> <button type="button" className="font-mono text-[11px] text-slate-500 underline-offset-2 hover:underline" onClick={() => onNarrow({ entity_type: event.entity_type, entity_id: event.entity_id ?? "" })}>{event.entity_id}</button></>
                    )}
                  </Row>
                  {event.case_id && (
                    <Row label="Case"><button type="button" className="font-mono text-[11px] text-slate-500 underline-offset-2 hover:underline" onClick={() => onNarrow({ case_id: event.case_id ?? "" })}>{event.case_id}</button></Row>
                  )}
                  <Row label="Tenant">{event.tenant_id ? tenantLabel(event.tenant_id) : tx("Platform (system events)")}</Row>
                  <Row label="Source service">{event.service_name}</Row>
                  {event.correlation_id && (
                    <Row label="Request id">
                      <button type="button" className="font-mono text-[11px] text-slate-500 underline-offset-2 hover:underline" title={tx("Show everything from this request")} onClick={() => onNarrow({ correlation_id: event.correlation_id ?? "" })}>{event.correlation_id}</button>
                    </Row>
                  )}
                  <Row label="Event id"><span className="font-mono text-[11px]">{event.event_id}</span></Row>
                </dl>
              </section>

              {rows.length > 0 && (
                <section aria-label={tx("What changed")}>
                  <h3 className="mb-2 text-xs font-semibold text-slate-700">{tx("What changed")}</h3>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                        <tr>
                          <th scope="col" className="px-3 py-2 text-left font-medium">{tx("Field")}</th>
                          <th scope="col" className="px-3 py-2 text-left font-medium">{tx("Before")}</th>
                          <th scope="col" className="px-3 py-2 text-left font-medium">{tx("After")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rows.map((r) => (
                          <tr key={r.field} className={r.kind === "same" ? "text-slate-400" : ""}>
                            <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">{r.field}</td>
                            <td className={`max-w-[11rem] break-words px-3 py-1.5 ${r.kind === "removed" || r.kind === "changed" ? "text-rose-700" : ""}`}>{showValue(r.before)}</td>
                            <td className={`max-w-[11rem] break-words px-3 py-1.5 ${r.kind === "added" || r.kind === "changed" ? "text-emerald-700" : ""}`}>{showValue(r.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{tx("Credentials, tokens, personal identifiers and document contents are masked or withheld before they reach the audit trail.")}</p>
                </section>
              )}

              {Object.keys(event.metadata ?? {}).length > 0 && (
                <section aria-label={tx("Metadata")}>
                  <h3 className="mb-2 text-xs font-semibold text-slate-700">{tx("Metadata")}</h3>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-snug text-slate-700">{JSON.stringify(event.metadata, null, 2)}</pre>
                </section>
              )}

  </>;
}
