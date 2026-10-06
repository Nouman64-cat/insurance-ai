"use client";

import { useCallback, useEffect, useState } from "react";
import api from "@/app/services/api";
import { Chip, GroupQuote, PanelProps, downloadPdf, errMsg, mpBase, pkr, premiumWord } from "./groupShared";

// Where a scheme is in its life, left to right. "Declined" sits beside "Quoted":
// the employer said no and a revised quote can still be generated.
const STAGES: { status: string; label: string }[] = [
  { status: "Pending", label: "Scheme created" },
  { status: "Proposed", label: "Census enrolled" },
  { status: "Quoted", label: "Quoted" },
  { status: "Accepted", label: "Accepted" },
  { status: "PendingPayment", label: "Issued" },
  { status: "Active", label: "Cover in force" },
];

export default function SchemePanel({ tenantId, orgId, mp, reload }: PanelProps) {
  const base = mpBase(tenantId, orgId, mp.id);
  const word = premiumWord(mp.business_type);
  const [accepted, setAccepted] = useState<GroupQuote | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [ptf, setPtf] = useState<any>(null);

  const loadQuote = useCallback(async () => {
    try {
      const res = await api.get<GroupQuote[]>(`${base}/quotes`);
      setAccepted(res.data.find((q) => q.status === "Accepted") ?? null);
    } catch { setAccepted(null); }
  }, [base]);

  useEffect(() => { loadQuote(); }, [loadQuote, mp.status]);
  useEffect(() => {
    if (mp.business_type !== "Takaful" || !mp.policy_number) { setPtf(null); return; }
    api.get(`${base}/ptf-report`).then((r) => setPtf(r.data)).catch(() => setPtf(null));
  }, [base, mp.business_type, mp.policy_number, mp.status]);
  useEffect(() => { if (accepted) setAmount(String(accepted.total_premium)); }, [accepted]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); } catch (e: any) { setError(errMsg(e, `Could not ${label.toLowerCase()}.`)); } finally { setBusy(""); }
  };

  const issue = () => run("Issue", async () => {
    if (!confirm("Issue the master policy and one certificate per member? Cover starts once the employer's payment is recorded.")) return;
    const res = await api.post(`${base}/issue`);
    setNotice(`Master policy ${res.data.master_policy.policy_number} issued with ${res.data.certificates_issued} certificates.`);
    await reload();
  });

  const pay = () => run("Record payment", async () => {
    const res = await api.post(`${base}/payments`, { reference: reference.trim(), amount: parseFloat(amount) });
    setNotice(`Payment recorded — ${res.data.certificates_issued} members are now covered.`);
    setReference("");
    await reload();
  });

  const stageIndex = STAGES.findIndex((s) => s.status === (mp.status === "Declined" ? "Quoted" : mp.status));
  const rows: [string, React.ReactNode][] = [
    ["Product", `${mp.plan_label ?? "Group Life"}${mp.business_type ? ` · ${mp.business_type}` : ""}`],
    ["Master policy no.", mp.policy_number ?? "Assigned at issuance"],
    ["Cover period", mp.expiry_date ? `${mp.effective_date} to ${mp.expiry_date}` : `From ${mp.effective_date} · ${mp.term_years}-year term`],
    ["Default cover", `${mp.sum_assured_multiple}× basic monthly salary`],
    ["Free Cover Limit", mp.free_cover_limit != null ? pkr(mp.free_cover_limit) : "Set when the census is confirmed"],
    ["Status", <Chip key="s" status={mp.status}>{mp.status}</Chip>],
  ];

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`rounded-xl border p-3 text-sm font-medium ${error ? "bg-red-50 border-red-200 text-red-700" : "bg-blue-50 border-blue-200 text-blue-700"}`}>
          {error || notice}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <ol className="flex flex-wrap items-center gap-y-2">
          {STAGES.map((s, i) => {
            const done = stageIndex > i || (mp.status === "Active" && i === STAGES.length - 1);
            const current = stageIndex === i && mp.status !== "Active";
            return (
              <li key={s.status} className="flex items-center">
                <span className={`flex items-center gap-2 text-xs font-semibold ${done ? "text-emerald-700" : current ? "text-blue-700" : "text-slate-400"}`}>
                  <span className={`w-5 h-5 rounded-full border flex items-center justify-center text-[10px] ${done ? "bg-emerald-50 border-emerald-300" : current ? "bg-blue-50 border-blue-300" : "border-slate-200"}`}>
                    {done ? "✓" : i + 1}
                  </span>
                  {s.label}
                </span>
                {i < STAGES.length - 1 && <span className="mx-3 h-px w-6 bg-slate-200" />}
              </li>
            );
          })}
        </ol>
        {mp.status === "Declined" && (
          <p className="mt-3 text-xs text-red-600 font-medium">The employer declined the last quote — generate a revised one from the Quote tab.</p>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <dl className="divide-y divide-slate-100">
          {rows.map(([k, v]) => (
            <div key={k} className="px-5 py-3 flex items-center justify-between gap-4 text-sm">
              <dt className="text-slate-500">{k}</dt>
              <dd className="font-semibold text-slate-800 text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {mp.status === "Accepted" && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-slate-800">Ready to issue</p>
            <p className="text-xs text-slate-500">Assigns the master policy number and one numbered certificate per member.</p>
          </div>
          <button onClick={issue} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg">
            {busy === "Issue" ? "Issuing…" : "Issue master policy"}
          </button>
        </div>
      )}

      {mp.status === "PendingPayment" && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">Awaiting the employer&apos;s {word}</p>
            <p className="text-xs text-slate-500">Cover starts for every member once the full amount is recorded.{accepted ? ` Amount due ${pkr(accepted.total_premium)}.` : ""}</p>
          </div>
          <div className="flex items-end gap-3 flex-wrap">
            <label className="text-xs font-semibold text-slate-600 space-y-1">
              <span className="block">Bank / transfer reference *</span>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="IBFT-123456"
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-56 bg-slate-50" />
            </label>
            <label className="text-xs font-semibold text-slate-600 space-y-1">
              <span className="block">Amount (PKR)</span>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-40 bg-slate-50" />
            </label>
            <button onClick={pay} disabled={!!busy || !reference.trim() || !(parseFloat(amount) > 0)}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">
              {busy === "Record payment" ? "Recording…" : "Record payment"}
            </button>
          </div>
        </div>
      )}

      {ptf && ptf.periods?.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <p className="px-5 py-3 border-b border-slate-100 bg-slate-50 text-sm font-semibold text-slate-700">Participants&apos; Takaful Fund</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-2 text-left">Period</th>
                <th className="px-3 py-2 text-right">Wakala fee</th>
                <th className="px-3 py-2 text-right">Fund</th>
                <th className="px-3 py-2 text-right">Retakaful</th>
                <th className="px-3 py-2 text-right">Claims</th>
                <th className="px-5 py-2 text-right">Surplus / deficit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {ptf.periods.map((p: any) => (
                <tr key={p.label}>
                  <td className="px-5 py-2 text-slate-700">{p.label}</td>
                  <td className="px-3 py-2 text-right">{pkr(p.wakala_fee)}</td>
                  <td className="px-3 py-2 text-right">{pkr(p.ptf_gross)}</td>
                  <td className="px-3 py-2 text-right">{pkr(p.retakaful_contribution)}</td>
                  <td className="px-3 py-2 text-right">{pkr(p.claims_incurred)}</td>
                  <td className={`px-5 py-2 text-right font-semibold ${p.result >= 0 ? "text-emerald-700" : "text-red-700"}`}>{p.result >= 0 ? "" : "−"}{pkr(Math.abs(p.result))} <span className="font-normal text-slate-400">{p.position}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {ptf.note && <p className="px-5 py-2 text-[11px] text-slate-400 border-t border-slate-100">{ptf.note}</p>}
        </div>
      )}

      {mp.policy_number && (
        <div className="flex justify-end">
          <button onClick={() => run("Download", () => downloadPdf(`${base}/schedule/document`, `schedule-${mp.policy_number}.pdf`))}
            className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50">
            Download policy schedule (PDF)
          </button>
        </div>
      )}
    </div>
  );
}
