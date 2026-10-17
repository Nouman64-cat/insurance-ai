"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { Banner, Card, EmptyState, ErrorState, InstallmentState, PageHeader, PolicyStatus, Skeleton, tOr } from "@/components/ui";
import { DownloadButton } from "@/components/DownloadButton";
import { MetricCard } from "@/components/MetricCard";
import { PayModal } from "@/components/PayModal";
import { Icon } from "@/components/ui";
import { SegmentTabs, useSegment } from "@/components/SegmentTabs";
import { useApi } from "@/lib/api";
import { date, dateTime, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Installment, PaymentsOverview, PolicyCard } from "@/lib/types";

function PaymentsInner() {
  const { t, locale } = useI18n();
  const [segment, setSegment, hasFamily] = useSegment();
  const { data, error, loading, reload } = useApi<PaymentsOverview>(segment === "family" ? "payments?segment=family" : "payments");
  const [paying, setPaying] = useState<{ policy: PolicyCard; installment: Installment } | null>(null);

  if (error && !data) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  const rows = data?.policies || [];
  const withSchedule = rows.filter((r) => r.premiums && r.premiums.installments.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader title={t("payments.title")} subtitle={t("payments.subtitle")} />
      {hasFamily && <SegmentTabs segment={segment} onChange={setSegment} />}
      {segment === "family" && <Banner tone="info">{t("family.paymentsNote")}</Banner>}
      {data?.simulated_payments && <Banner tone="warning" title={t("pay.simulated.title")}>{t("pay.simulated.text")}</Banner>}
      {data && !data.payments_enabled && <Banner tone="info">{t("payments.disabled")}</Banner>}
      {data?.partial && <Banner tone="warning" title={t("payments.partial")} action={<button type="button" className="btn-secondary" onClick={reload}>{t("common.retry")}</button>} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title={t("payments.totalPaid")} value={money(data?.totals.total_paid)} accent="emerald" loading={loading && !data} icon={<Icon name="check" />} subtitle={t("payments.receiptsCount", { count: data?.history.length ?? 0 })} />
        <MetricCard title={t("payments.dueNow")} value={money(data?.totals.outstanding)} accent={(data?.totals.outstanding ?? 0) > 0 ? "red" : "slate"} loading={loading && !data} icon={<Icon name="alert" />}
          subtitle={(data?.totals.overdue ?? 0) > 0 ? t("payments.overdue", { amount: money(data?.totals.overdue) }) : t("payments.nothingDue")} />
        <MetricCard title={t("payments.nextDue")} value={data?.totals.next_due ? money(data.totals.next_due.amount) : t("dashboard.none")} accent="sky" loading={loading && !data} icon={<Icon name="calendar" />}
          subtitle={data?.totals.next_due ? `${date(data.totals.next_due.date, locale)} · ${data.totals.next_due.policy_number}` : t("dashboard.noUpcoming")} />
        <MetricCard title={t("payments.remaining")} value={money(data?.totals.remaining)} accent="slate" loading={loading && !data} icon={<Icon name="payments" />} subtitle={t("payments.remainingNote")} />
      </div>

      {loading && !data ? <Skeleton className="h-64" />
        : rows.length === 0 ? <div className="card"><EmptyState title={t("payments.noPolicies")} text={t("payments.noPoliciesText")} /></div>
        : (
          <div className="space-y-5">
            {withSchedule.length === 0 && <div className="card"><EmptyState title={t("payments.noSchedule")} text={t("payments.noScheduleText")} /></div>}
            {withSchedule.map(({ policy, premiums }) => premiums && (
              <Card key={policy.id} title={<span className="flex flex-wrap items-center gap-2"><Link href={`/policies/${policy.id}`} className="hover:text-blue-700">{policy.product_name} · <span className="ltr-num">{policy.policy_number}</span></Link><PolicyStatus statusKey={policy.status_key} />
                {policy.family && <span className="text-xs font-medium text-slate-400">{t(`plan.${policy.family.plan_type}`)}{policy.holder_name ? ` · ${policy.holder_name}` : ""}</span>}</span>}
                action={<span className="text-xs text-slate-400">{t("payments.progress", { paid: premiums.summary.paid, total: premiums.summary.total })}</span>}>
                {premiums.summary.in_grace && <div className="mb-4"><Banner tone="warning" title={t("payments.grace.title")}>{t("payments.grace.text", { date: date(premiums.summary.grace_until, locale), days: premiums.summary.grace_days_left ?? 0 })}</Banner></div>}
                {!policy.in_force && !policy.pending_issuance && <div className="mb-4"><Banner tone="info">{t("payments.notInForce")}</Banner></div>}
                <div className="overflow-x-auto -mx-5">
                  <table className="w-full"><thead><tr><th className="th">#</th><th className="th">{t("payments.dueDate")}</th><th className="th">{t("payments.amount")}</th><th className="th">{t("payments.status")}</th><th className="th">{t("payments.paidOn")}</th><th className="th" /></tr></thead>
                    <tbody>{premiums.installments.map((i) => (
                      <tr key={i.id} className={i.state === "past_grace" || i.state === "grace" ? "bg-amber-50/40" : ""}>
                        <td className="td ltr-num">{i.installment_no}</td>
                        <td className="td">{date(i.due_date, locale)}</td>
                        <td className="td ltr-num font-semibold">{money(i.status === "Paid" ? i.amount_paid || i.amount_due : i.payable)}{i.surcharge > 0 && <span className="block text-[10px] font-medium text-amber-700">{t("payments.incSurcharge", { amount: money(i.surcharge) })}</span>}</td>
                        <td className="td"><InstallmentState state={i.state} /></td>
                        <td className="td">{i.paid_at ? date(i.paid_at, locale) : "—"}</td>
                        <td className="td text-end">{i.payable_now && data?.payments_enabled
                          ? <button type="button" className="btn-primary !py-1.5 !min-h-0 text-xs" onClick={() => setPaying({ policy, installment: i })}>{t("payments.pay")}</button>
                          : i.receipt ? <DownloadButton handle={`receipt:${policy.id}:${premiums.receipts.find((r) => r.receipt_no === i.receipt?.receipt_no)?.id ?? ""}`} fallbackName={`${i.receipt.receipt_no}.pdf`} label={t("payments.receipt")} available={!!premiums.receipts.find((r) => r.receipt_no === i.receipt?.receipt_no)?.has_document} /> : null}</td>
                      </tr>))}</tbody></table>
                </div>
              </Card>
            ))}

            <Card title={t("payments.history")}>
              {(data?.history.length ?? 0) === 0 ? <EmptyState title={t("payments.noHistory")} text={t("payments.noHistoryText")} /> : (
                <div className="overflow-x-auto -mx-5"><table className="w-full"><thead><tr><th className="th">{t("payments.receipt")}</th><th className="th">{t("pay.policy")}</th><th className="th">{t("payments.paidOn")}</th><th className="th">{t("payments.method")}</th><th className="th">{t("payments.amount")}</th><th className="th" /></tr></thead>
                  <tbody>{data?.history.map((r) => (
                    <tr key={r.id}><td className="td ltr-num font-semibold">{r.receipt_no}</td><td className="td ltr-num">{r.policy_number}</td><td className="td">{dateTime(r.paid_at, locale)}</td>
                      <td className="td">{tOr(t, `pay.methods.${r.method}`, r.method)}</td><td className="td ltr-num font-semibold">{money(r.total)}</td>
                      <td className="td text-end"><DownloadButton handle={`receipt:${r.policy_id}:${r.id}`} fallbackName={`${r.receipt_no}.pdf`} available={r.has_document} /></td></tr>))}</tbody></table></div>
              )}
            </Card>
          </div>
        )}

      {paying && <PayModal policy={paying.policy} installment={paying.installment} onClose={() => setPaying(null)} onPaid={reload} />}
    </div>
  );
}

export default function PaymentsPage() { return <Suspense><PaymentsInner /></Suspense>; }
