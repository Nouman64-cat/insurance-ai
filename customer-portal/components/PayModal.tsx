"use client";
import { useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { date, money, newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Installment, PolicyCard, Receipt } from "@/lib/types";
import { DownloadButton } from "./DownloadButton";
import { Banner, Field, Modal, Spinner, errorText } from "./ui";

const METHODS = ["JazzCash", "Easypaisa", "Card", "BankTransfer"] as const;
type Stage = "review" | "working" | "done" | "failed";

/** Pays one instalment through the platform's SIMULATED gateway. The amount shown is the one the ledger says is payable now;
 *  the server re-checks it. One Idempotency-Key per attempt, reused for retries of an unknown outcome so a repeat can never
 *  charge twice, and replaced only after a definite refusal. */
export function PayModal({ policy, installment, onClose, onPaid }: { policy: PolicyCard; installment: Installment; onClose: () => void; onPaid: () => void }) {
  const { t, locale } = useI18n();
  const [method, setMethod] = useState<(typeof METHODS)[number]>("JazzCash");
  const [stage, setStage] = useState<Stage>("review");
  const [error, setError] = useState<ApiError | null>(null);
  const [receipt, setReceipt] = useState<Partial<Receipt> | null>(null);
  const [amount, setAmount] = useState(installment.payable);
  const key = useRef(newIdempotencyKey());

  async function pay() {
    setStage("working"); setError(null);
    try {
      const res = await api<{ receipt: Partial<Receipt> | null; duplicate?: boolean }>(`policies/${policy.id}/premiums/${installment.id}/pay`, {
        method: "POST", body: { method, expected_amount: amount }, idempotencyKey: key.current });
      setReceipt(res.receipt); setStage("done"); onPaid();
    } catch (e) {
      const err = e as ApiError;
      setError(err); setStage("failed");
      if (err.code === "AMOUNT_CHANGED" && typeof err.details?.payable === "number") { setAmount(err.details.payable); key.current = newIdempotencyKey(); }
      else if (!["NETWORK", "SERVICE_UNAVAILABLE", "DOMAIN_UNAVAILABLE", "PAYMENT_IN_PROGRESS"].includes(err.code)) key.current = newIdempotencyKey();
      if (err.code === "ALREADY_PAID" || err.code === "PAY_OLDEST_FIRST" || err.code === "AMOUNT_CHANGED") onPaid();   // refresh what the page shows
    }
  }

  const handle = receipt?.id ? `receipt:${policy.id}:${receipt.id}` : null;
  return (
    <Modal title={t("pay.title")} onClose={onClose} busy={stage === "working"}>
      <div className="space-y-4">
        <Banner tone="warning" title={t("pay.simulated.title")}>{t("pay.simulated.text")}</Banner>
        {stage !== "done" && (
          <>
            <dl className="rounded-xl bg-slate-50 border border-slate-100 divide-y divide-slate-100 text-sm">
              <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-slate-500">{t("pay.policy")}</dt><dd className="font-semibold text-slate-800 ltr-num">{policy.policy_number}</dd></div>
              <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-slate-500">{t("pay.installment")}</dt><dd className="font-semibold text-slate-800">#{installment.installment_no} · {date(installment.due_date, locale)}</dd></div>
              {installment.surcharge > 0 && <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-slate-500">{t("pay.surcharge")}</dt><dd className="font-semibold text-amber-700">{money(installment.surcharge)}</dd></div>}
              <div className="flex justify-between gap-3 px-4 py-3"><dt className="font-bold text-slate-700">{t("pay.total")}</dt><dd className="text-lg font-black text-slate-900">{money(amount)}</dd></div>
            </dl>
            <Field label={t("pay.method")} htmlFor="method">
              <select id="method" className="input" value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])} disabled={stage === "working"}>
                {METHODS.map((m) => <option key={m} value={m}>{t(`pay.methods.${m}`)}</option>)}
              </select>
            </Field>
          </>
        )}
        {stage === "failed" && error && (
          <Banner tone="danger" title={errorText(t, error)}>
            {error.code === "AMOUNT_CHANGED" && t("pay.amountChanged", { amount: money(amount) })}
          </Banner>
        )}
        {stage === "done" && (
          <div className="text-center py-2">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3 text-2xl" aria-hidden="true">✓</div>
            <p className="font-bold text-slate-900">{t("pay.success")}</p>
            <p className="text-sm text-slate-500 mt-1">{t("pay.successText", { amount: money(amount), receipt: receipt?.receipt_no || "" })}</p>
            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3">{t("pay.simulatedReceipt")}</p>
            {handle && <div className="mt-3"><DownloadButton handle={handle} fallbackName={`${receipt?.receipt_no || "receipt"}.pdf`} label={t("payments.downloadReceipt")} /></div>}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {stage === "done" ? <button type="button" className="btn-primary" onClick={onClose}>{t("common.done")}</button> : (
            <>
              <button type="button" className="btn-secondary" onClick={onClose} disabled={stage === "working"}>{t("common.cancel")}</button>
              <button type="button" className="btn-primary" onClick={pay} disabled={stage === "working" || (stage === "failed" && ["ALREADY_PAID", "PAY_OLDEST_FIRST", "POLICY_NOT_PAYABLE"].includes(error?.code || ""))}>
                {stage === "working" ? <><Spinner />{t("pay.processing")}</> : stage === "failed" ? t("pay.tryAgain") : t("pay.confirm", { amount: money(amount) })}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
