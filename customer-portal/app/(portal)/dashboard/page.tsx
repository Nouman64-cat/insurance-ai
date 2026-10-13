"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Banner, Card, EmptyState, ErrorState, Icon, Skeleton } from "@/components/ui";
import { ClaimStatus } from "@/components/ui";
import { MetricCard } from "@/components/MetricCard";
import { PolicyCardItem } from "@/components/PolicyCardItem";
import { useApi } from "@/lib/api";
import { compactMoney, date, daysUntil, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Dashboard } from "@/lib/types";
import { NoticeRow } from "@/components/NoticeRow";

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const { data, error, loading, reload } = useApi<Dashboard>("dashboard");
  const router = useRouter();

  if (error && !data) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  const s = data?.summary;
  const polDown = !!data && !data.sections.policies;
  const clmDown = !!data && !data.sections.claims;
  const nextExpiry = s?.upcoming_expiry?.[0];
  const next = s?.next_premium;
  const nextDays = daysUntil(next?.date);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {loading && !data ? <Skeleton className="h-7 w-64" /> : <h2 className="text-xl font-bold tracking-tight text-slate-900">{t("dashboard.welcome", { name: data?.customer.name || "" })}</h2>}
          <p className="text-sm text-slate-500 mt-0.5">
            {t("dashboard.policyholderId")}: <span className="font-semibold text-slate-700 ltr-num">{data?.customer.policyholder_id || "…"}</span>
            {data?.customer.company && <> · <bdi>{data.customer.company}</bdi></>}
          </p>
        </div>
      </div>

      {(polDown || clmDown) && (
        <Banner tone="warning" title={t("dashboard.partial")} action={<button type="button" onClick={reload} className="btn-secondary">{t("common.retry")}</button>}>
          {polDown ? t("dashboard.partialPolicies") : t("dashboard.partialClaims")}
        </Banner>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title={t("dashboard.totalPolicies")} value={s?.total_policies ?? 0} accent="blue" loading={loading && !data} unavailable={polDown} icon={<Icon name="policies" />}
          subtitle={t("dashboard.activeCount", { count: s?.active_policies ?? 0 })} />
        <MetricCard title={t("dashboard.coverage")} value={compactMoney(s?.coverage_total)} accent="emerald" loading={loading && !data} unavailable={polDown} icon={<Icon name="shield" />}
          subtitle={t("dashboard.coverageNote")} />
        <MetricCard title={t("dashboard.nextPremium")} value={next ? money(next.amount) : t("dashboard.none")} accent={next && (nextDays ?? 99) <= 7 ? "amber" : "sky"} loading={loading && !data} unavailable={polDown} icon={<Icon name="calendar" />}
          subtitle={next ? `${date(next.date, locale)} · ${next.policy_number}` : t("dashboard.noUpcoming")} />
        <MetricCard title={t("dashboard.outstanding")} value={money(s?.outstanding_amount ?? 0)} accent={(s?.outstanding_amount ?? 0) > 0 ? "red" : "slate"} loading={loading && !data} unavailable={polDown} icon={<Icon name="money" />}
          subtitle={(s?.outstanding_amount ?? 0) > 0 ? t("dashboard.outstandingDue") : t("dashboard.nothingDue")} />
        <MetricCard title={t("dashboard.openClaims")} value={s?.open_claims ?? 0} accent="slate" loading={loading && !data} unavailable={clmDown && s?.open_claims == null} icon={<Icon name="claims" />}
          subtitle={t("dashboard.openClaimsNote")} />
        <MetricCard title={t("dashboard.expiry")} value={nextExpiry ? date(nextExpiry.date, locale) : t("dashboard.none")} accent={nextExpiry ? "amber" : "slate"} loading={loading && !data} unavailable={polDown} icon={<Icon name="calendar" />}
          subtitle={nextExpiry ? nextExpiry.policy_number : t("dashboard.noExpiry")} />
        <MetricCard title={t("dashboard.remaining")} value={money(s?.remaining_amount ?? 0)} accent="slate" loading={loading && !data} unavailable={polDown} icon={<Icon name="payments" />}
          subtitle={t("dashboard.remainingNote")} />
        <MetricCard title={t("dashboard.inForce")} value={s?.in_force_policies ?? 0} accent="emerald" loading={loading && !data} unavailable={polDown} icon={<Icon name="check" />}
          subtitle={t("dashboard.inForceNote")} />
      </div>

      <div>
        <p className="section-label mb-2">{t("dashboard.quickActions")}</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[{ href: "/policies", k: "viewPolicies", i: "policies" }, { href: "/payments", k: "viewPayments", i: "payments" }, { href: "/claims", k: "viewClaims", i: "claims" }, { href: "/documents", k: "downloadDocuments", i: "download" }].map((a) => (
            <Link key={a.href} href={a.href} className="card min-w-0 px-4 py-3.5 flex items-center gap-3 hover:bg-blue-50/40 hover:border-blue-200 transition-colors">
              <span className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><Icon name={a.i} className="w-5 h-5" /></span>
              <span className="text-sm font-semibold text-slate-800 min-w-0">{t(`dashboard.action.${a.k}`)}</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card title={t("dashboard.yourPolicies")} action={<Link href="/policies" className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("common.viewAll")}</Link>}>
            {loading && !data ? <div className="grid sm:grid-cols-2 gap-4"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
              : polDown ? <p className="text-sm text-slate-500">{t("dashboard.partialPolicies")}</p>
              : data && data.policies.length === 0 ? <EmptyState title={t("dashboard.noPolicies")} text={t("dashboard.noPoliciesText")} />
              : <div className="grid sm:grid-cols-2 gap-4">{data?.policies.slice(0, 4).map((p) => <PolicyCardItem key={p.id} p={p} />)}</div>}
          </Card>

          <Card title={t("dashboard.recentClaims")} action={<Link href="/claims" className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("common.viewAll")}</Link>}>
            {loading && !data ? <Skeleton className="h-16" />
              : clmDown ? <p className="text-sm text-slate-500">{t("dashboard.partialClaims")}</p>
              : data && data.claims.length === 0 ? <EmptyState title={t("claims.none")} text={t("claims.noneText")} />
              : <ul className="divide-y divide-slate-100">{data?.claims.map((c) => (
                  <li key={c.id}><button type="button" onClick={() => router.push(`/claims/${c.id}`)} className="w-full flex items-center justify-between gap-3 py-3 text-start hover:bg-slate-50 rounded-lg px-2 -mx-2">
                    <span className="min-w-0"><span className="block text-sm font-semibold text-slate-800 ltr-num">{c.claim_number}</span><span className="block text-xs text-slate-400 truncate"><bdi>{c.category ? t(`claimType.${c.category}`) : c.claim_type}</bdi> · <bdi>{date(c.reported_date, locale)}</bdi></span></span>
                    <ClaimStatus statusKey={c.status_key} /></button></li>))}</ul>}
          </Card>
        </div>

        <Card title={t("dashboard.notices")} action={<Link href="/notifications" className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("common.viewAll")}</Link>}>
          {loading && !data ? <Skeleton className="h-24" />
            : !data || data.notices.length === 0 ? <EmptyState title={t("notifications.none")} text={t("notifications.noneText")} icon={<Icon name="bell" className="w-6 h-6" />} />
            : <ul className="space-y-3">{data.notices.map((n) => <NoticeRow key={n.key} n={n} compact />)}</ul>}
        </Card>
      </div>
    </div>
  );
}
