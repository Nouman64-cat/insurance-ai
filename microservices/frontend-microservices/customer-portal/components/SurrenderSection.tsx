"use client";
import { useRef, useState } from "react";
import { ApiError, api, useApi } from "@/lib/api";
import { money, newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { PolicyCard } from "@/lib/types";
import { Banner, Field, Icon, Modal, Skeleton, Spinner, errorText, useToast } from "./ui";

interface Quote {
  policy_id: string; policy_number: string | null; available: boolean; reason: string | null; review_note: string | null; min_years: number; completed_years: number;
  settlement: { gross: number; net: number; total_deductions: number; factor: number | null; premiums_paid: number; fund: number; deductions: { label: string; amount: number }[] } | null;
  open_request: { exit_no: string; status: string; requested_at: string } | null;
}

function SurrenderModal({ policy, onClose, onDone }: { policy: PolicyCard; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const key = useRef(newIdempotencyKey());
  const { data: q, error: loadError, loading, reload } = useApi<Quote>(`policies/${encodeURIComponent(policy.id)}/surrender`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 5) return;
    setBusy(true); setError(null);
    try {
      await api(`policies/${encodeURIComponent(policy.id)}/surrender`, { method: "POST", body: { reason: reason.trim() }, idempotencyKey: key.current });
      setSent(true); toast(t("surrender.sent"), "success"); onDone(); reload();
    } catch (err) { setError(err as ApiError); }
    finally { setBusy(false); }
  }

  const s = q?.settlement;
  return (
    <Modal title={t("surrender.title")} onClose={onClose} busy={busy}>
      <p className="mb-3 text-xs text-slate-500">{policy.product_name}{policy.policy_number ? ` · ${policy.policy_number}` : ""}</p>
      {loading && !q ? <Skeleton className="h-40" /> : loadError ? <Banner tone="danger">{errorText(t, loadError)}</Banner> : q && (
        sent || q.open_request ? (
          <Banner tone="success" title={t("surrender.openTitle")}>{t("surrender.openText", { ref: q.open_request?.exit_no ?? "" })}</Banner>
        ) : !q.available || !s ? (
          <Banner tone="info" title={t("surrender.notAvailable")}>{q.reason ?? t("surrender.yearsNeeded", { n: q.min_years })}</Banner>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-center">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">{t("surrender.youWouldReceive")}</p>
              <p className="mt-1 text-2xl font-extrabold text-amber-700">{money(s.net)}</p>
              <p className="mt-1 text-xs text-slate-500">{t("surrender.indicative")}</p>
            </div>
            <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
              {([[t("surrender.paid"), money(s.premiums_paid)], [t("surrender.fund"), money(s.fund)], [t("surrender.factor"), s.factor != null ? `${s.factor}%` : "—"], [t("surrender.value"), money(s.gross)]] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-3 py-2"><dt className="text-slate-500">{k}</dt><dd className="font-medium tabular-nums text-slate-800">{v}</dd></div>
              ))}
              {s.deductions.map((d) => <div key={d.label} className="flex justify-between gap-4 px-3 py-2"><dt className="text-slate-500">− {d.label}</dt><dd className="tabular-nums text-slate-800">{money(d.amount)}</dd></div>)}
            </dl>
            {q.review_note && <Banner tone="info" title={t("surrender.reviewTitle")}>{q.review_note} {t("surrender.reviewText")}</Banner>}
            <Banner tone="warning">{t("surrender.warning")}</Banner>
            <Field label={t("surrender.reason")} htmlFor="surrender-reason" hint={t("surrender.reasonHint")}>
              <textarea id="surrender-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="input" required minLength={5} maxLength={500} />
            </Field>
            {error && <Banner tone="danger">{errorText(t, error)}</Banner>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
              <button type="submit" className="btn-primary" disabled={busy || reason.trim().length < 5}>{busy && <Spinner />} {t("surrender.submit")}</button>
            </div>
          </form>
        )
      )}
    </Modal>
  );
}

/** Early surrender: the policyholder sees what ending a savings policy now would pay and asks for it. Staff verify and pay it
 *  through Maturity & Exit; nothing happens to the policy from here. Hidden when the customer has no policy they own that is in force. */
export function SurrenderSection() {
  const { t } = useI18n();
  const { data, reload } = useApi<{ items: PolicyCard[] }>("policies?segment=all");
  const [open, setOpen] = useState<PolicyCard | null>(null);
  const rows = (data?.items ?? []).filter((p) => p.in_force && p.access === "owner" && !p.pending_issuance);
  if (rows.length === 0) return null;
  return (
    <section aria-label={t("surrender.title")} className="card overflow-hidden">
      <div className="flex items-start gap-3 border-b border-slate-100 bg-gradient-to-r from-amber-50/70 to-white px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700" aria-hidden="true"><Icon name="money" className="h-[18px] w-[18px]" /></span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-900">{t("surrender.title")}</h2>
          <p className="mt-0.5 text-sm text-slate-500">{t("surrender.subtitle")}</p>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {rows.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{p.product_name}</p>
              <p className="mt-0.5 font-mono text-xs text-slate-400">{p.policy_number ?? ""}</p>
            </div>
            <button type="button" className="btn-secondary shrink-0" onClick={() => setOpen(p)}>{t("surrender.action")}</button>
          </li>
        ))}
      </ul>
      {open && <SurrenderModal policy={open} onClose={() => setOpen(null)} onDone={reload} />}
    </section>
  );
}
