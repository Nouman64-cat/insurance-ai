"use client";
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Banner, Card, EmptyState, ErrorState, Field, PageHeader, Skeleton, Spinner, errorText, tOr } from "@/components/ui";
import { ApiError, api, useApi } from "@/lib/api";
import { money, newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { ClaimDetail, ClaimOptions, PolicyCard } from "@/lib/types";

function NewClaim() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const policies = useApi<{ items: PolicyCard[] }>("policies?segment=all");   // individual + the family policies this customer may act on
  const [policyId, setPolicyId] = useState(params.get("policy") || "");
  const options = useApi<ClaimOptions>(policyId ? `policies/${encodeURIComponent(policyId)}/claims/options` : null);
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();   // the customer's own date, not UTC
  const [f, setF] = useState({ category: "", event_date: "", event_end_date: "", cause: "", event_place: "", description: "", claimed_amount: "", hospital: "", diagnosis: "" });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [coveredId, setCoveredId] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const key = useRef(newIdempotencyKey());

  const eligible = (policies.data?.items || []).filter((p) => !p.pending_issuance);
  useEffect(() => { if (!policyId && eligible.length === 1) setPolicyId(eligible[0].id); }, [policyId, eligible.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const opt = options.data;
  const cats = (opt?.categories || []).filter((c) => c.available);
  const persons = opt?.covered_persons || [];
  const isFamily = opt?.segment === "family";
  const covered = persons.find((c) => c.id === (coveredId || persons.find((x) => x.is_you)?.id)) || persons[0];
  useEffect(() => { setCoveredId(""); setConsent(false); }, [policyId]);
  useEffect(() => { if (cats.length && !cats.some((c) => c.key === f.category)) setF((x) => ({ ...x, category: cats[0].key })); }, [opt]); // eslint-disable-line react-hooks/exhaustive-deps

  const amount = Number(f.claimed_amount);
  const valid1 = !!policyId && !!opt?.can_claim_online && cats.length > 0 && !!f.category && (!isFamily || (!!covered && (!covered.needs_consent || consent)));
  const descLen = f.description.trim().length;
  // What is stopping "Next" on step 2, in words, so a disabled button is never a mystery.
  const problems2: string[] = [];
  if (!f.event_date) problems2.push(t("claimNew.need.eventDate"));
  else if (f.event_date > today) problems2.push(t("claimNew.need.eventFuture"));
  if (f.event_end_date && f.event_date && f.event_end_date < f.event_date) problems2.push(t("claimNew.need.endBefore"));
  if (f.category === "Hospitalization" && f.hospital.trim().length < 2) problems2.push(t("claimNew.need.hospital"));
  if (descLen < 10) problems2.push(t("claimNew.need.description", { n: 10 - descLen }));
  if (!(amount > 0)) problems2.push(t("claimNew.need.amount"));

  // Fills the form with a believable claim for the chosen type, to save time when trying the flow out.
  const demo = () => {
    const back = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const start = back(9), end = back(5);
    const cause = (opt?.causes || []).find((c) => c === "Illness") || (opt?.causes || [])[0] || "";
    setF((x) => f.category === "Hospitalization"
      ? { ...x, event_date: start, event_end_date: end, cause, event_place: "Lahore", hospital: "Shaukat Khanum Memorial Hospital", diagnosis: "Acute appendicitis",
          description: "Admitted with severe abdominal pain, diagnosed with appendicitis and operated on. Discharged after four days.", claimed_amount: "185000" }
      : { ...x, event_date: start, event_end_date: end, cause, event_place: "Lahore", hospital: "", diagnosis: "",
          description: "Disabled by an accident at work and unable to work since. Medical reports are available.", claimed_amount: "250000" });
  };

  const valid2 = !!f.event_date && f.event_date <= today && (!f.event_end_date || f.event_end_date >= f.event_date) && f.description.trim().length >= 10 && amount > 0
    && (f.category !== "Hospitalization" || (f.hospital.trim().length > 1));

  async function submit() {
    setBusy(true); setError(null);
    try {
      const body = {
        category: f.category, event_date: f.event_date, event_end_date: f.event_end_date || null, cause: f.cause || null, event_place: f.event_place || null,
        description: f.description.trim(), claimed_amount: amount,
        ...(isFamily && covered ? { covered_person_id: covered.id, consent_confirmed: consent } : {}),
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
                    {eligible.map((p) => <option key={p.id} value={p.id}>{p.policy_number} — {p.product_name}{p.family ? ` · ${t(`plan.${p.family.plan_type}`)}` : ""} ({t(`policyStatus.${p.status_key}`)})</option>)}
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
                    {isFamily && persons.length > 0 && (
                      <Field label={t("claimNew.forPerson")} htmlFor="covered" hint={t("claimNew.forPersonHint")}>
                        <select id="covered" className="input" value={covered?.id || ""} onChange={(e) => { setCoveredId(e.target.value); setConsent(false); }}>
                          {persons.map((c) => <option key={c.id} value={c.id}>{c.name} — {tOr(t, `relationship.${c.relationship}`, c.relationship)}{c.is_you ? ` (${t("family.you")})` : ""}</option>)}</select>
                      </Field>)}
                    {isFamily && covered?.needs_consent && (
                      <label className="flex items-start gap-2 text-sm text-slate-700 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                        <span>{t("claimNew.consent", { name: covered.name })}<span className="block text-xs text-amber-800 mt-0.5">{t("claimNew.consentHint")}</span></span></label>)}
                    {isFamily && <Banner tone="info" title={t("claimNew.nomineeNotCovered.title")}>{t("claimNew.nomineeNotCovered.text")}</Banner>}
                    <Banner tone="info" title={t("claims.death.title")}>{isFamily ? t("claims.death.familyText") : t("claims.death.text")}</Banner>
                  </>
                )}
                <div className="flex justify-end"><button type="button" className="btn-primary" disabled={!valid1} onClick={() => setStep(2)}>{t("common.next")}</button></div>
              </div>
            </Card>
          )}

          {step === 2 && (
            <Card title={t("claimNew.step.2")} action={<button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={demo}>{t("claimNew.demo")}</button>}>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label={t("claimNew.eventDate")} htmlFor="event_date" hint={t("claimNew.eventDateHint")}><input id="event_date" type="date" className="input" max={today} value={f.event_date} onChange={set("event_date")} required /></Field>
                <Field label={t("claimNew.eventEnd")} htmlFor="event_end"><input id="event_end" type="date" className="input" min={f.event_date || undefined} max={today} value={f.event_end_date} onChange={set("event_end_date")} /></Field>
                {f.category === "Hospitalization" && <>
                  <Field label={t("claimNew.hospital")} htmlFor="hospital"><input id="hospital" className="input" value={f.hospital} onChange={set("hospital")} maxLength={150} required /></Field>
                  <Field label={t("claimNew.diagnosis")} htmlFor="diagnosis"><input id="diagnosis" className="input" value={f.diagnosis} onChange={set("diagnosis")} maxLength={200} /></Field>
                </>}
                <Field label={t("claimNew.cause")} htmlFor="cause"><select id="cause" className="input" value={f.cause} onChange={set("cause")}><option value="">{t("claimNew.noCause")}</option>{(opt?.causes || []).map((c) => <option key={c} value={c}>{t(`cause.${c}`)}</option>)}</select></Field>
                <Field label={t("claimNew.place")} htmlFor="place"><input id="place" className="input" value={f.event_place} onChange={set("event_place")} maxLength={200} /></Field>
                <div className="sm:col-span-2"><Field label={t("claimNew.description")} htmlFor="description" hint={descLen > 0 && descLen < 10 ? t("claimNew.need.description", { n: 10 - descLen }) : t("claimNew.descriptionHint")}><textarea id="description" className="input min-h-[110px]" value={f.description} onChange={set("description")} maxLength={4000} required /></Field></div>
                <Field label={t("claimNew.amount")} htmlFor="amount" hint={t("claimNew.amountHint")}><input id="amount" type="number" inputMode="decimal" min="1" step="any" className="input" dir="ltr" value={f.claimed_amount} onChange={set("claimed_amount")} required /></Field>
              </div>
              {problems2.length > 0 && <p className="mt-4 text-xs text-amber-700" role="status">{t("claimNew.need.title")} {problems2.join(" · ")}</p>}
              <div className="flex justify-between mt-5"><button type="button" className="btn-secondary" onClick={() => setStep(1)}>{t("common.back")}</button><button type="button" className="btn-primary" disabled={!valid2} onClick={() => setStep(3)}>{t("common.next")}</button></div>
            </Card>
          )}

          {step === 3 && (
            <Card title={t("claimNew.step.3")}>
              <dl className="divide-y divide-slate-100 text-sm">
                {[[t("claimNew.policy"), `${policy?.policy_number} — ${policy?.product_name}`], ...(isFamily && covered ? [[t("claimNew.forPerson"), covered.name]] : []), [t("claimNew.type"), t(`claimType.${f.category}`)], [t("claimNew.eventDate"), f.event_date],
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
