"use client";

import { useState } from "react";
import { displayDate, displayDateTime } from "../../lib/dateDisplay";
import {
  markPolicyPaymentReceived, proofUrl, remindPolicyPayment, requestPolicyPayment, reviewPolicyProof, withdrawPolicyPayment, type IPP,
} from "@/app/services/initialPremiumPayment";
import { tx } from "@/lib/i18n/tx";
import { ReceiptCard } from "./ReceiptCard";
import { BreakdownTable } from "./BreakdownTable";

// The initial premium of an application under review, from the staff side. The customer is asked to pay (a secure link, by email and in
// their walk-in portal), reminded if they do not, and the payment is cleared when they send a receipt / say they have paid and staff
// confirm it, or when staff record it as received themselves. Underwriting opens only once it has cleared.

const METHODS = ["Cash", "Bank transfer", "Cheque", "JazzCash", "Easypaisa", "Card", "Other"];
const BTN = "px-3 py-1.5 text-[11px] font-semibold rounded-md disabled:opacity-50 transition-colors";
const pkr = (n: number | null | undefined) => (n == null ? "—" : `PKR ${Math.round(n).toLocaleString()}`);
const msg = (err: any, fallback: string) => {
  const d = err?.response?.data?.detail;
  return typeof d === "string" ? d : err?.message ?? fallback;
};

