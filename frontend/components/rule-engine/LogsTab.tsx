"use client";

import { displayDateTime } from '../../lib/dateDisplay';
import { Fragment, useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { RuleEvaluationLog, listEvaluationLogs } from "@/app/services/ruleEngine";
import { tx } from "@/lib/i18n/tx";

export default function LogsTab({ tenantId }: { tenantId: string }) {
  const { notify } = useNotify();
  const [logs, setLogs] = useState<RuleEvaluationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [tenantId]);

  const load = async () => {
    setLoading(true);
    try {
      setLogs(await listEvaluationLogs(tenantId, 100));
    } catch (err: any) {
      notify(err.message || tx("Failed to load audit logs."), false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{tx("Rule Evaluation Audit Trail")}</h2>
        <button onClick={load} className="text-xs font-semibold text-blue-600 hover:underline">{tx("Refresh")}</button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-400 text-sm animate-pulse font-medium">{tx("Loading logs...")}</div>
      ) : logs.length === 0 ? (
        <div className="p-8 text-center text-slate-500 text-sm font-medium">{tx("No evaluations logged yet.")}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-100">
              <tr>
                <th className="px-4 py-3">{tx("Evaluated At")}</th>
                <th className="px-4 py-3">{tx("Rule Set")}</th>
                <th className="px-4 py-3">{tx("Customer CNIC")}</th>
                <th className="px-4 py-3 text-right">{tx("TSAR Accumulated")}</th>
                <th className="px-4 py-3">{tx("Matched Rules")}</th>
                <th className="px-4 py-3 text-right">{tx("Duration (ms)")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <Fragment key={log.id}>
                  <tr
                    onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                    className="hover:bg-slate-50/80 cursor-pointer transition"
                  >
                    <td className="px-4 py-3 text-slate-500">{displayDateTime(log.evaluated_at)}</td>
                    <td className="px-4 py-3 font-mono text-slate-700">{log.rule_set_code}</td>
                    <td className="px-4 py-3 text-slate-600">{log.customer_cnic || "—"}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-800">
                      {log.tsar_accumulated ? log.tsar_accumulated.toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {log.matched_rule_codes.length === 0 ? (
                        <span className="italic text-slate-400">{tx("None")}</span>
                      ) : (
                        <span className="font-mono text-[10px] text-slate-600">{log.matched_rule_codes.join(", ")}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500">{log.execution_duration_ms.toFixed(1)}</td>
                  </tr>
                  {expanded === log.id && (
                    <tr>
                      <td colSpan={6} className="px-4 py-3 bg-slate-50 whitespace-normal">
                        <div className="grid grid-cols-2 gap-4 text-[11px]">
                          <div>
                            <p className="font-bold text-slate-600 uppercase mb-1">{tx("Input Context")}</p>
                            <pre className="bg-white border border-slate-200 rounded-lg p-2.5 overflow-x-auto">{JSON.stringify(log.input_context_snapshot, null, 2)}</pre>
                          </div>
                          <div>
                            <p className="font-bold text-slate-600 uppercase mb-1">{tx("Final Impacts")}</p>
                            <pre className="bg-white border border-slate-200 rounded-lg p-2.5 overflow-x-auto">{JSON.stringify(log.final_impacts, null, 2)}</pre>
                          </div>
                        </div>
                        {log.reasons.length > 0 && (
                          <div className="mt-2">
                            <p className="font-bold text-slate-600 uppercase mb-1 text-[11px]">{tx("Reasons")}</p>
                            <ul className="list-disc list-inside text-slate-600 text-[11px]">
                              {log.reasons.map((r, i) => <li key={i}>{r}</li>)}
                            </ul>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
