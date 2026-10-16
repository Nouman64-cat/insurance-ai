"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { fmtCoverage } from "@/lib/mock-data";
import { getMedicalExam, assessMedicalExam, recordMedicalResult, waiveMedicalExam, type MedicalExamOrder } from "@/app/services/medicalExam";
import { getInsuranceHistory, runInsuranceHistory, clearInsuranceHistory, failInsuranceHistory, type InsuranceHistory } from "@/app/services/insuranceHistory";
import { MedicalResultModal } from "@/components/case/MedicalReviewDialogs";
import { getArtifactUrl } from "@/app/services/artifacts";
import { requirementState, statusLabel, STATE_TONE } from "./requirementStatus";
import { notify } from "./toast";

type Props = {
  track: "medical" | "financial"; caseId: string; disabled: boolean; onChanged: () => void;
  /** Changes whenever the application's documents do (an upload, or OCR accepting one): the panel re-reads then. */
  documentsVersion?: string;
};
const button = "rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed";
const field = "w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm";
export default function TrackOperations({ track, ...props }: Props) {
  return track === "medical" ? <MedicalOperations {...props} /> : <FinancialOperations {...props} />;
}
type OperationProps = Omit<Props, "track">;
function MedicalOperations({ caseId, disabled, onChanged, documentsVersion }: OperationProps) {
  const [order, setOrder] = useState<MedicalExamOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"result" | null>(null);
  const [reason, setReason] = useState("");
  const autoAssessed = useRef(false);
  const reload = async () => { try { const o = await getMedicalExam(caseId); setOrder(o); return o; } catch (e: any) { setError(e?.response?.data?.detail ?? tx("Could not load the medical examination.")); return null; } };
  // The medical requirements come from the plan's non-medical limit grid: work them out as soon as the
  // underwriter opens the review, instead of asking for a button press.
  useEffect(() => {
    void (async () => {
      const o = await reload();
      if (o && o.status === "NotAssessed" && !disabled && !autoAssessed.current) {
        autoAssessed.current = true; setAssessing(true);
        try { setOrder(await assessMedicalExam(caseId)); onChanged(); }
        catch (e: any) { setError(e?.response?.data?.detail ?? tx("Could not work out the medical requirements.")); }
        finally { setAssessing(false); }
      }
    })();
  }, [caseId, disabled]);
  // Reports are uploaded on the Documents tab and accepted by OCR a few seconds later: follow along.
  const firstVersion = useRef(documentsVersion);
  useEffect(() => { if (documentsVersion !== firstVersion.current) void reload(); }, [documentsVersion]);
  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true); setError("");
    try { await run(); await reload(); notify("success", tx(done)); onChanged(); }
    catch (e: any) { const detail = typeof e?.response?.data?.detail === "string" ? e.response.data.detail : e.message; setError(detail); notify("error", tx("Action failed"), detail); }
    finally { setBusy(false); }
  };
  const tests = order?.required_tests ?? [];
  const reports = order?.reports ?? [];
  const reportsFor = (code: string) => reports.filter((r) => r.test_code === code);
  const accepted = tests.filter((t) => reportsFor(t.code).some((r) => r.status === "Accepted"));
  const reading = tests.filter((t) => !accepted.includes(t) && reportsFor(t.code).some((r) => r.status === "Uploaded" || r.status === "Processing"));
  const ready = tests.length > 0 && accepted.length === tests.length;
  const rated = Boolean(order?.outcome);
  const noExam = order?.status === "NotRequired" || order?.status === "Waived";
  return <section id="medical-underwriting" className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold text-slate-900">{tx("Medical requirements")}</h2><p className="mt-0.5 text-xs text-slate-500">{tx("Set by the non-medical limit grid for this applicant's age and sum assured.")}</p></div><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${STATE_TONE[requirementState(order?.status ?? "")].pill}`}>{tx(assessing ? "Assessing…" : order ? statusLabel(order.status) : "Loading…")}</span></div>
    {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {order?.id ? <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{[["Sum assured at risk", fmtCoverage(order.sum_assured_at_risk)], ["Non-medical limit", order.non_medical_limit != null ? fmtCoverage(order.non_medical_limit) : "—"], ["Required tests", noExam ? tx("None") : `${tests.length}`], ["Reports in", noExam ? "—" : `${accepted.length} / ${tests.length}`]].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"><p className="text-xs text-slate-500">{tx(label)}</p><p className="mt-1 truncate text-sm font-semibold text-slate-900">{value}</p></div>)}</div> : null}
    {order?.trigger_reasons?.length ? <ul className="mt-4 list-disc ps-5 text-sm text-amber-800">{order.trigger_reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
    {tests.length ? <div className="mt-5 overflow-x-auto rounded-xl border border-slate-100"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{["Required test", "Report", "Finding", "Loading"].map((t) => <th className="px-3 py-2 font-medium" key={t}>{tx(t)}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{tests.map((test) => { const files = reportsFor(test.code); const ok = accepted.includes(test); const inRead = reading.includes(test); return <tr key={test.code}>
      <td className="px-3 py-3 font-medium text-slate-900">{test.name}<span className="block text-xs font-normal text-slate-400">{test.category}{test.fasting ? " · " + tx("Fasting required") : ""}</span></td>
      <td className="px-3 py-3">{files.length ? files.map((r) => <button key={r.id} className="block text-left text-xs text-blue-600" onClick={() => { const tab = window.open("about:blank", "_blank"); if (tab) tab.opener = null; void getArtifactUrl(r.id).then((url) => { if (tab) tab.location.href = url; }).catch(() => { tab?.close(); setError(tx("Could not open the report.")); }); }}>{r.file_name} ↗</button>) : null}
        <span className={`mt-0.5 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-50 text-emerald-700" : inRead ? "bg-blue-50 text-blue-700" : files.length ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800"}`}>{tx(ok ? "Accepted" : inRead ? "Reading…" : files.length ? "Couldn't be read" : "Awaiting report")}</span></td>
      <td className="px-3 py-3">{(order?.abnormal_findings ?? []).filter((f) => f.test === test.code).map((f) => <p key={f.label} className="text-xs text-amber-800">{f.finding}</p>)}</td>
      <td className="px-3 py-3 tabular-nums">{(order?.abnormal_findings ?? []).filter((f) => f.test === test.code).map((f) => `${f.loading_pct}%`).join(", ") || "—"}</td>
    </tr>; })}</tbody></table></div>
      : <p className="mt-4 rounded-xl border border-dashed border-slate-200 px-5 py-5 text-sm text-slate-500">{tx(assessing || !order ? "Working out the medical requirements…" : order.status === "NotRequired" ? "Sum assured is within the non-medical limit — no examination is needed." : order.status === "Waived" ? "The medical examination was waived." : disabled ? "Medical requirements are worked out when you start this review." : "No tests are required.")}</p>}
    {order?.outcome && (() => {
      const tone = order.outcome === "Normal" ? { chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", bar: "bg-emerald-500", text: "text-emerald-700" }
        : order.outcome === "MinorFindings" ? { chip: "bg-amber-50 text-amber-800 ring-amber-200", bar: "bg-amber-500", text: "text-amber-700" }
        : { chip: "bg-rose-50 text-rose-700 ring-rose-200", bar: "bg-rose-500", text: "text-rose-700" };
      const loading = order.suggested_loading_pct ?? 0;
      return <section aria-label={tx("Medical underwriting result")} className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-stretch divide-y divide-slate-100 sm:divide-x sm:divide-y-0">
          <div className="flex min-w-48 flex-1 flex-col justify-center gap-2 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{tx("Clinical outcome")}</p>
            <span className={`inline-flex w-fit items-center rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-inset ${tone.chip}`}>{tx(order.outcome.replace(/([a-z])([A-Z])/g, "$1 $2"))}</span>
          </div>
          <div className="flex min-w-64 flex-[2] flex-col justify-center p-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{tx("Suggested premium loading")}</p>
            <div className="mt-1 flex items-end gap-3">
              <span className={`text-4xl font-bold leading-none tabular-nums ${loading > 0 ? tone.text : "text-slate-900"}`}>{loading > 0 ? `+${loading}%` : tx("None")}</span>
              <span className="pb-0.5 text-xs text-slate-500">{tx(loading > 0 ? "added to the base premium at policy issuance" : "no extra premium is needed")}</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true"><div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.min(100, loading)}%` }} /></div>
          </div>
        </div>
        {order.abnormal_findings?.length > 0 && <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-3"><p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{tx("Why")}</p><ul className="space-y-1.5">{order.abnormal_findings.map((f, n) => <li key={n} className="flex items-start justify-between gap-3 text-sm text-slate-700"><span>{f.label}{f.finding ? ` — ${f.finding}` : ""} <span className="text-slate-400">({f.value}{f.unit ? ` ${f.unit}` : ""})</span></span>{f.loading_pct ? <span className="shrink-0 font-semibold text-slate-900">+{f.loading_pct}%</span> : null}</li>)}</ul></div>}
      </section>;
    })()}
    {tests.length > 0 && !noExam && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="min-w-0"><p className="text-sm font-semibold text-slate-900">{tx(ready ? (rated ? "Results recorded" : "All reports are in") : "Waiting for reports")}</p>
        <p className="mt-0.5 text-xs text-slate-500">{ready ? tx(rated ? "Run again to re-read the reports and re-rate." : "Required next step: run AI medical underwriting, review the extracted results, then Save & rate to complete this requirement.")
          : `${accepted.length} ${tx("of")} ${tests.length} ${tx("reports accepted")}${reading.length ? ` · ${reading.length} ${tx("being read")}` : ""}. ${tx("Upload the rest from the Documents tab.")}`}</p></div>
      <button disabled={disabled || busy || !ready} onClick={() => setModal("result")} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>
        {tx(rated ? "Re-run AI medical underwriting" : "Run AI medical underwriting")}</button>
    </div>}
    {order?.id && !noExam && <details className="mt-5 border-t pt-4"><summary className="cursor-pointer text-sm font-semibold text-slate-600">{tx("Medical exception / waiver")}</summary><p className="mt-2 text-xs text-slate-500">{tx("Record an explicit clinical justification. This is not a final application approval.")}</p><textarea className={`${field} mt-2`} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder={tx("Waiver rationale")} /><button disabled={disabled || busy || !reason.trim()} className={`${button} mt-2`} onClick={() => void act(() => waiveMedicalExam(caseId, reason), "Medical exception recorded.")}>{tx("Record medical waiver")}</button></details>}
    {modal === "result" && order && <MedicalResultModal caseId={caseId} order={order} busy={busy} onClose={() => setModal(null)} onSubmit={(results) => void act(async () => { await recordMedicalResult(caseId, { results }); setModal(null); }, "AI medical underwriting complete — results recorded and rated.")} />}
  </section>;
}

function FinancialOperations({ caseId, disabled, onChanged }: OperationProps) {
  const [history, setHistory] = useState<InsuranceHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const reload = async () => { try { setHistory(await getInsuranceHistory(caseId)); } catch (e: any) { setError(e?.response?.data?.detail ?? e.message); } };
  useEffect(() => { void reload(); }, [caseId]);
  const act = async (action: () => Promise<unknown>, done: string, detail?: string) => {
    setBusy(true); setError("");
    try { await action(); await reload(); notify("success", tx(done), detail && tx(detail)); onChanged(); }
    catch (e: any) { const message = e?.response?.data?.detail ?? e.message; setError(message); notify("error", tx("Action failed"), message); }
    finally { setBusy(false); }
  };
  const [revising, setRevising] = useState(false);
  const checked = history?.checked_at != null;
  const ratio = history?.hlv_ratio;
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold text-slate-900">{tx("Financial exposure & insurance history")}</h2><p className="mt-0.5 text-xs text-slate-500">{checked ? `${tx("Checked")} ${new Date(history!.checked_at!).toLocaleString()}` : tx("Aggregate cover, human life value, existing policies and referral findings.")}</p></div>{checked && <div className="flex items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${history!.status === "Clear" ? "bg-emerald-50 text-emerald-700" : history!.status === "Failed" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800"}`}>{tx(history!.status === "Clear" ? "Cleared" : history!.status)}</span><button className={button} disabled={disabled || busy} onClick={() => void act(() => runInsuranceHistory(caseId), "Financial exposure check complete")}>{tx(busy ? "Running…" : "Re-run check")}</button></div>}</div>
    {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {checked ? <><div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{[["Proposed cover", fmtCoverage(history!.proposed_sum_assured), ""], ["Aggregate exposure", fmtCoverage(history!.aggregate_sum_assured), ""], ["Human life value limit", history!.hlv_limit != null ? fmtCoverage(history!.hlv_limit) : "—", ""], ["Exposure / HLV", ratio != null ? `${ratio.toFixed(2)}×` : "—", ratio == null ? "" : ratio > 1 ? "text-rose-600" : ratio > 0.8 ? "text-amber-600" : "text-emerald-600"]].map(([label, value, tone]) => <div key={label} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"><p className="text-xs text-slate-500">{tx(label)}</p><p className={`mt-1 text-lg font-semibold tabular-nums ${tone || "text-slate-900"}`}>{value}</p></div>)}</div><ul className="mt-3 space-y-2">{history!.findings.map((f) => <li className={`rounded-xl p-3 text-sm ${f.severity === "critical" ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-900"}`} key={f.code}>{f.message}</li>)}</ul>{history!.internal_policies.length + history!.external_policies.length > 0 ? <div className="mt-4 overflow-x-auto rounded-xl border border-slate-100"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{["Insurer", "Policy", "Cover", "Status", "Source"].map((label) => <th className="px-3 py-2" key={label}>{tx(label)}</th>)}</tr></thead><tbody className="divide-y">{[...history!.internal_policies, ...history!.external_policies].map((p, i) => <tr key={p.policy_id ?? `${p.insurer}-${i}`}><td className="px-3 py-3">{p.insurer}</td><td className="px-3 py-3">{p.policy_number ?? p.product ?? "—"}</td><td className="px-3 py-3">{fmtCoverage(p.sum_assured)}</td><td className="px-3 py-3">{p.status}</td><td className="px-3 py-3">{p.source === "internal" ? tx("Internal") : tx("Declared external")}</td></tr>)}</tbody></table></div> : <p className="mt-4 text-sm text-slate-500">{tx("No existing or declared policies found.")}</p>}
    {history!.clearance_note && !revising ? <div className={`mt-5 flex flex-wrap items-start gap-3 rounded-xl border p-4 ${history!.status === "Failed" ? "border-rose-200 bg-rose-50/60" : "border-emerald-200 bg-emerald-50/60"}`}><span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-white ${history!.status === "Failed" ? "bg-rose-500" : "bg-emerald-500"}`}><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={history!.status === "Failed" ? "M7 7l10 10M17 7 7 17" : "m5 12 4 4L19 6"} /></svg></span><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-slate-900">{tx(history!.status === "Failed" ? "Adverse financial history recorded" : "Financial history cleared")}</p><p className="mt-0.5 text-xs text-slate-500">{[history!.cleared_by, history!.cleared_at && new Date(history!.cleared_at).toLocaleString()].filter(Boolean).join(" · ")}</p><p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{history!.clearance_note}</p></div>{!disabled && <button className={button} onClick={() => { setNote(history!.clearance_note ?? ""); setRevising(true); }}>{tx("Revise")}</button>}</div>
    : <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/50 p-4"><p className="text-sm font-semibold text-slate-900">{tx("Financial history decision")}</p><p className="mt-1 text-xs text-slate-500">{tx("Explain your evidence before clearing a financial flag or recording an adverse finding.")}</p><textarea className={`${field} mt-2`} rows={3} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder={tx("Financial justification")} /><div className="mt-3 flex gap-2"><button disabled={disabled || busy || !note.trim()} className={button} onClick={() => void act(async () => { await clearInsuranceHistory(caseId, note); setNote(""); setRevising(false); }, "Financial history cleared", "Insurance history clearance is now complete.")}>{tx("Clear financial history")}</button><button disabled={disabled || busy || !note.trim()} className={button} onClick={() => void act(async () => { await failInsuranceHistory(caseId, note); setNote(""); setRevising(false); }, "Adverse financial history recorded")}>{tx("Record adverse history")}</button></div>{revising && <button className="ms-auto text-xs font-semibold text-slate-500" onClick={() => setRevising(false)}>{tx("Cancel")}</button>}</div>}</> : <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed border-slate-200 px-5 py-5"><p className="max-w-md text-sm text-slate-500">{tx("Run the check to compare total cover against human life value and pull existing policies. No result does not mean no exposure.")}</p><button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40" disabled={disabled || busy} onClick={() => void act(() => runInsuranceHistory(caseId), "Financial exposure check complete")}>{tx(busy ? "Running…" : "Run exposure check")}</button></div>}
  </section>;
}
