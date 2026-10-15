"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Banner, Card, Field, Icon, Skeleton, Spinner, errorText } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { date, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { WalkInPayView } from "@/lib/types";

const H = { "x-requested-with": "customer-portal" };
const MAX = 10 * 1024 * 1024;

async function fail(res: Response): Promise<ApiError> {
  let b: any = null;
  try { b = await res.json(); } catch { /* not JSON */ }
  const e = b?.error || b?.detail;
  return new ApiError(res.status, e?.code || "ERROR", e?.message || "Something went wrong.", e?.details || {});
}

// Opened from the emailed link (or from Track Status). The token in the URL is the only credential: it shows ONE payment
// and accepts a screenshot of it. No sign-in is needed.
export default function PayPage({ params }: { params: { token: string } }) {
  const { t } = useI18n();
  const [view, setView] = useState<WalkInPayView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const base = `/api/portal/public/pay/${encodeURIComponent(params.token)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) throw await fail(res);
      setView(await res.json()); setError(null);
    } catch (e) { setError(e as ApiError); }
  }, [base]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {                         // follows the insurer's decision while the page stays open
    if (view?.state !== "ProofSubmitted") return;
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 15000);
    return () => clearInterval(id);
  }, [view?.state, load]);

  const pick = (f: File | null) => {
    setError(null);
    if (f && f.size > MAX) { setError(new ApiError(413, "FILE_TOO_LARGE", "")); return; }
    if (f && !/\.(png|jpe?g|webp|heic|pdf)$/i.test(f.name)) { setError(new ApiError(422, "UNSUPPORTED_FILE", "")); return; }
    setFile(f);
  };

  // "I have paid": with a receipt if they have one, otherwise just the declaration. Either way staff see it at once.
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        if (note.trim()) form.append("note", note.trim());
        if (method) form.append("method", method);
        if (reference.trim()) form.append("reference", reference.trim());
        res = await fetch(`${base}/proof`, { method: "POST", headers: H, body: form, cache: "no-store" });
      } else {
        res = await fetch(`${base}/declare`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ method: method || undefined, reference: reference.trim() || undefined, note: note.trim() || undefined }), cache: "no-store" });
      }
      if (!res.ok) throw await fail(res);
      setView(await res.json()); setSent(true); setFile(null); setNote(""); setReference("");
      if (input.current) input.current.value = "";
    } catch (err) { setError(err as ApiError); }
    finally { setBusy(false); }
  }

  const state = view?.state;
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50">
      <div className="flex justify-end p-4"><LanguageSwitcher /></div>
      <main className="flex-1 flex items-start justify-center px-4 pb-12">
        <div className="w-full max-w-lg space-y-4">
          <div className="flex flex-col items-center">
            <span className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-200 mb-3"><Icon name="shield" className="w-8 h-8" /></span>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">{t("walkin.pay.title")}</h1>
            {view && <p className="text-sm text-slate-500 mt-0.5 text-center">{t("walkin.pay.for", { name: view.customer_name, plan: view.plan_label })}</p>}
          </div>

          {!view && !error && <Skeleton className="h-64 w-full" />}
          {!view && error && <Banner tone="danger" title={errorText(t, error)} />}

          {view && (
            <Card>
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <p className="text-sm font-semibold text-slate-700">{t("walkin.pay.amount")}</p>
                  <p className="text-2xl font-bold text-blue-700 ltr-num" dir="ltr">{money(view.amount)}</p>
                </div>
                {view.breakdown?.split && view.breakdown.split.remaining_amount > 0 && (
                  <Banner tone="info">{t("walkin.pay.split", { paidPct: view.breakdown.split.upfront_pct, paid: money(view.breakdown.split.upfront_amount), remPct: view.breakdown.split.remaining_pct, remaining: money(view.breakdown.split.remaining_amount) })}</Banner>
                )}
                {view.breakdown && (
                  <details open className="rounded-xl border border-slate-200 text-sm">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">{t("walkin.pay.breakdown")}</summary>
                    <dl className="divide-y divide-slate-100 border-t border-slate-100">
                      {([["walkin.pay.b.base", view.breakdown.base_premium], ...(view.breakdown.split && !view.breakdown.loading_amount ? [] : [["walkin.pay.b.loading", view.breakdown.loading_amount]]), ["walkin.pay.b.fee", view.breakdown.policy_fee],
                        ["walkin.pay.b.stamp", view.breakdown.stamp_duty_amount], ["walkin.pay.b.tax", view.breakdown.tax_amount]] as [string, number][]).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3 px-3 py-1.5"><dt className="text-slate-500">{t(k)}</dt><dd className="font-medium text-slate-800 ltr-num" dir="ltr">{money(v)}</dd></div>))}
                    </dl>
                  </details>
                )}
                {view.reference && <p className="text-xs text-slate-500">{t("walkin.pay.reference")}: <span className="font-mono text-slate-700" dir="ltr">{view.reference}</span></p>}

                {state === "Paid" && <Banner tone="success" title={t("walkin.pay.paid")}>{t("walkin.pay.paidText")}</Banner>}
                {state === "Paid" && view.receipt && (
                  <div className="rounded-xl border border-emerald-200 text-sm">
                    <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-emerald-50/70 rounded-t-xl border-b border-emerald-100">
                      <div><p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">{t("walkin.receipt.title")}</p><p className="font-mono font-bold text-slate-900" dir="ltr">{view.receipt.receipt_no}</p></div>
                      <button type="button" className="btn-secondary" onClick={() => window.print()}>{t("walkin.receipt.print")}</button>
                    </div>
                    <dl className="px-4 py-2 divide-y divide-slate-100">
                      {([[t("walkin.receipt.from"), view.receipt.customer_name], [t("walkin.receipt.for"), view.receipt.plan_label], [t("walkin.receipt.date"), date(view.receipt.received_at)],
                         [t("walkin.receipt.method"), view.receipt.method], [t("walkin.receipt.reference"), view.receipt.reference]] as [string, string | null][]).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-4 py-1.5"><dt className="text-slate-400">{k}</dt><dd className="font-medium text-slate-800 text-end">{v || "—"}</dd></div>
                      ))}
                      <div className="flex justify-between gap-4 pt-2"><dt className="font-semibold text-slate-700">{t("walkin.receipt.amount")}</dt><dd className="font-bold text-emerald-700 ltr-num" dir="ltr">{money(view.receipt.amount)}</dd></div>
                    </dl>
                  </div>
                )}
                {state === "Expired" && <Banner tone="warning" title={t("walkin.pay.expired")}>{t("walkin.pay.expiredText")}</Banner>}
                {state === "ProofSubmitted" && (
                  <Banner tone="info" title={sent ? t("walkin.pay.thanks") : t("walkin.pay.checking")}>
                    {t("walkin.pay.checkingText")}
                    <span className="block mt-1 text-xs">{view.has_receipt ? t("walkin.pay.withReceipt") : t("walkin.pay.noReceipt")}{view.proof_reference ? ` · ${t("walkin.pay.txRef")}: ${view.proof_reference}` : ""}</span>
                  </Banner>
                )}
                {state === "Rejected" && <Banner tone="danger" title={t("walkin.pay.rejected")}>{view.review_note ? t("walkin.pay.rejectedWhy", { why: view.review_note }) : t("walkin.pay.rejectedText")}</Banner>}

                {(state === "Open" || state === "Rejected") && (
                  <>
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm text-slate-600 space-y-1.5">
                      <p className="font-semibold text-slate-800">{t("walkin.pay.how")}</p>
                      <ol className="list-decimal ps-5 space-y-1 text-xs">
                        <li>{t("walkin.pay.step1", { amount: money(view.amount) })}</li>
                        <li>{t("walkin.pay.step2")}</li>
                        <li>{t("walkin.pay.step3")}</li>
                      </ol>
                      {view.channels.length > 0 && <p className="text-xs text-slate-500">{t("walkin.pay.channels")}: {view.channels.join(", ")}</p>}
                      {(view.insurer.phone || view.insurer.email) && <p className="text-xs text-slate-500">{t("walkin.pay.help")}: <span dir="ltr">{[view.insurer.phone, view.insurer.email].filter(Boolean).join("  ·  ")}</span></p>}
                    </div>
                    <form onSubmit={submit} className="space-y-3">
                      {error && <Banner tone="danger" title={errorText(t, error)} />}
                      <p className="text-xs text-slate-500">{t("walkin.pay.declareHint")}</p>
                      <div className="grid sm:grid-cols-2 gap-3">
                        <Field label={t("walkin.pay.method")} htmlFor="method">
                          <select id="method" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                            <option value="">{t("walkin.apply.optional")}</option>{view.channels.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </Field>
                        <Field label={t("walkin.pay.txRef")} htmlFor="ref"><input id="ref" className="input" dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
                      </div>
                      <Field label={t("walkin.pay.screenshot")} htmlFor="proof" hint={t("walkin.pay.screenshotHint")}>
                        <input ref={input} id="proof" type="file" accept="image/*,.pdf" className="input" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
                      </Field>
                      <Field label={t("walkin.pay.note")} htmlFor="note">
                        <input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                      </Field>
                      <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? <><Spinner />{t("common.uploading")}</> : t("walkin.pay.iHavePaid")}</button>
                    </form>
                  </>
                )}
                {view.expires_at && state !== "Paid" && <p className="text-[11px] text-slate-400 text-center">{t("walkin.pay.validUntil", { date: date(view.expires_at) })}</p>}
              </div>
            </Card>
          )}
          <p className="text-center text-xs text-slate-500"><Link href="/walk-in/status" className="font-semibold text-blue-600">{t("walkin.pay.back")}</Link></p>
        </div>
      </main>
    </div>
  );
}
