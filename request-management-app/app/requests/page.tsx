"use client";

import { useEffect, useState } from "react";
import { requestsApi, type Page, type RequestRow } from "@/lib/requestsApi";
import { tx } from "@/lib/i18n/tx";

export default function RequestsPage() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<RequestRow> | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setResult(null);
    setError("");
    requestsApi.list({ scope: "mine", page, page_size: 20 }).then((data) => {
      if (current) setResult(data);
    }).catch((err) => {
      if (current) setError(err instanceof Error ? err.message : "Couldn't load requests.");
    });
    return () => { current = false; };
  }, [page, refresh]);
  return <section className="space-y-5 p-6">
    <h1 className="text-2xl font-bold text-slate-900">{tx("My Requests")}</h1>
    <p className="text-sm text-slate-600">{tx("Track your requests, review decisions, and execution status.")}</p>
    {error ? <div role="alert" className="rounded-lg border border-red-200 p-4 text-red-700">
      <p>{error}</p><button onClick={() => setRefresh((n) => n + 1)} className="mt-3 font-semibold underline">{tx("Retry")}</button>
    </div> : !result ? <p role="status">{tx("Loading…")}</p> : result.items.length === 0 ? <p>{tx("No requests found.")}</p> : <>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-start text-sm">
          <thead className="bg-slate-100"><tr>{["Reference", "Title", "Review status", "Execution status", "Assignee"].map((h) => <th key={h} className="p-3 text-start">{tx(h)}</th>)}</tr></thead>
          <tbody>{result.items.map((r) => <tr key={r.id} className="border-t border-slate-100">
            <td className="p-3">{r.reference_no}</td><td className="p-3">{r.title}</td>
            <td className="p-3">{r.review_status.replaceAll("_", " ")}</td>
            <td className="p-3">{r.execution_status.replaceAll("_", " ")}</td>
            <td className="p-3">{r.assignee_name || r.queue_role || "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="flex items-center gap-4">
        <button disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="disabled:opacity-40">{tx("Previous")}</button>
        <span>{page} / {Math.max(1, Math.ceil(result.total / 20))}</span>
        <button disabled={page * 20 >= result.total} onClick={() => setPage((n) => n + 1)} className="disabled:opacity-40">{tx("Next")}</button>
      </div>
    </>}
  </section>;
}
