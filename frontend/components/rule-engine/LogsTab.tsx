"use client";

import { displayDateTime } from '../../lib/dateDisplay';
import { useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { RuleEvaluationLog, RuleSetSummary, listEvaluationLogs, listRuleSets } from "@/app/services/ruleEngine";
import { BOOLEAN_FIELDS, plainFieldLabel } from "./constants";
import { tx } from "@/lib/i18n/tx";

function plain(field: string, v: any): string {
  if (v === null || v === undefined || v === "") return "—";
  if (BOOLEAN_FIELDS.has(field) || typeof v === "boolean") return v === true || v === "true" ? tx("Yes") : tx("No");
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Every time the app (or a test) checked a rule set, newest first. */
export default function LogsTab({ tenantId }: { tenantId: string }) {
  const { notify } = useNotify();
  const [logs, setLogs] = useState<RuleEvaluationLog[]>([]);
  const [sets, setSets] = useState<Record<string, RuleSetSummary>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [l, s] = await Promise.all([listEvaluationLogs(tenantId, 100), listRuleSets(tenantId)]);
      setLogs(l);
      setSets(Object.fromEntries(s.map((r) => [r.rule_code, r])));
    } catch (err: any) {
      notify(err.message || tx("Failed to load activity."), false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = filter ? logs.filter((l) => l.rule_set_code === filter) : logs;
  const codes = Array.from(new Set(logs.map((l) => l.rule_set_code)));

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{tx("Activity")}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{tx("Each time a rule set was checked, what it was given and which rules matched.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100">
            <option value="">{tx("All rule sets")}</option>
            {codes.map((c) => <option key={c} value={c}>{sets[c]?.name ?? c}</option>)}
          </select>
          <button onClick={load} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">{tx("Refresh")}</button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-slate-100" />)}</div>
      ) : shown.length === 0 ? (
        <div className="p-12 text-center text-sm text-slate-500">{tx("Nothing has been checked yet.")}</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {shown.map((log) => {
            const name = sets[log.rule_set_code]?.name ?? log.rule_set_code;
            const n = log.matched_rule_codes.length;
            const isOpen = open === log.id;
            const facts = Object.entries(log.input_context_snapshot || {}).filter(([, v]) => v !== null && v !== "" && typeof v !== "object");
            return (
              <li key={log.id}>
                <button onClick={() => setOpen(isOpen ? null : log.id)} className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition hover:bg-slate-50/80">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold ${n ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}>{n}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">{name}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {n === 0 ? tx("No rule matched") : n === 1 ? tx("1 rule matched") : tx("{0} rules matched", { 0: n })}
                      {log.customer_cnic && <> · {tx("Customer")} {log.customer_cnic}</>}
                      {log.actor && <> · {log.actor}</>}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{displayDateTime(log.evaluated_at)}</span>
                  <svg className={`h-4 w-4 shrink-0 text-slate-300 transition ${isOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {isOpen && (
                  <div className="grid grid-cols-1 gap-4 bg-slate-50/60 px-5 py-4 md:grid-cols-2">
                    <div>
                      <p className="mb-2 text-xs font-medium text-slate-700">{tx("Details it was given")}</p>
                      {facts.length === 0 ? <p className="text-xs text-slate-400">—</p> : (
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                          {facts.map(([k, v]) => (
                            <div key={k} className="contents">
                              <dt className="truncate text-slate-500">{tx(plainFieldLabel(k))}</dt>
                              <dd className="truncate font-medium text-slate-800">{plain(k, v)}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-medium text-slate-700">{tx("Rules that matched")}</p>
                      {log.reasons.length === 0 ? <p className="text-xs text-slate-400">{tx("None")}</p> : (
                        <ul className="space-y-1 text-xs text-slate-600">
                          {log.reasons.map((r, i) => <li key={i}>• {r.replace(/^Rule '([^']+)' matched.*$/, "$1")}</li>)}
                        </ul>
                      )}
                      <p className="mt-3 text-[11px] text-slate-400">{tx("Version {0} · took {1} ms", { 0: log.version_number, 1: log.execution_duration_ms.toFixed(0) })}</p>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
