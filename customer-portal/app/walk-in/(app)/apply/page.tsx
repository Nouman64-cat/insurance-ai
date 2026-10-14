"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Banner, Card, ErrorState, Field, PageHeader, Skeleton, Spinner, errorText } from "@/components/ui";
import { ApiError, api, useApi } from "@/lib/api";
import { FamilyApplication } from "@/components/walkin/FamilyApplication";
import { demoApplication } from "@/lib/demoWalkIn";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { WalkInLead, WalkInPlan, WalkInProfile } from "@/lib/types";
import { Applicant, FIELDS, FieldDef, FormState, TABS, TabId, buildProfile, emptyForm, missing, optionKey } from "@/lib/walkinForm";

const CONTACT = ["Any", "Phone", "WhatsApp", "Email"] as const;
const DEMO = process.env.NEXT_PUBLIC_WALKIN_DEMO !== "false";

function newKey(): string {
  return (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, "");
}

function ApplyForm() {
  const { t } = useI18n();
  const params = useSearchParams();
  const me = useApi<WalkInProfile>("walk-in/me");
  const plans = useApi<{ plans: WalkInPlan[] }>("walk-in/plans");
  const mine = useApi<{ leads: WalkInLead[] }>("walk-in/application");
  const [f, setF] = useState<FormState>(() => ({ ...emptyForm(), plan_id: params.get("plan") || "" }));
  const [tab, setTab] = useState<TabId>("demographics");
  const [who, setWho] = useState<Applicant>("Self");              // for myself, or for my family
  const [demoTick, setDemoTick] = useState(0);                   // tells the family form to fill itself with demo data
  const key = useRef(newKey());                         // one key per form: a double click or retry can never create a second request
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: string, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  // A family chooses a family plan; someone applying for themselves chooses any other.
  const grouped = useMemo(() => {
    const g: Record<string, WalkInPlan[]> = {};
    (plans.data?.plans || []).filter((p) => (who === "Family") === (p.category === "Family")).forEach((p) => { (g[p.category] ||= []).push(p); });
    return g;
  }, [plans.data, who]);
  const chosen = plans.data?.plans.find((p) => p.id === f.plan_id);
  const gaps = missing(f);
  const valid = TABS.every((k) => gaps[k].length === 0);
  const idx = Math.max(TABS.indexOf(tab), 0);

  // Opened from a plan (?plan=…): a family plan means a family application.
  useEffect(() => {
    const p = plans.data?.plans.find((x) => x.id === params.get("plan"));
    if (p) setWho(p.category === "Family" ? "Family" : "Self");
  }, [plans.data, params]);

  function chooseWho(next: Applicant) {
    if (next === who) return;
    setWho(next);
    setError(null);
    if (chosen && (next === "Family") !== (chosen.category === "Family")) set("plan_id", "");     // the old choice no longer fits
  }

  function fillDemo() {
    if (!plans.data) return;
    setError(null);
    if (who === "Family") { setDemoTick((n) => n + 1); return; }
    setF(demoApplication(plans.data.plans, String(f.plan_id || params.get("plan") || "")));
  }

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ reference: string }>("walk-in/application", { method: "POST", body, idempotencyKey: key.current });
      setDone(r.reference); mine.reload();
    } catch (err) {
      const e = err as ApiError;
      setError(e);
      const bad = Array.isArray(e.details?.fields) ? String(e.details.fields[0]?.field ?? "") : "";
      const hit = FIELDS.find((d) => bad.includes(d.name));
      if (hit && who === "Self") setTab(hit.tab);
    }
    finally { setBusy(false); }
  }
  const submit = () => {
    if (!valid) return;
    void send({ applicant_type: "Self", profile: buildProfile(f), plan_id: f.plan_id, preferred_contact: f.preferred_contact, message: String(f.message).trim() || undefined, consent: f.consent });
  };

  function control(d: FieldDef) {
    const id = `f_${d.name}`;
    if (d.kind === "bool") {
      return (
        <label key={d.name} className="flex items-center gap-2.5 text-sm text-slate-700 sm:col-span-1">
          <input id={id} type="checkbox" checked={!!f[d.name]} onChange={(e) => set(d.name, e.target.checked)} />
          <span>{t(`walkin.f.${d.name}`)}</span>
        </label>
      );
    }
    const label = t(`walkin.f.${d.name}`) + (d.required ? " *" : "");
    return (
      <div key={d.name} className={d.wide ? "sm:col-span-2" : ""}>
        <Field label={label} htmlFor={id} error={null}>
          {d.kind === "select" ? (
            <select id={id} className="input" value={String(f[d.name])} onChange={(e) => set(d.name, e.target.value)}>
              <option value="">{t("walkin.apply.optional")}</option>
              {d.options!.map((o) => <option key={o} value={o}>{d.name === "province" ? o : t(`walkin.o.${optionKey(o)}`)}</option>)}
            </select>
          ) : (
            <input id={id} className="input" type={d.kind === "date" ? "date" : d.kind === "number" ? "number" : d.kind === "tel" ? "tel" : "text"} inputMode={d.kind === "number" ? "decimal" : undefined}
              dir={d.dir} value={String(f[d.name])} placeholder={d.placeholder} maxLength={d.max} min={d.kind === "number" ? 0 : undefined}
              max={d.name === "date_of_birth" ? new Date().toISOString().slice(0, 10) : undefined} onChange={(e) => set(d.name, e.target.value)} />
          )}
        </Field>
      </div>
    );
  }

  if (done) {
    return (
      <>
        <PageHeader title={t("walkin.apply.title")} />
        <Card>
          <div className="text-center py-6 space-y-3">
            <p className="text-sm font-bold text-emerald-700">{t("walkin.apply.received")}</p>
            <p className="text-xs text-slate-500">{t("walkin.apply.reference")}</p>
            <p className="text-2xl font-bold tracking-wide text-slate-900 ltr-num" dir="ltr">{done}</p>
            <p className="text-sm text-slate-600 max-w-md mx-auto">{t("walkin.apply.receivedText")}</p>
            <Link href="/walk-in/status" className="btn-primary inline-flex">{t("walkin.apply.track")}</Link>
          </div>
        </Card>
      </>
    );
  }
  if (plans.error) return <ErrorState error={plans.error} onRetry={plans.reload} />;

  const tabFields = FIELDS.filter((d) => d.tab === tab);
  return (
    <>
      <PageHeader title={t("walkin.apply.title")} subtitle={t("walkin.apply.subtitle")}
        actions={DEMO ? <button type="button" className="btn-secondary" onClick={fillDemo} disabled={!plans.data}>{t("walkin.apply.demo")}</button> : undefined} />
      {(mine.data?.leads.length ?? 0) > 0 && (
        <div className="mb-4"><Banner tone="info" title={t("walkin.apply.existing", { count: mine.data!.leads.length })}
          action={<Link href="/walk-in/status" className="btn-secondary">{t("walkin.nav.status")}</Link>} /></div>
      )}
      <div role="radiogroup" aria-label={t("walkin.who.title")} className="mb-4 grid sm:grid-cols-2 gap-3">
        {(["Self", "Family"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={who === k} onClick={() => chooseWho(k)}
            className={`text-start rounded-xl border p-4 transition-colors ${who === k ? "border-blue-600 bg-blue-50 ring-1 ring-blue-200" : "border-slate-200 bg-white hover:border-slate-300"}`}>
            <p className={`text-sm font-bold ${who === k ? "text-blue-800" : "text-slate-800"}`}>{t(`walkin.who.${k}`)}</p>
            <p className="text-xs text-slate-500 mt-0.5">{t(`walkin.who.${k}Text`)}</p>
          </button>
        ))}
      </div>
      {who === "Family" ? (
        <FamilyApplication plans={plans.data?.plans} plansLoading={plans.loading} email={me.data?.email || ""} initialPlanId={chosen?.category === "Family" ? chosen.id : String(params.get("plan") || "")}
          demoTick={demoTick} busy={busy} error={error} onSubmit={(body) => void send(body)} />
      ) : (<>
      <div className="card overflow-hidden">
        <div role="tablist" aria-label={t("walkin.apply.title")} className="flex flex-wrap gap-x-1 border-b border-slate-100 px-3 pt-2">
          {TABS.map((k) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`relative px-3 py-2.5 text-[13px] font-semibold border-b-2 -mb-px ${tab === k ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
              {t(`walkin.tab.${k}`)}
              {gaps[k].length > 0 && <span className="absolute top-1.5 end-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" aria-label={t("walkin.apply.required")} />}
            </button>
          ))}
        </div>
        <div className="p-5 sm:p-6 space-y-4">
          {error && <Banner tone="danger" title={errorText(t, error)} />}
          <div className="grid sm:grid-cols-2 gap-4">
            {tab === "demographics" && (
              <Field label={t("walkin.apply.email")} htmlFor="email" hint={t("walkin.apply.emailVerified")}>
                {me.loading ? <Skeleton className="h-10 w-full" /> : <input id="email" className="input bg-slate-50" dir="ltr" value={me.data?.email || ""} readOnly />}
              </Field>
            )}
            {tabFields.map(control)}
          </div>

          {tab === "plan" && (
            <div className="space-y-4">
              <Field label={t("walkin.apply.plan") + " *"} htmlFor="plan" hint={t("walkin.apply.planHint")}>
                {plans.loading ? <Skeleton className="h-10 w-full" /> : (
                  <select id="plan" className="input" value={String(f.plan_id)} onChange={(e) => set("plan_id", e.target.value)}>
                    <option value="">{t("walkin.apply.choosePlan")}</option>
                    {Object.entries(grouped).map(([cat, list]) => (
                      <optgroup key={cat} label={t(`walkin.category.${cat}`)}>{list.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>
                    ))}
                  </select>
                )}
              </Field>
              {chosen && chosen.category !== "Individual" && <Banner tone="info">{t("walkin.apply.groupNote", { category: t(`walkin.category.${chosen.category}`) })}</Banner>}
              {chosen && <p className="text-xs text-slate-500">{t("walkin.apply.planBand", { min: chosen.entry_age_min, max: chosen.entry_age_max, tmin: chosen.term_min_years, tmax: chosen.term_max_years })}</p>}
              <Field label={t("walkin.apply.contactPref")} htmlFor="pref">
                <select id="pref" className="input" value={String(f.preferred_contact)} onChange={(e) => set("preferred_contact", e.target.value)}>
                  {CONTACT.map((c) => <option key={c} value={c}>{t(`walkin.contact.${c}`)}</option>)}
                </select>
              </Field>
              <Field label={t("walkin.apply.message")} htmlFor="message">
                <textarea id="message" className="input min-h-[90px]" value={String(f.message)} onChange={(e) => set("message", e.target.value)} maxLength={1000} />
              </Field>
              <label className="flex items-start gap-2.5 text-sm text-slate-700">
                <input type="checkbox" className="mt-1" checked={!!f.consent} onChange={(e) => set("consent", e.target.checked)} />
                <span>{t("walkin.apply.consent")}</span>
              </label>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
          <button type="button" className="btn-secondary" disabled={idx === 0} onClick={() => setTab(TABS[idx - 1])}>{t("common.back")}</button>
          <div className="flex items-center gap-2">
            {idx < TABS.length - 1 && <button type="button" className="btn-secondary" onClick={() => setTab(TABS[idx + 1])}>{t("walkin.apply.next")}</button>}
            <button type="button" className="btn-primary" disabled={!valid || busy} onClick={submit}
              title={valid ? undefined : t("walkin.apply.completeRequired")}>{busy ? <><Spinner />{t("common.submitting")}</> : t("walkin.apply.submit")}</button>
          </div>
        </div>
      </div>
      {!valid && <p className="mt-2 text-xs text-slate-500">{t("walkin.apply.completeRequired")}</p>}
      </>)}
    </>
  );
}

export default function ApplyPage() { return <Suspense><ApplyForm /></Suspense>; }