export function PaymentPanel({ policyId, ipp, canAct, onChange, onCleared }: {
  policyId: string; ipp: IPP | null; canAct: boolean; onChange: (ipp: IPP) => void; onCleared: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [form, setForm] = useState({ method: "Cash", reference: "", note: "" });
  if (ipp?.status === "Realized") return <ReceiptCard policyId={policyId} />;       // cleared: just the receipt

  const requested = !!ipp?.requested_at;
  const claim = ipp?.proof_status === "Submitted";
  const expired = !!ipp?.link_expired;
  const amount = ipp?.amount ?? ipp?.amount_due ?? null;

  const state = !requested ? { text: tx("Not requested yet"), cls: "bg-amber-50 text-amber-800 ring-amber-200" }
    : claim ? { text: ipp?.proof_artifact_id ? tx("Customer sent a receipt") : tx("Customer says they have paid"), cls: "bg-blue-50 text-blue-700 ring-blue-200" }
    : expired ? { text: tx("Link expired"), cls: "bg-slate-100 text-slate-600 ring-slate-200" }
    : ipp?.proof_status === "Rejected" ? { text: tx("Rejected, waiting for the customer"), cls: "bg-rose-50 text-rose-700 ring-rose-200" }
    : { text: tx("Waiting for the customer"), cls: "bg-amber-50 text-amber-800 ring-amber-200" };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setNote(null);
    try { await fn(); } catch (err: any) { setNote({ tone: "err", text: msg(err, tx("Something went wrong.")) }); }
    finally { setBusy(null); }
  };
  const sent = (r: { ipp: IPP; emailed: boolean; customer_email: string | null }, what: string) => {
    onChange(r.ipp);
    setNote({ tone: "ok", text: r.emailed ? tx("{what} emailed to {email}.", { what, email: r.customer_email ?? "" }) : tx("The customer has no email on file. Copy the link and send it to them yourself.") });
  };

  const request = () => run("request", async () => sent(await requestPolicyPayment(policyId), tx("Payment link")));
  const remind = () => run("remind", async () => sent(await remindPolicyPayment(policyId), tx("Reminder")));
  const withdraw = () => {
    if (!window.confirm(tx("Stop the customer's link from working? You can send a new one later."))) return;
    return run("withdraw", async () => { onChange(await withdrawPolicyPayment(policyId)); setNote({ tone: "ok", text: tx("Payment request withdrawn.") }); });
  };
  const decide = (decision: "accept" | "reject") => {
    let why: string | undefined;
    if (decision === "reject") {
      const a = window.prompt(tx("Why can't this payment be confirmed? The customer will see this and can try again."), "");
      if (a === null) return;
      why = a.trim() || undefined;
    } else if (!window.confirm(tx("Confirm that the initial premium has been received? The application can then go to underwriting."))) return;
    return run(decision, async () => { const r = await reviewPolicyProof(policyId, decision, why); onChange(r); if (decision === "accept") onCleared(); });
  };
  const received = () => run("received", async () => {
    onChange(await markPolicyPaymentReceived(policyId, { method: form.method, reference: form.reference.trim() || undefined, note: form.note.trim() || undefined }));
    setReceiving(false); onCleared();
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white text-xs text-slate-600">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 border-b border-slate-100">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tx("Initial premium")}</p>
          <p className="text-sm font-bold text-slate-900">{tx("Payment required from the customer")} · <span className="text-blue-700">{pkr(amount)}</span></p>
        </div>
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${state.cls}`}>{state.text}</span>
      </div>

      <div className="px-3.5 py-3 space-y-3">
        {(ipp?.breakdown ?? ipp?.breakdown_due)?.split?.message_upfront && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">{(ipp?.breakdown ?? ipp?.breakdown_due)!.split!.message_upfront}</p>
        )}
        {(ipp?.breakdown ?? ipp?.breakdown_due) && (
          <details open className="group">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">{tx("How this amount is made up")}</summary>
            <div className="mt-2 max-w-sm"><BreakdownTable b={(ipp?.breakdown ?? ipp?.breakdown_due)!} compact /></div>
          </details>
        )}
        {!requested && <p>{tx("Ask the customer to pay. They get a secure link by email and in their portal, and can upload a receipt or tell us they have paid. Or record the payment yourself if you have already received it.")}</p>}

        {requested && (
          <>
            <p>
              {tx("Requested {when} by {who}.", { when: displayDateTime(ipp!.requested_at!), who: ipp!.requested_by ?? "—" })}{" "}
              {expired ? tx("The link has expired.") : tx("Link valid until {until}.", { until: displayDate(ipp!.request_expires_at ?? "") })}{" "}
              {(ipp!.reminder_count ?? 0) > 0 && tx("Reminders sent: {n} (last {when}).", { n: ipp!.reminder_count ?? 0, when: displayDateTime(ipp!.last_reminded_at ?? "") })}
            </p>
            {ipp!.link && (
              <div className="flex flex-wrap items-center gap-2">
                <input readOnly value={ipp!.link} onFocus={(e) => e.currentTarget.select()} className={`flex-1 min-w-[12rem] rounded-md border px-2 py-1 font-mono text-[11px] ${expired ? "border-slate-200 bg-slate-100 text-slate-400 line-through" : "border-slate-200 bg-slate-50"}`} />
                <button type="button" className={`${BTN} bg-blue-50 text-blue-700 hover:bg-blue-100`} onClick={() => navigator.clipboard?.writeText(ipp!.link!)}>{tx("Copy link")}</button>
              </div>
            )}
            {ipp!.proof_status === "Rejected" && ipp!.proof_review_note && <p className="text-amber-700">{tx("You rejected the last claim: {why}", { why: ipp!.proof_review_note })}</p>}
          </>
        )}

        {claim && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-blue-900 space-y-1.5">
            <p className="font-semibold">{ipp!.proof_artifact_id ? tx("The customer uploaded a receipt") : tx("The customer says they have paid, without a receipt")} ({displayDateTime(ipp!.proof_uploaded_at ?? "")})</p>
            {(ipp!.proof_method || ipp!.proof_reference) && <p>{[ipp!.proof_method, ipp!.proof_reference ? `${tx("ref")} ${ipp!.proof_reference}` : null].filter(Boolean).join(" · ")}</p>}
            {ipp!.proof_note && <p>{tx("Customer's note")}: {ipp!.proof_note}</p>}
            <div className="flex flex-wrap gap-2 pt-0.5">
              {ipp!.proof_artifact_id && <a href={proofUrl(ipp!.proof_artifact_id)} target="_blank" rel="noreferrer" className={`${BTN} bg-white text-blue-700 border border-blue-200 hover:bg-blue-100`}>{tx("View attachment")}</a>}
              {canAct && <button type="button" disabled={!!busy} onClick={() => decide("accept")} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>{tx("Confirm payment received")}</button>}
              {canAct && <button type="button" disabled={!!busy} onClick={() => decide("reject")} className={`${BTN} bg-rose-50 text-rose-700 hover:bg-rose-100`}>{tx("Reject")}</button>}
            </div>
          </div>
        )}

        {receiving && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 space-y-2">
            <p className="font-semibold text-slate-700">{tx("Record the payment as received")}</p>
            <div className="grid sm:grid-cols-3 gap-2">
              <label className="space-y-1"><span className="text-[10px] font-semibold uppercase text-slate-400">{tx("Received by")}</span>
                <select className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{tx(m)}</option>)}</select></label>
              <label className="space-y-1"><span className="text-[10px] font-semibold uppercase text-slate-400">{tx("Reference / receipt no.")}</span>
                <input className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} maxLength={100} /></label>
              <label className="space-y-1"><span className="text-[10px] font-semibold uppercase text-slate-400">{tx("Note")}</span>
                <input className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} /></label>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={!!busy} onClick={received} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>{busy === "received" ? tx("Saving…") : tx("Save: payment received")}</button>
              <button type="button" disabled={!!busy} onClick={() => setReceiving(false)} className={`${BTN} bg-white text-slate-600 border border-slate-200 hover:bg-slate-50`}>{tx("Cancel")}</button>
            </div>
          </div>
        )}

        {note && <p className={`rounded-md px-3 py-2 ${note.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{note.text}</p>}

        {canAct && !receiving && (
          <div className="flex flex-wrap gap-2">
            {!requested && <button type="button" disabled={!!busy} onClick={request} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>{busy === "request" ? tx("Sending…") : tx("Request payment from customer")}</button>}
            {requested && !claim && <button type="button" disabled={!!busy} onClick={remind} className={`${BTN} bg-blue-50 text-blue-700 hover:bg-blue-100`}>{busy === "remind" ? tx("Sending…") : expired ? tx("Send a new link by email") : tx("Send reminder email")}</button>}
            <button type="button" disabled={!!busy} onClick={() => setReceiving(true)} className={`${BTN} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50`}>{tx("Mark as received")}</button>
            {requested && !expired && !claim && <button type="button" disabled={!!busy} onClick={withdraw} className={`${BTN} text-slate-500 hover:text-rose-600`}>{tx("Withdraw request")}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
