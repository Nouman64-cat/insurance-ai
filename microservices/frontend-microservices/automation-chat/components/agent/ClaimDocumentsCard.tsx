"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import api from "@/app/services/api";

// The claim's document checklist, managed in place: upload what is missing, view,
// replace or send back what was received, and ask the claimant for anything extra.
// Everything goes through the claims-management workflow API, which also files each
// upload as a claim artifact, so the checklist and the register's document gate agree.

export interface ClaimDocumentsRef {
  claim_id: string;
  claim_number?: string;
  policy_id: string;
}

type Item = {
  key: string;
  label: string;
  required: boolean;
  status: "Requested" | "Received" | "Waived" | "Rejected" | string;
  reason?: string | null;
  file_name?: string | null;
  received_at?: string | null;
  note?: string | null;
};

type Busy = { key: string; what: "upload" | "remove" | "waive" } | null;
// The inline reason box under a row: sending a received document back, or waiving a missing one.
type ReasonBox = { key: string; mode: "remove" | "waive" } | null;

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.tiff";

function errorText(err: any): string {
  const d = err?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x: any) => x?.msg || String(x)).join("; ");
  return err?.message || "Something went wrong.";
}

const Spinner = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
  <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

const STATUS_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  Received: { dot: "bg-emerald-500", text: "text-emerald-700", label: "Received" },
  Waived: { dot: "bg-slate-400", text: "text-slate-500", label: "Waived" },
  Rejected: { dot: "bg-rose-500", text: "text-rose-700", label: "Sent back" },
  Requested: { dot: "bg-amber-400", text: "text-amber-700", label: "Missing" },
};

