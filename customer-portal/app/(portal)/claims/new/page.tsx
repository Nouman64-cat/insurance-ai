"use client";
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Banner, Card, EmptyState, ErrorState, Field, PageHeader, Skeleton, Spinner, errorText } from "@/components/ui";
import { ApiError, api, useApi } from "@/lib/api";
import { money, newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { ClaimDetail, ClaimOptions, PolicyCard } from "@/lib/types";

function NewClaim() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const policies = useApi<{ items: PolicyCard[] }>("policies");
  const [policyId, setPolicyId] = useState(params.get("policy") || "");
  const options = useApi<ClaimOptions>(policyId ? `policies/${encodeURIComponent(policyId)}/claims/options` : null);
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ category: "", event_date: "", event_end_date: "", cause: "", event_place: "", description: "", claimed_amount: "", hospital: "", diagnosis: "" });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const key = useRef(newIdempotencyKey());

  const eligible = (policies.data?.items || []).filter((p) => !p.pending_issuance);
  useEffect(() => { if (!policyId && eligible.length === 1) setPolicyId(eligible[0].id); }, [policyId, eligible.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const opt = options.data;
  const cats = (opt?.categories || []).filter((c) => c.available);
  useEffect(() => { if (cats.length && !cats.some((c) => c.key === f.category)) setF((x) => ({ ...x, category: cats[0].key })); }, [opt]); // eslint-disable-line react-hooks/exhaustive-deps

  const amount = Number(f.claimed_amount);
  const valid1 = !!policyId && !!opt?.can_claim_online && cats.length > 0 && !!f.category;
  const valid2 = !!f.event_date && f.event_date <= today && (!f.event_end_date || f.event_end_date >= f.event_date) && f.description.trim().length >= 10 && amount > 0
    && (f.category !== "Hospitalization" || (f.hospital.trim().length > 1));

  async function submit() {
    setBusy(true); setError(null);
    try {
      const body = {
        category: f.category, event_date: f.event_date, event_end_date: f.event_end_date || null, cause: f.cause || null, event_place: f.event_place || null,
        description: f.description.trim(), claimed_amount: amount,
        event_details: Object.fromEntries(Object.entries({ hospital: f.hospital.trim(), diagnosis: f.diagnosis.trim() }).filter(([, v]) => v)),
      };
      const created = await api<ClaimDetail>(`policies/${encodeURIComponent(policyId)}/claims`, { method: "POST", body, idempotencyKey: key.current });
      router.replace(`/claims/${created.id}?submitted=1`);
    } catch (e) {
      const err = e as ApiError;
      setError(err); setBusy(false);
      // A duplicate takes the customer to the claim that already exists.
      if (err.code === "DUPLICATE_CLAIM" && err.details?.claim_id) router.replace(`/claims/${err.details.claim_id}`);
      else if (!["NETWORK", "SERVICE_UNAVAILABLE", "DOMAIN_UNAVAILABLE", "REQUEST_IN_PROGRESS"].includes(err.code)) key.current = newIdempotencyKey();
    }
  }

  if (policies.error && !policies.data) return <div className="card"><ErrorState error={policies.error} onRetry={policies.reload} /></div>;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const policy = eligible.find((p) => p.id === policyId);

  return (
    <div className="max-w-3xl">
      <PageHeader title={t("claimNew.title")} subtitle={t("claimNew.subtitle")} actions={<Link href="/claims" className="btn-secondary">{t("common.cancel")}</Link>} />
      <ol className="flex items-center gap-2 mb-5 text-xs font-semibold" aria-label={t("claimNew.steps")}>
        {[1, 2, 3].map((n) => (
          <li key={n} className={`flex items-center gap-2 ${step === n ? "text-blue-700" : step > n ? "text-emerald-700" : "text-slate-400"}`} aria-current={step === n ? "step" : undefined}>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center border ${step === n ? "bg-blue-600 border-blue-600 text-white" : step > n ? "bg-emerald-50 border-emerald-300" : "border-slate-300"}`}>{step > n ? "✓" : n}</span>
            {t(`claimNew.step.${n}`)}{n < 3 && <span className="w-6 h-px bg-slate-300" aria-hidden="true" />}
          </li>))}
      </ol>

      {policies.loading && !policies.data ? <Skeleton className="h-64" />
        : eligible.length === 0 ? <div className="card"><EmptyState title={t("claimNew.noPolicy")} text={t("claimNew.noPolicyText")} /></div>
        : (
        <div className="space-y-5">
          {error && error.code !== "DUPLICATE_CLAIM" && <Banner tone="danger" title={errorText(t, error)} />}
          {step === 1 && (
            <Card title={t("claimNew.step.1")}>
              <div className="space-y-4">
                <Field label={t("claimNew.policy")} htmlFor="policy">
                  <select id="policy" className="input" value={policyId} onChange={(e) => { setPolicyId(e.target.value); setF((x) => ({ ...x, category: "" })); }}>
                    <option value="">{t("claimNew.choosePolicy")}</option>
                    {eligible.map((p) => <option key={p.id} value={p.id}>{p.policy_number} — {p.product_name} ({t(`policyStatus.${p.status_key}`)})</option>)}
                  </select>
                </Field>
                {policyId && options.loading && <Skeleton className="h-10" />}
                {policyId && options.error && <ErrorState error={options.error} onRetry={options.reload} />}
                {opt && (
                  <>
                    {opt.note && <Banner tone="info" title={t("claimNew.lateOk.title")}>{t("claimNew.lateOk.text")}</Banner>}
                    {!opt.can_claim_online ? <Banner tone="warning">{t("claimNew.cannotOnline")}</Banner>
                      : cats.length === 0 ? <Banner tone="warning" title={t("claimNew.noBenefit.title")}>{t("claimNew.noBenefit.text")}</Banner>
                      : (
                        <Field label={t("claimNew.type")} htmlFor="category">
                          <select id="category" className="input" value={f.category} onChange={set("category")}>{cats.map((c) => <option key={c.key} value={c.key}>{t(`claimType.${c.key}`)}</option>)}</select>
                        </Field>
                      )}
                    <Banner tone="info" title={t("claims.death.title")}>{t("claims.death.text")}</Banner>
                  </>
                )}
                <div className="flex justify-end"><button type="button" className="btn-primary" disabled={!valid1} onClick={() => setStep(2)}>{t("common.next")}</button></div>
              </div>
            </Card>
          )}

          {step === 2 && (
            <Card title={t("claimNew.step.2")}>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label={t("claimNew.eventDate")} htmlFor="event_date" hint={t("claimNew.eventDateHint")}><input id="event_date" type="date" className="input" max={today} value={f.event_date} onChange={set("event_date")} required /></Field>
                <Field label={t("claimNew.eventEnd")} htmlFor="event_end"><input id="event_end" type="date" className="input" min={f.event_date || undefined} max={today} value={f.event_end_date} onChange={set("event_end_date")} /></Field>
                {f.category === "Hospitalization" && <>
                  <Field label={t("claimNew.hospital")} htmlFor="hospital"><input id="hospital" className="input" value={f.hospital} onChange={set("hospital")} maxLength={150} required /></Field>
                  <Field label={t("claimNew.diagnosis")} htmlFor="diagnosis"><input id="diagnosis" className="input" value={f.diagnosis} onChange={set("diagnosis")} maxLength={200} /></Field>
                </>}
                <Field label={t("claimNew.cause")} htmlFor="cause"><select id="cause" className="input" value={f.cause} onChange={set("cause")}><option value="">{t("claimNew.noCause")}</option>{(opt?.causes || []).map((c) => <option key={c} value={c}>{t(`cause.${c}`)}</option>)}</select></Field>
                <Field label={t("claimNew.place")} htmlFor="place"><input id="place" className="input" value={f.event_place} onChange={set("event_place")} maxLength={200} /></Field>
                <div className="sm:col-span-2"><Field label={t("claimNew.description")} htmlFor="description" hint={t("claimNew.descriptionHint")}><textarea id="description" className="input min-h-[110px]" value={f.description} onChange={set("description")} maxLength={4000} required /></Field></div>
                <Field label={t("claimNew.amount")} htmlFor="amount" hint={t("claimNew.amountHint")}><input id="amount" type="number" inputMode="decimal" min="1" step="any" className="input" dir="ltr" value={f.claimed_amount} onChange={set("claimed_amount")} required /></Field>
              </div>
              <div className="flex justify-between mt-5"><button type="button" className="btn-secondary" onClick={() => setStep(1)}>{t("common.back")}</button><button type="button" className="btn-primary" disabled={!valid2} onClick={() => setStep(3)}>{t("common.next")}</button></div>
            </Card>
          )}

          {step === 3 && (
            <Card title={t("claimNew.step.3")}>
              <dl className="divide-y divide-slate-100 text-sm">
                {[[t("claimNew.policy"), `${policy?.policy_number} — ${policy?.product_name}`], [t("claimNew.type"), t(`claimType.${f.category}`)], [t("claimNew.eventDate"), f.event_date],
                  [t("claimNew.amount"), money(amount)], [t("claimNew.description"), f.description]].map(([k, v]) => (
                  <div key={k} className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2.5"><dt className="text-slate-500">{k}</dt><dd className="font-semibold text-slate-800 sm:text-end sm:max-w-md break-words">{v}</dd></div>))}
              </dl>
              <p className="text-xs text-slate-500 mt-4">{t("claimNew.afterSubmit")}</p>
              <div className="flex justify-between mt-5"><button type="button" className="btn-secondary" onClick={() => setStep(2)} disabled={busy}>{t("common.back")}</button>
                <button type="button" className="btn-primary" onClick={submit} disabled={busy}>{busy ? <><Spinner />{t("common.submitting")}</> : t("claimNew.submit")}</button></div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export default function NewClaimPage() { return <Suspense><NewClaim /></Suspense>; }
