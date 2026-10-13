"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Banner, Card, EmptyState, ErrorState, InstallmentState, KeyValue, PageHeader, PolicyStatus, Skeleton } from "@/components/ui";
import { DownloadButton } from "@/components/DownloadButton";
import { ApiError, useApi } from "@/lib/api";
import { compactMoney, date, dateTime, daysUntil, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { PolicyDetail } from "@/lib/types";

const TABS = ["overview", "coverage", "premiums", "documents", "activity"] as const;

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
  const [tab, setTab] = useState<(typeof TABS)[number]>("overview");

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
        subtitle={<><span className="ltr-num">{p.policy_number || t("policies.numberPending")}</span> · <PolicyStatus statusKey={p.status_key} /></>}
        actions={<>
          <Link href="/policies" className="btn-secondary">{t("policy.backToPolicies")}</Link>
          {p.in_force && <Link href={`/claims/new?policy=${p.id}`} className="btn-secondary">{t("policy.fileClaim")}</Link>}
          {p.in_force && <Link href="/payments" className="btn-primary">{t("policy.premiums")}</Link>}
        </>} />
      <StatusBanner p={p} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[{ k: "sumAssured", v: compactMoney(p.sum_assured) }, { k: "premium", v: p.installment_amount != null ? `${money(p.installment_amount)} / ${t(`frequency.${p.premium_frequency}`)}` : "—" },
          { k: "effective", v: date(p.effective_date, locale) }, { k: "expiry", v: date(p.expiry_date || p.maturity_date, locale) }].map((x) => (
          <div key={x.k} className="card min-w-0 px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">{t(`policies.${x.k}`)}</p><p className="text-lg font-black text-slate-900 mt-1">{x.v}</p></div>
        ))}
      </div>

      <div role="tablist" aria-label={t("policy.sections")} className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === k ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{t(`policy.tab.${k}`)}</button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid lg:grid-cols-2 gap-5">
          <Card title={t("policy.policyholder")}>
            <KeyValue label={t("profile.name")}>{p.policyholder.name}</KeyValue>
            <KeyValue label={t("profile.policyholderId")}><span className="ltr-num">{p.policyholder.policyholder_id}</span></KeyValue>
            <KeyValue label={t("profile.cnic")}><span className="ltr-num">{p.policyholder.cnic_masked}</span></KeyValue>
            <KeyValue label={t("profile.dob")}>{date(p.policyholder.dob, locale)}</KeyValue>
            <KeyValue label={t("profile.email")}>{p.policyholder.email}</KeyValue>
            <KeyValue label={t("profile.phone")}><span className="ltr-num">{p.policyholder.phone}</span></KeyValue>
          </Card>
          <Card title={t("policy.insured")}>
            <KeyValue label={t("profile.name")}>{p.insured.name}</KeyValue>
            <KeyValue label={t("policy.relationship")}>{p.insured.relationship === "Self" ? t("policy.self") : p.insured.relationship}</KeyValue>
            <KeyValue label={t("profile.dob")}>{date(p.insured.dob, locale)}</KeyValue>
          </Card>
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
    </div>
  );
}