const fmtPkr = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `PKR ${n.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "";
};

type NextAction = { label: string; prompt: string; tone?: "primary" | "danger" | "default"; direct?: "assess" };

/** The moves the workspace says are legal right now — the same rules the agent's own
 *  buttons follow (claim_workflow_tools._actions), phrased as the request the agent runs. */
function nextActions(ws: any, ref: string): NextAction[] {
  const can = ws?.can || {};
  const inv = ws?.investigation || {};
  const elig = ws?.eligibility || {};
  const dec = ws?.decision || {};
  const payable = ws?.assessment?.result?.payable;
  const approved = ws?.claim?.approved_amount;
  const out: NextAction[] = [];
  if (elig.status === "Ineligible" && !elig.override_by && can.verify) {
    out.push({ label: "Re-run eligibility", prompt: `Re-verify eligibility on claim ${ref}` });
    out.push({ label: "Override (manager)", prompt: `Override eligibility on claim ${ref}` });
  }
  // An open investigation is worked in the card itself (InvestigationPanel), not via chat.
  if (can.assess) {
    // A disability benefit needs the assessed %; everything else is calculated from the contract.
    const direct = ws?.process?.category !== "Disability";
    out.push({ label: "Assess the benefit", prompt: `Assess the benefit on claim ${ref}`, tone: "primary",
               direct: direct ? "assess" : undefined });
  }
  if (can.decide) {
    if (dec.requires_manager) out.push({ label: "Refer to manager", prompt: `Decide claim ${ref}: Refer to a claims manager` });
    out.push({ label: payable ? `Approve ${fmtPkr(payable)}` : "Approve", prompt: `Decide claim ${ref}: Approve`, tone: "primary" });
    out.push({ label: "Request information", prompt: `Decide claim ${ref}: RequestInfo` });
    out.push({ label: "Reject", prompt: `Decide claim ${ref}: Reject`, tone: "danger" });
  }
  if (can.verify_payees) out.push({ label: "Verify payees", prompt: `Verify the payees on claim ${ref}`, tone: "primary" });
  if (can.authorize) out.push({ label: `Authorise ${fmtPkr(approved)}`.trim(), prompt: `Authorise the disbursement on claim ${ref}`, tone: "primary" });
  if (can.disburse) out.push({ label: `Disburse ${fmtPkr(approved)}`.trim(), prompt: `Disburse the settlement on claim ${ref} by Bank Transfer`, tone: "primary" });
  if (can.reconcile) out.push({ label: "Reconcile payment", prompt: `Reconcile the settlement on claim ${ref}`, tone: "primary" });
  if (can.close) out.push({ label: "Close & send letter", prompt: `Close claim file ${ref} and send the letter`, tone: "primary" });
  return out;
}

const STAGE_DOT: Record<string, string> = {
  complete: "bg-emerald-500", skipped: "bg-slate-300", action: "bg-blue-500 ring-4 ring-blue-500/15",
  current: "bg-blue-500 ring-4 ring-blue-500/15", exception: "bg-rose-500", pending: "bg-amber-400", not_started: "bg-slate-200",
};

export function ClaimDocumentsCard({
  claim,
  onChanged,
  onRunPrompt,
}: {
  claim: ClaimDocumentsRef;
  /** Called after any change, with a one-line summary (e.g. to toast it). */
  onChanged?: (summary: string) => void;
  /** Runs a request through the agent (e.g. "Assess the benefit on claim CLM-…"). */
  onRunPrompt?: (text: string) => void;
}) {
  const tenantId = (typeof window !== "undefined" && localStorage.getItem("tenant_id")) || DEFAULT_TENANT_ID;
  const base = `/tenants/${tenantId}/policies/${claim.policy_id}/claims-management/${claim.claim_id}`;

  const [items, setItems] = useState<Item[] | null>(null);
  const [progress, setProgress] = useState<{ required: number; received: number } | null>(null);
  const [editable, setEditable] = useState(true);
  const [status, setStatus] = useState<string>("");
  const [ws, setWs] = useState<any>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [reasonBox, setReasonBox] = useState<ReasonBox>(null);
  const [reasonText, setReasonText] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [newDoc, setNewDoc] = useState({ label: "", reason: "", required: true });
  const [savingRequest, setSavingRequest] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadKey = useRef<string | null>(null);

  const apply = (ws: any) => {
    setWs(ws);
    setItems(ws?.documents?.items || []);
    setProgress(ws?.documents?.progress || null);
    setEditable(Boolean(ws?.can?.edit_documents));
    setStatus(ws?.claim?.status || "");
  };

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      apply((await api.get(base)).data);
    } catch (err: any) {
      setLoadError(err?.response?.status === 409
        ? "This claim isn't in the claims workflow yet — bring it in first to manage its documents."
        : errorText(err));
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const clearError = (key: string) => setRowError((e) => ({ ...e, [key]: "" }));

  const pick = (key: string) => {
    uploadKey.current = key;
    fileRef.current?.click();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const key = uploadKey.current;
    e.target.value = "";
    if (!file || !key) return;
    const item = items?.find((d) => d.key === key);
    setBusy({ key, what: "upload" });
    clearError(key);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api.post(`${base}/documents/${key}`, form, { headers: { "Content-Type": "multipart/form-data" } });
      apply(res.data);
      onChanged?.(`${item?.status === "Received" ? "Replaced" : "Uploaded"} ${item?.label ?? "document"} (${file.name}).`);
    } catch (err) {
      setRowError((x) => ({ ...x, [key]: errorText(err) }));
    } finally {
      setBusy(null);
    }
  };

  // The download endpoint streams a local file or redirects to a short-lived S3 link,
  // so open it directly — a fetch-as-blob would trip over the cross-origin redirect.
  const view = (item: Item) => {
    const root = String(api.defaults.baseURL || "").replace(/\/$/, "");
    window.open(`${root}${base}/documents/${item.key}/download`, "_blank", "noopener");
  };

  const openReason = (key: string, mode: "remove" | "waive") => {
    setReasonBox(reasonBox?.key === key && reasonBox.mode === mode ? null : { key, mode });
    setReasonText("");
    clearError(key);
  };

  // Remove = send a received document back to the claimant; Waive = a claims manager
  // excuses a required document that can't be produced. Both need a recorded reason.
  const submitReason = async (item: Item) => {
    if (!reasonBox) return;
    const reason = reasonText.trim();
    const waive = reasonBox.mode === "waive";
    if (!reason || (waive && reason.length < 10)) {
      setRowError((x) => ({ ...x, [item.key]: waive
        ? "Explain why it can't be produced (at least 10 characters) — it goes on the claim file."
        : "Say why it is being sent back — the claimant sees this." }));
      return;
    }
    setBusy({ key: item.key, what: reasonBox.mode });
    clearError(item.key);
    try {
      apply((await api.post(`${base}/documents/${item.key}/${waive ? "waive" : "reject"}`, { reason })).data);
      setReasonBox(null);
      setReasonText("");
      onChanged?.(`${waive ? "Waived" : "Sent back"} ${item.label}: ${reason}`);
    } catch (err: any) {
      setRowError((x) => ({ ...x, [item.key]: err?.response?.status === 403 && waive
        ? "Only a claims manager can waive a document."
        : errorText(err) }));
    } finally {
      setBusy(null);
    }
  };

  const request = async () => {
    if (!newDoc.label.trim()) return;
    setSavingRequest(true);
    try {
      apply((await api.post(`${base}/documents`, {
        label: newDoc.label.trim(), required: newDoc.required, reason: newDoc.reason.trim() || null,
      })).data);
      onChanged?.(`Requested ${newDoc.label.trim()}.`);
      setNewDoc({ label: "", reason: "", required: true });
      setRequesting(false);
    } catch (err) {
      setRowError((x) => ({ ...x, __request: errorText(err) }));
    } finally {
      setSavingRequest(false);
    }
  };

  const pct = progress && progress.required ? Math.round((progress.received / progress.required) * 100) : 0;
  const ref = claim.claim_number || "this claim";

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onFile} />

      {/* Header */}
      <div className="border-b border-slate-100 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-blue-600">Claim documents</p>
            <p className="truncate text-sm font-semibold text-slate-800">
              {ref}
              {status && <span className="ml-2 font-normal text-slate-500">· {status}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            Refresh
          </button>
        </div>
        {progress && progress.required > 0 && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[11px] text-slate-500">
              <span>{progress.received} of {progress.required} required documents</span>
              <span className={pct === 100 ? "font-semibold text-emerald-600" : ""}>{pct === 100 ? "Complete" : `${pct}%`}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full transition-all duration-500 ${pct === 100 ? "bg-emerald-500" : "bg-blue-500"}`}
                   style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {!editable && items && (
          <p className="mt-2 text-xs text-slate-500">The checklist is locked — the claim has been decided or isn't eligible yet.</p>
        )}
      </div>

      {/* Next step — what the claim needs now, and the moves that are legal */}
      {ws && !loadError && (() => {
        const stages: any[] = ws.stages || [];
        const current = stages.find((st) => !["complete", "skipped"].includes(st.state));
        const actions = nextActions(ws, ref);
        const investigating = Boolean(ws.can?.investigate && ws.investigation?.requires_investigation && !ws.investigation?.completed_at);
        const flags: any[] = investigating ? [] : (ws.investigation?.flags || []).filter((f: any) => f.severity === "high");
        const assessed = ws.assessment?.result;
        const run = async (a: NextAction) => {
          if (a.direct !== "assess") { onRunPrompt?.(a.prompt); return; }
          setRunning(a.label); setNextError(null);
          try {
            const next = (await api.post(`${base}/assessment`, {})).data;
            apply(next);
            const pay = next?.assessment?.result?.payable;
            onChanged?.(`Benefit assessed: ${fmtPkr(pay) || "PKR 0"} payable.`);
          } catch (err) { setNextError(errorText(err)); } finally { setRunning(null); }
        };
        const sla = ws.sla || {};
        return (
          <div className="border-b border-slate-100 bg-gradient-to-b from-blue-50/60 to-white px-4 py-3">
            {stages.length > 0 && (
              <div className="mb-3 flex items-center gap-1.5" aria-label="Claim progress">
                {stages.map((st) => (
                  <div key={st.key} className="flex flex-1 items-center gap-1.5" title={`${st.title}: ${st.label}`}>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${STAGE_DOT[st.state] || STAGE_DOT.not_started}`} />
                    <span className={`h-0.5 flex-1 rounded ${st.state === "complete" || st.state === "skipped" ? "bg-emerald-300" : "bg-slate-200"}`} />
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-slate-500">
              {current ? `Next · step ${current.n} of ${stages.length}` : "All steps complete"}
            </p>
            {current && (
              <p className="mt-0.5 text-sm font-semibold text-slate-800">
                {current.title} — {current.label}
                {current.detail && <span className="font-normal text-slate-500"> · {current.detail}</span>}
              </p>
            )}
            {flags.length > 0 && !ws.investigation?.completed_at && (
              <ul className="mt-2 space-y-1">
                {flags.slice(0, 3).map((f) => (
                  <li key={f.code} className="flex gap-1.5 text-xs text-rose-700">
                    <span aria-hidden>⚠</span><span>{f.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {sla.state && sla.state !== "not_started" && sla.message && (
              <p className={`mt-2 text-xs ${sla.state === "breached" ? "text-rose-700" : sla.state === "at_risk" ? "text-amber-700" : "text-slate-500"}`}>
                {sla.message}
              </p>
            )}
            {assessed && (
              <div className="mt-2 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-600">
                {(assessed.components || []).map((c: any) => (
                  <div key={c.label} className="flex justify-between gap-3"><span>{c.label}</span><span className="tabular-nums">{fmtPkr(c.amount)}</span></div>
                ))}
                {(assessed.deductions || []).map((c: any) => (
                  <div key={c.label} className="flex justify-between gap-3 text-rose-600"><span>less {c.label}</span><span className="tabular-nums">−{fmtPkr(c.amount)}</span></div>
                ))}
                <div className="mt-1 flex justify-between gap-3 border-t border-slate-100 pt-1 font-semibold text-slate-800">
                  <span>Payable{assessed.capped_by ? ` (capped by ${assessed.capped_by})` : ""}</span>
                  <span className="tabular-nums">{fmtPkr(assessed.payable) || "PKR 0"}</span>
                </div>
              </div>
            )}
            {investigating && (
              <InvestigationPanel ws={ws} base={base} apply={apply} onChanged={onChanged} />
            )}
            {nextError && <p className="mt-2 text-xs text-rose-600">{nextError}</p>}
            {actions.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {actions.map((a) => (
                  <button key={a.label} type="button" disabled={(!onRunPrompt && !a.direct) || !!busy || running !== null}
                          onClick={() => run(a)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                            a.tone === "primary" ? "bg-blue-600 text-white shadow-sm hover:bg-blue-700"
                              : a.tone === "danger" ? "border border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
                                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                    <span className="inline-flex items-center gap-1.5">{running === a.label && <Spinner />}{a.label}</span>
                  </button>
                ))}
              </div>
            ) : current?.key === "documents" ? (
              <p className="mt-1 text-xs text-slate-500">Collect the outstanding documents below — the decision clock starts once the file is complete.</p>
            ) : null}
          </div>
        );
      })()}

      {/* Body */}
      {loadError ? (
        <p className="px-4 py-5 text-sm text-slate-600">{loadError}</p>
      ) : !items ? (
        <div className="flex items-center gap-2 px-4 py-5 text-sm text-slate-500"><Spinner /> Loading checklist…</div>
      ) : items.length === 0 ? (
        <p className="px-4 py-5 text-sm text-slate-600">No checklist yet — it is built once eligibility has been checked.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((d) => {
            // Sending a document back returns the item to "Requested" with a "Returned: …" note.
            const returned = d.status === "Requested" && (d.note || "").startsWith("Returned");
            const st = returned ? STATUS_STYLE.Rejected : STATUS_STYLE[d.status] || STATUS_STYLE.Requested;
            const rowBusy = busy?.key === d.key ? busy.what : null;
            const received = d.status === "Received";
            const waived = d.status === "Waived";
            return (
              <li key={d.key} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">
                      {d.label}
                      {!d.required && <span className="ml-1.5 text-[11px] font-normal text-slate-400">optional</span>}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      <span className={`font-semibold ${st.text}`}>{st.label}</span>
                      {received && d.file_name && <> · {d.file_name}</>}
                      {returned && <> · {d.note!.replace(/^Returned:\s*/, "")}</>}
                      {waived && d.note && <> · {d.note}</>}
                      {!returned && d.status === "Requested" && d.reason && <> · {d.reason}</>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {rowBusy === "upload" ? (
                      <span className="flex items-center gap-1.5 rounded-lg bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-700">
                        <Spinner /> Uploading…
                      </span>
                    ) : received ? (
                      <>
                        <button type="button" onClick={() => view(d)} disabled={!!busy}
                                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                          View
                        </button>
                        {editable && (
                          <>
                            <button type="button" onClick={() => pick(d.key)} disabled={!!busy}
                                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                              Replace
                            </button>
                            <button type="button" disabled={!!busy} onClick={() => openReason(d.key, "remove")}
                                    className="rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                              Remove
                            </button>
                          </>
                        )}
                      </>
                    ) : waived ? (
                      editable && (
                        <button type="button" onClick={() => pick(d.key)} disabled={!!busy}
                                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                          Upload anyway
                        </button>
                      )
                    ) : editable ? (
                      <>
                        {d.required && (
                          <button type="button" onClick={() => openReason(d.key, "waive")} disabled={!!busy}
                                  title="Claims manager: excuse a document that can't be produced"
                                  className="rounded-lg border border-amber-200 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50">
                            Waive
                          </button>
                        )}
                        <button type="button" onClick={() => pick(d.key)} disabled={!!busy}
                                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                          </svg>
                          Upload
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>

                {reasonBox?.key === d.key && (
                  <div className="mt-2 flex items-center gap-2 pl-5">
                    <input
                      autoFocus
                      value={reasonText}
                      onChange={(e) => setReasonText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") submitReason(d); if (e.key === "Escape") setReasonBox(null); }}
                      placeholder={reasonBox.mode === "waive"
                        ? "Why can't it be produced? (e.g. no FIR — natural death at home)"
                        : "Why is it being sent back? (e.g. illegible, wrong person)"}
                      className={`min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 ${
                        reasonBox.mode === "waive" ? "focus:border-amber-300 focus:ring-amber-500/10" : "focus:border-rose-300 focus:ring-rose-500/10"}`}
                    />
                    <button type="button" onClick={() => submitReason(d)} disabled={rowBusy === "remove" || rowBusy === "waive"}
                            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${
                              reasonBox.mode === "waive" ? "bg-amber-600 hover:bg-amber-700" : "bg-rose-600 hover:bg-rose-700"}`}>
                      {(rowBusy === "remove" || rowBusy === "waive") && <Spinner />}
                      {reasonBox.mode === "waive" ? "Waive" : "Send back"}
                    </button>
                    <button type="button" onClick={() => setReasonBox(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                  </div>
                )}
                {rowError[d.key] && <p className="mt-1.5 pl-5 text-xs text-rose-600">{rowError[d.key]}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {/* Footer: request an extra document */}
      {items && editable && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
          {requesting ? (
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                value={newDoc.label}
                onChange={(e) => setNewDoc({ ...newDoc, label: e.target.value })}
                placeholder="Document to request, e.g. Burial certificate"
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
              />
              <input
                value={newDoc.reason}
                onChange={(e) => setNewDoc({ ...newDoc, reason: e.target.value })}
                placeholder="Why it's needed (optional)"
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={newDoc.required}
                         onChange={(e) => setNewDoc({ ...newDoc, required: e.target.checked })} />
                  The decision waits for it
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setRequesting(false)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                  <button type="button" onClick={request} disabled={!newDoc.label.trim() || savingRequest}
                          className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
                    {savingRequest && <Spinner />} Add to checklist
                  </button>
                </div>
              </div>
              {rowError.__request && <p className="text-xs text-rose-600">{rowError.__request}</p>}
            </div>
          ) : (
            <button type="button" onClick={() => setRequesting(true)}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-700">
              + Request another document
            </button>
          )}
        </div>
      )}
    </div>
  );
}


// ── Investigation (step 4) ───────────────────────────────────────────────────

// What evidence settles each red flag, in the officer's terms.
const FLAG_HINTS: Record<string, string> = {
  contestable: "Compare the proposal's health answers with the medical history — hospital records, treating doctor, other insurers.",
  early_claim: "Confirm the cause and circumstances of death — death certificate, treating doctor's statement, hospital records.",
  pre_existing: "Get prior treatment records: did the cause of death exist before cover began? That decides the pre-existing exclusion.",
  plan_limit: "Ask underwriting to confirm the contractual sum assured — the policy was issued above the plan's maximum.",
  duplicate: "Check the other claim for the same event and confirm this is not a repeat.",
  fraud_score: "Verify the claimant's identity and the event independently (NADRA, field visit).",
  exclusion: "Establish the cause of death — an exclusion may apply.",
  nominee_mismatch: "Confirm the claimant's entitlement — succession certificate or nominee records.",
  late_report: "Record why the claim was reported late.",
  waiting_period: "Confirm when the illness started relative to cover.",
};
const SOURCES = ["Hospital records", "Treating physician", "NADRA Verisys", "Field visit", "Prior insurer / industry check",
                 "Proposal file", "Underwriting", "Other"];
const KIND_STYLE: Record<string, string> = {
  Verified: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Adverse: "bg-rose-50 text-rose-700 border-rose-200",
  Neutral: "bg-slate-50 text-slate-600 border-slate-200",
};

function Segmented<T extends string>({ value, options, onChange, tones }: {
  value: T; options: T[]; onChange: (v: T) => void; tones?: Record<string, string>;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onChange(o)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                  value === o ? (tones?.[o] || "bg-slate-900 text-white") : "text-slate-500 hover:text-slate-800"}`}>
          {o}
        </button>
      ))}
    </div>
  );
}

export function InvestigationPanel({ ws, base, apply, onChanged }: {
  ws: any; base: string; apply: (ws: any) => void; onChanged?: (summary: string) => void;
}) {
  const inv = ws?.investigation || {};
  const flags: any[] = (inv.flags || []).filter((f: any) => f.severity !== "info");
  const findings: any[] = inv.findings || [];
  const [kind, setKind] = useState<"Verified" | "Adverse" | "Neutral">("Verified");
  const [source, setSource] = useState(SOURCES[0]);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<"Verified" | "Adverse" | "Inconclusive">("Verified");
  const [closing, setClosing] = useState("");
  const [saving, setSaving] = useState<"finding" | "complete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const forFlag = (f: any) => {
    setNote(`${f.message.split(" — ")[0].replace(/\.$/, "")}: `);
    setTimeout(() => noteRef.current?.focus(), 0);
  };

  const record = async () => {
    if (!note.trim()) { setError("Write what was found."); return; }
    setSaving("finding"); setError(null);
    try {
      apply((await api.post(`${base}/investigation/finding`, { kind, source, note: note.trim() })).data);
      onChanged?.(`Finding recorded (${kind}, ${source}).`);
      setNote("");
    } catch (err) { setError(errorText(err)); } finally { setSaving(null); }
  };

  const complete = async () => {
    if (outcome !== "Verified" && !closing.trim()) { setError("Explain an adverse or inconclusive outcome."); return; }
    setSaving("complete"); setError(null);
    try {
      apply((await api.post(`${base}/investigation/complete`, { outcome, notes: closing.trim() || null })).data);
      onChanged?.(`Investigation completed: ${outcome}.`);
    } catch (err) { setError(errorText(err)); } finally { setSaving(null); }
  };

  return (
    <div className="mt-3 space-y-3">
      {flags.length > 0 && (
        <div className="rounded-xl border border-rose-100 bg-white">
          <p className="border-b border-rose-100 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-rose-600">
            Red flags to resolve
          </p>
          <ul className="divide-y divide-slate-100">
            {flags.map((f) => (
              <li key={f.code} className="flex items-start gap-3 px-3 py-2.5">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${f.severity === "high" ? "bg-rose-500" : "bg-amber-400"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-slate-800">{f.message}</p>
                  {FLAG_HINTS[f.code] && <p className="mt-0.5 text-xs text-slate-500">{FLAG_HINTS[f.code]}</p>}
                </div>
                <button type="button" onClick={() => forFlag(f)}
                        className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                  Record finding
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* New finding */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-700">Finding</span>
          <Segmented value={kind} options={["Verified", "Adverse", "Neutral"]} onChange={setKind}
                     tones={{ Verified: "bg-emerald-600 text-white", Adverse: "bg-rose-600 text-white", Neutral: "bg-slate-700 text-white" }} />
          <select value={source} onChange={(e) => setSource(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/10">
            {SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <textarea ref={noteRef} value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder="What was found — e.g. Hospital records show no treatment before cover began; cause of death: cardiac arrest."
                  className="mt-2 w-full resize-y rounded-lg border border-slate-200 px-2.5 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/10" />
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={record} disabled={saving !== null || !note.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">
            {saving === "finding" && <Spinner />} Record finding
          </button>
        </div>
      </div>

      {/* Findings so far */}
      {findings.length > 0 && (
        <ul className="space-y-1.5">
          {findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
              <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${KIND_STYLE[f.kind] || KIND_STYLE.Neutral}`}>{f.kind}</span>
              <div className="min-w-0 flex-1 text-xs">
                <p className="text-slate-800">{f.note}</p>
                <p className="mt-0.5 text-slate-400">{[f.source, f.by, String(f.at || "").slice(0, 16).replace("T", " ")].filter(Boolean).join(" · ")}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Close the investigation */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-700">Outcome</span>
          <Segmented value={outcome} options={["Verified", "Adverse", "Inconclusive"]} onChange={setOutcome}
                     tones={{ Verified: "bg-emerald-600 text-white", Adverse: "bg-rose-600 text-white", Inconclusive: "bg-amber-500 text-white" }} />
        </div>
        <input value={closing} onChange={(e) => setClosing(e.target.value)}
               placeholder={outcome === "Verified" ? "Closing note (optional)" : "Why — required for an adverse or inconclusive outcome"}
               className="mt-2 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/10" />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">
            {findings.length ? `${findings.length} finding(s) recorded.` : "Record at least one finding first."}
          </p>
          <button type="button" onClick={complete} disabled={saving !== null || findings.length === 0}
                  className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40">
            {saving === "complete" && <Spinner />} Complete investigation
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}
