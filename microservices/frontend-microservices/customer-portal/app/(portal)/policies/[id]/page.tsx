"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { Banner, Card, EmptyState, ErrorState, InstallmentState, KeyValue, PageHeader, PolicyStatus, Skeleton, tOr } from "@/components/ui";
import { DownloadButton } from "@/components/DownloadButton";
import { ApiError, api, useApi } from "@/lib/api";
import { RequestKind, RequestModal } from "@/components/RequestModal";
import type { RenewalView } from "@/lib/types";
import { compactMoney, date, dateTime, daysUntil, money, newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { PolicyDetail } from "@/lib/types";

const TABS = ["overview", "coverage", "premiums", "documents", "activity"] as const;
const FAMILY_TABS = ["overview", "coverage", "premiums", "documents", "activity", "servicing"] as const;
type TabKey = (typeof FAMILY_TABS)[number];

/** Renewal status and, only when the renewal engine is waiting for it, acceptance of renewed terms. */
function Renewal({ policyId }: { policyId: string }) {
  const { t, locale } = useI18n();
  const { data, error, reload } = useApi<RenewalView>(`policies/${encodeURIComponent(policyId)}/renewal`);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  if (error || !data) return null;
  const n = data.next;
  async function answer(accepted: boolean) {
    setBusy(true);
    try {
      await api(`policies/${encodeURIComponent(policyId)}/renewal/acceptance`, { method: "POST", body: { accepted }, idempotencyKey: key.current });
      key.current = newIdempotencyKey();      // answered; any later answer is a new operation
      reload();
    } catch (e) {
      if (!["NETWORK", "SERVICE_UNAVAILABLE", "DOMAIN_UNAVAILABLE", "REQUEST_IN_PROGRESS"].includes((e as ApiError).code)) key.current = newIdempotencyKey();
      throw e;
    } finally { setBusy(false); }
  }
  return (
    <Card title={t("renewal.title")}>
      {n ? (
        <>
          <KeyValue label={t("renewal.next")}>{date(n.due_date, locale)} · <span className="ltr-num">{money(n.payable)}</span></KeyValue>
          <KeyValue label={t("renewal.type")}>{n.renewal_type_label}</KeyValue>
          <KeyValue label={t("renewal.window")}>{n.days_until >= 0 ? t("renewal.inDays", { days: n.days_until }) : t("renewal.overdueBy", { days: Math.abs(n.days_until) })}</KeyValue>
        </>
      ) : <p className="text-sm text-slate-500">{t("renewal.none")}</p>}
      {data.eligible === false && data.eligibility_message && <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2 mt-3">{data.eligibility_message}</p>}
      {data.case?.can.accept && (
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-bold text-blue-900">{t("renewal.acceptTitle")}</p>
          <p className="text-xs text-blue-800 mt-1">{t("renewal.acceptText", { amount: money(data.case.quoted_amount) })}</p>
          <div className="flex gap-2 mt-3"><button type="button" className="btn-primary" disabled={busy} onClick={() => answer(true)}>{t("renewal.accept")}</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => answer(false)}>{t("renewal.decline")}</button></div>
        </div>)}
      {data.case?.can.pay && <p className="text-xs text-slate-500 mt-3">{t("renewal.payFromPayments")}</p>}
    </Card>
  );
}

function StatusBanner({ p }: { p: PolicyDetail }) {
  const { t, locale } = useI18n();
  const k = p.status_key;
  const pay = <Link href="/payments" className="btn-primary">{t("policy.payNow")}</Link>;
  if (k === "grace_period") return <Banner tone="warning" title={t("policy.banner.grace.title")} action={pay}>{t("policy.banner.grace.text", { date: date(p.premium.grace_until || p.grace_period_end_date, locale), amount: money(p.premium.due_now) })}</Banner>;
  if (k === "lapsed") return <Banner tone="danger" title={t("policy.banner.lapsed.title")}>{t("policy.banner.lapsed.text")}</Banner>;
  if (k === "pending_issuance" || k === "issued") return <Banner tone="info" title={t("policy.banner.pending.title")}>{t("policy.banner.pending.text")}</Banner>;
  if (k === "cancelled") return <Banner tone="danger" title={t("policy.banner.cancelled.title")}>{t("policy.banner.cancelled.text")}</Banner>;
  if (k === "expired" || k === "matured" || k === "surrendered") return <Banner tone="info" title={t(`policy.banner.${k}.title`)}>{t(`policy.banner.${k}.text`)}</Banner>;
  if (k === "reinstated") return <Banner tone="success" title={t("policy.banner.reinstated.title")}>{t("policy.banner.reinstated.text")}</Banner>;
  if (p.in_force && p.premium.due_now > 0) return <Banner tone="warning" title={t("policy.banner.due.title")} action={pay}>{t("policy.banner.due.text", { amount: money(p.premium.due_now) })}</Banner>;
  const d = daysUntil(p.premium.next_due_date);
  if (p.in_force && d != null && d >= 0 && d <= 14) return <Banner tone="info" title={t("policy.banner.soon.title")} action={pay}>{t("policy.banner.soon.text", { date: date(p.premium.next_due_date, locale), amount: money(p.premium.next_due_amount) })}</Banner>;
  return null;
}

export default function PolicyDetailPage() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const { data: p, error, loading, reload } = useApi<PolicyDetail>(`policies/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<TabKey>("overview");
  const [dialog, setDialog] = useState<RequestKind | null>(null);

  if (error && !p) {
    const missing = (error as ApiError).code === "NOT_FOUND";
    return (
      <div className="card">
        {missing ? <EmptyState title={t("policy.notFound")} text={t("policy.notFoundText")} action={<Link href="/policies" className="btn-primary">{t("policy.backToPolicies")}</Link>} />
          : <ErrorState error={error} onRetry={reload} />}
      </div>
    );
  }
  if (loading || !p) return <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;

  return (
    <div className="space-y-5">
      <PageHeader
        title={p.product_name}
        subtitle={<><span className="ltr-num">{p.policy_number || t("policies.numberPending")}</span> · <PolicyStatus statusKey={p.status_key} />
          {p.family && <span className="ms-2 text-xs font-semibold text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">{t(`plan.${p.family.plan_type}`)} · {p.family.family_name}</span>}</>}
        actions={<>
          <Link href="/policies" className="btn-secondary">{t("policy.backToPolicies")}</Link>
          {p.family && <Link href={`/family/${p.family.family_id}`} className="btn-secondary">{t("family.backToFamily")}</Link>}
          {p.in_force && !p.restricted && <Link href={`/claims/new?policy=${p.id}`} className="btn-secondary">{t("policy.fileClaim")}</Link>}
          {p.in_force && !p.restricted && <Link href={p.segment === "family" ? "/payments?segment=family" : "/payments"} className="btn-primary">{t("policy.premiums")}</Link>}
        </>} />
      {p.restricted && <Banner tone="info" title={t("family.restricted.title")}>{t("family.restricted.text", { name: p.policyholder.name || "" })}</Banner>}
      <StatusBanner p={p} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[{ k: "sumAssured", v: compactMoney(p.sum_assured) }, { k: "premium", v: p.installment_amount != null ? `${money(p.installment_amount)} / ${t(`frequency.${p.premium_frequency}`)}` : "—" },
          { k: "effective", v: date(p.effective_date, locale) }, { k: "expiry", v: date(p.expiry_date || p.maturity_date, locale) }].map((x) => (
          <div key={x.k} className="card min-w-0 px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">{t(`policies.${x.k}`)}</p><p className="text-lg font-black text-slate-900 mt-1">{x.v}</p></div>
        ))}
      </div>

      <div role="tablist" aria-label={t("policy.sections")} className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {(p.segment === "family" ? (p.restricted ? (["overview", "coverage"] as const) : FAMILY_TABS) : TABS).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === k ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{t(`policy.tab.${k}`)}</button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid lg:grid-cols-2 gap-5">
          {p.restricted ? (
            <Card title={t("policy.policyholder")}><KeyValue label={t("profile.name")}>{p.policyholder.name}</KeyValue><p className="text-xs text-slate-400 pt-3">{t("family.restricted.private")}</p></Card>
          ) : (
          <Card title={t("policy.policyholder")}>
            <KeyValue label={t("profile.name")}>{p.policyholder.name}</KeyValue>
            <KeyValue label={t("profile.policyholderId")}><span className="ltr-num">{p.policyholder.policyholder_id}</span></KeyValue>
            <KeyValue label={t("profile.cnic")}><span className="ltr-num">{p.policyholder.cnic_masked}</span></KeyValue>
            <KeyValue label={t("profile.dob")}>{date(p.policyholder.dob, locale)}</KeyValue>
            <KeyValue label={t("profile.email")}>{p.policyholder.email}</KeyValue>
            <KeyValue label={t("profile.phone")}><span className="ltr-num">{p.policyholder.phone}</span></KeyValue>
          </Card>)}
          {p.insured_lives ? (
            <Card title={t("family.insuredPersons")}>
              <p className="text-xs text-slate-500 mb-2">{p.family?.plan_type === "Floater" ? t("family.floaterInsuredNote") : t("family.bundleInsuredNote")}</p>
              {p.insured_lives.map((c) => (
                <KeyValue key={c.customer_id} label={tOr(t, `relationship.${c.relationship}`, c.relationship)}>{c.name}{c.is_you && <span className="ms-2 text-[10px] text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">{t("family.you")}</span>}
                  {c.is_minor && <span className="ms-2 text-[10px] text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">{t("policy.minor")}</span>}
                  <span className="block text-xs font-medium text-slate-400">{c.dob ? date(c.dob, locale) : c.age != null ? t("family.ageYears", { count: c.age }) : ""}</span></KeyValue>))}
            </Card>
          ) : (
          <Card title={t("policy.insured")}>
            <KeyValue label={t("profile.name")}>{p.insured.name}</KeyValue>
            <KeyValue label={t("policy.relationship")}>{p.insured.relationship === "Self" ? t("policy.self") : p.insured.relationship}</KeyValue>
            <KeyValue label={t("profile.dob")}>{date(p.insured.dob, locale)}</KeyValue>
          </Card>)}
          {p.segment === "family" && !p.restricted && p.in_force && <Renewal policyId={p.id} />}
          <Card title={t("policy.plan")}>
            <KeyValue label={t("policy.product")}>{p.plan.product_name}</KeyValue>
            <KeyValue label={t("policy.planType")}>{t(`insuranceType.${p.plan.insurance_type}`)}</KeyValue>
            <KeyValue label={t("policy.term")}>{t("policy.years", { count: p.plan.term_years })}</KeyValue>
            <KeyValue label={t("policy.annualPremium")}>{money(p.annual_premium)}</KeyValue>
          </Card>
          <Card title={t("policy.dates")}>
            <KeyValue label={t("policies.effective")}>{date(p.effective_date, locale)}</KeyValue>
            <KeyValue label={t("policies.expiry")}>{date(p.expiry_date, locale)}</KeyValue>
            {p.maturity_date && p.maturity_date !== p.expiry_date && <KeyValue label={t("policy.maturity")}>{date(p.maturity_date, locale)}</KeyValue>}
            <KeyValue label={t("policy.issued")}>{date(p.issued_at, locale)}</KeyValue>
            <KeyValue label={t("policy.freeLook")}>{date(p.free_look_end_date, locale)}</KeyValue>
            {p.in_force && <KeyValue label={t("policy.nextDue")}>{p.premium.next_due_date ? `${date(p.premium.next_due_date, locale)} · ${money(p.premium.next_due_amount)}` : t("policy.noneDue")}</KeyValue>}
          </Card>
        </div>
      )}

      {tab === "coverage" && (
        <div className="grid lg:grid-cols-2 gap-5">
          <Card title={t("policy.coverage")}>
            <KeyValue label={t("policies.sumAssured")}>{money(p.coverage.sum_assured)}</KeyValue>
            {p.coverage.benefits.length === 0 ? <p className="text-sm text-slate-500 pt-3">{t("policy.noBenefits")}</p>
              : p.coverage.benefits.map((b) => <KeyValue key={b.category} label={b.label}>{b.sum_assured ? money(b.sum_assured) : "—"}</KeyValue>)}
          </Card>
          <Card title={t("policy.riders")}>
            {p.coverage.riders.length === 0 ? <p className="text-sm text-slate-500">{t("policy.noRiders")}</p>
              : p.coverage.riders.map((r) => <KeyValue key={r.name} label={r.name}>{money(r.sum_assured)}{r.annual_premium ? <span className="text-slate-400 font-medium"> · {money(r.annual_premium)} / {t("frequency.Annual")}</span> : null}</KeyValue>)}
          </Card>
          <Card title={t("policy.nominees")} className="lg:col-span-2">
            {p.nominees.length === 0 ? <p className="text-sm text-slate-500">{t("policy.noNominees")}</p> : (
              <div className="overflow-x-auto -mx-5"><table className="w-full"><thead><tr><th className="th">{t("profile.name")}</th><th className="th">{t("policy.relationship")}</th><th className="th">{t("policy.share")}</th></tr></thead>
                <tbody>{p.nominees.map((n, i) => <tr key={i}><td className="td font-semibold">{n.name}{n.is_minor && <span className="ms-2 text-[10px] text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">{t("policy.minor")}</span>}</td><td className="td">{n.relationship}</td><td className="td ltr-num">{n.share_pct}%</td></tr>)}</tbody></table></div>
            )}
            <p className="text-xs text-slate-400 mt-3">{t("policy.nomineeChange")}</p>
          </Card>
        </div>
      )}

      {tab === "premiums" && (
        <Card title={t("policy.schedule")} action={p.in_force ? <Link href="/payments" className="text-xs font-semibold text-blue-600">{t("policy.goToPayments")}</Link> : undefined}>
          {p.premium_schedule.length === 0 ? <EmptyState title={t("policy.noSchedule")} /> : (
            <div className="overflow-x-auto -mx-5"><table className="w-full"><thead><tr><th className="th">#</th><th className="th">{t("payments.dueDate")}</th><th className="th">{t("payments.amount")}</th><th className="th">{t("payments.paid")}</th><th className="th">{t("payments.status")}</th></tr></thead>
              <tbody>{p.premium_schedule.map((s) => <tr key={s.id}><td className="td ltr-num">{s.installment_no}</td><td className="td">{date(s.due_date, locale)}</td><td className="td ltr-num">{money(s.amount_due)}</td><td className="td ltr-num">{money(s.amount_paid)}</td><td className="td"><InstallmentState state={s.state} /></td></tr>)}</tbody></table></div>
          )}
        </Card>
      )}

      {tab === "documents" && (
        <Card title={t("policy.documents")}>
          {p.documents.length === 0 ? <EmptyState title={t("documents.none")} text={t("documents.noneText")} /> : (
            <ul className="divide-y divide-slate-100">{p.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="text-sm font-semibold text-slate-800 truncate">{d.title}</p><p className="text-xs text-slate-400">{date(d.date, locale)}</p></div>
                <DownloadButton handle={d.id} fallbackName={`${d.title}.pdf`} available={d.available} /></li>))}</ul>
          )}
        </Card>
      )}

      {tab === "servicing" && p.segment === "family" && !p.restricted && (
        <Card title={t("family.servicing")}>
          <p className="text-xs text-slate-500 mb-4">{t("family.servicingNote")}</p>
          {p.actions.filter((a) => a.available).length === 0 ? <EmptyState title={t("family.noActions")} text={t("family.noActionsText")} /> : (
            <div className="grid sm:grid-cols-2 gap-3">{p.actions.filter((a) => a.available).map((a) => (
              <button key={a.kind} type="button" onClick={() => setDialog(a.kind as RequestKind)}
                className="card text-start px-4 py-3 hover:bg-blue-50/40 hover:border-blue-200 transition-colors">
                <span className="block text-sm font-semibold text-slate-800">{t(`request.kind.${a.kind}`)}</span>
                <span className="block text-xs text-slate-500 mt-0.5">{t(`request.hint.${a.kind}`)}</span></button>))}</div>)}
          {p.actions.some((a) => !a.available && a.reason === "POLICY_NOT_IN_FORCE") && <p className="text-xs text-slate-400 mt-4">{t("family.notInForceNote")}</p>}
        </Card>
      )}

      {tab === "activity" && (
        <Card title={t("policy.activity")}>
          {p.timeline.length === 0 ? <EmptyState title={t("policy.noActivity")} /> : (
            <ol className="relative border-s border-slate-200 ms-2 space-y-5">{p.timeline.map((e) => (
              <li key={e.id} className="ms-4"><span className="absolute -start-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-blue-500 ring-4 ring-white" aria-hidden="true" />
                <p className="text-sm font-semibold text-slate-800">{e.title}{e.detail?.amount ? <span className="text-slate-500 font-medium"> · {money(e.detail.amount)}</span> : null}</p>
                <p className="text-xs text-slate-400">{dateTime(e.at, locale)}{e.detail?.receipt_no ? ` · ${e.detail.receipt_no}` : ""}{e.detail?.claim_number ? ` · ${e.detail.claim_number}` : ""}</p></li>))}</ol>
          )}
        </Card>
      )}

      {dialog && p.family && <RequestModal familyId={p.family.family_id} kind={dialog} policy={{ id: p.id, policy_number: p.policy_number, sum_assured: p.sum_assured }}
        onClose={() => setDialog(null)} onDone={() => undefined} />}
    </div>
  );
}
