"use client";
import Link from "next/link";
import { Banner, Card, EmptyState, ErrorState, Icon, Skeleton } from "@/components/ui";
import { ActionCenter, ClaimLine, FamilyOverviewCard, PolicyTile, StatTile, actionItems } from "@/components/DashboardParts";
import { useApi } from "@/lib/api";
import { compactMoney, date, daysUntil, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Dashboard } from "@/lib/types";
import { initials } from "@/lib/format";

// The customer's home. Top to bottom: who they are and where they stand, the four figures that matter, what needs doing, their family
// (if they have one), their policies and their claims. Figures for individual policies and for a family are kept apart and labelled.

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const { data, error, loading, reload } = useApi<Dashboard>("dashboard");

  if (error && !data) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  const wait = loading && !data;
  const s = data?.summary;
  const polDown = !!data && !data.sections.policies;
  const clmDown = !!data && !data.sections.claims;
  const next = s?.next_premium;
  const nextDays = daysUntil(next?.date);
  const hasFamily = !!data?.family && data.family.length > 0;
  const actions = actionItems(data?.notices ?? []);
  const outstanding = s?.outstanding_amount ?? 0;
  const inForce = s?.in_force_policies ?? 0;
  const openClaims = s?.open_claims ?? 0;
  const firstName = (data?.customer.name || "").split(/\s+/)[0];

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-700 via-blue-600 to-blue-500 p-5 text-white shadow-[0_10px_30px_rgb(37,99,235,0.25)] sm:p-6" aria-label={t("dashboard.welcomeRegion")}>
        <div className="pointer-events-none absolute -end-10 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-20 start-1/3 h-48 w-48 rounded-full bg-sky-300/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-lg font-bold ring-1 ring-white/25 backdrop-blur" aria-hidden="true">{wait ? "…" : initials(data?.customer.name)}</span>
            <div className="min-w-0">
              {wait ? <Skeleton className="h-7 w-56 !bg-white/20" /> : <h2 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{t("dashboard.welcome", { name: firstName || data?.customer.name || "" })}</h2>}
              <p className="mt-0.5 truncate text-sm text-blue-100">
                {t("dashboard.policyholderId")}: <span className="font-semibold text-white ltr-num">{data?.customer.policyholder_id || "…"}</span>
                {data?.customer.company && <> · <bdi>{data.customer.company}</bdi></>}
              </p>
              {!wait && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold ring-1 ring-white/20"><span className={`h-1.5 w-1.5 rounded-full ${inForce > 0 ? "bg-emerald-300" : "bg-slate-300"}`} />{inForce > 0 ? t("dashboard.statusProtected", { count: inForce }) : t("dashboard.statusNoCover")}</span>
                  {actions.length > 0 && <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/90 px-2.5 py-1 text-xs font-bold text-amber-950"><Icon name="alert" className="h-3.5 w-3.5" />{t("dashboard.needsAttention", { count: actions.length })}</span>}
                  {data && data.unread_notices > 0 && <Link href="/notifications" className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold ring-1 ring-white/20 hover:bg-white/25"><Icon name="bell" className="h-3.5 w-3.5" />{t("dashboard.unreadCount", { count: data.unread_notices })}</Link>}
                </div>
              )}
            </div>
          </div>
          {next && !polDown && (
            <Link href="/payments" className="group rounded-xl bg-white/95 px-4 py-3 text-slate-900 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t("dashboard.nextPremium")}</p>
              <p className="text-lg font-bold leading-tight text-blue-700">{money(next.amount)}</p>
              <p className="text-xs text-slate-500">{date(next.date, locale)}{nextDays != null && nextDays >= 0 && nextDays <= 14 ? ` · ${t("dashboard.inDays", { count: nextDays })}` : ""}</p>
            </Link>
          )}
        </div>
      </section>

      {(polDown || clmDown) && (
        <Banner tone="warning" title={t("dashboard.partial")} action={<button type="button" onClick={reload} className="btn-secondary">{t("common.retry")}</button>}>
          {polDown ? t("dashboard.partialPolicies") : t("dashboard.partialClaims")}
        </Banner>
      )}

      {/* The four figures that matter */}
      <section aria-label={t("dashboard.headline")}>
        {hasFamily && <p className="section-label mb-2">{t("dashboard.individualScope")}</p>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <StatTile label={t("dashboard.activePolicies")} value={inForce} note={t("dashboard.ofTotal", { count: s?.total_policies ?? 0 })} icon="policies" tone={inForce > 0 ? "blue" : "muted"} href="/policies" loading={wait} unavailable={polDown} />
          <StatTile label={t("dashboard.coverage")} value={compactMoney(s?.coverage_total)} note={t("dashboard.coverageNote")} icon="shield" tone={(s?.coverage_total ?? 0) > 0 ? "emerald" : "muted"} href="/policies" loading={wait} unavailable={polDown} />
          <StatTile label={t("dashboard.nextPremium")} value={next ? money(next.amount) : t("dashboard.none")} note={next ? `${date(next.date, locale)} · ${next.policy_number}` : t("dashboard.noUpcoming")} icon="calendar"
            tone={!next ? "muted" : outstanding > 0 ? "red" : (nextDays ?? 99) <= 7 ? "amber" : "blue"} href="/payments" loading={wait} unavailable={polDown} />
          <StatTile label={t("dashboard.activeClaims")} value={openClaims > 0 ? openClaims : t("dashboard.noneOpen")} note={openClaims > 0 ? t("dashboard.openClaimsNote") : t("dashboard.noClaimsNote")} icon="claims" tone={openClaims > 0 ? "blue" : "muted"} href="/claims" loading={wait} unavailable={clmDown && s?.open_claims == null} />
        </div>
      </section>

      {/* What needs doing */}
      <ActionCenter items={actions} outstanding={outstanding} loading={wait} />

      {/* Family */}
      {data && !data.sections.family && <Banner tone="warning" title={t("dashboard.partialFamily")} />}
      {hasFamily && (
        <section aria-label={t("dashboard.family")} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="text-sm font-bold text-slate-900">{t("dashboard.family")}</p><p className="text-xs text-slate-500">{t("dashboard.familyScope")}</p></div>
            <Link href="/family" className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("common.viewAll")}</Link>
          </div>
          <div className="space-y-3">{data!.family!.map((g) => <FamilyOverviewCard key={g.id} g={g} />)}</div>
        </section>
      )}

      {/* Policies and claims */}
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-3 lg:col-span-2" aria-label={t("dashboard.yourPolicies")}>
          <div className="flex items-center justify-between"><p className="text-sm font-bold text-slate-900">{t("dashboard.yourPolicies")}</p><Link href="/policies" className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("common.viewAll")}</Link></div>
          {wait ? <div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
            : polDown ? <p className="text-sm text-slate-500">{t("dashboard.partialPolicies")}</p>
            : data && data.policies.length === 0 ? <div className="card"><EmptyState title={t("dashboard.noPolicies")} text={t("dashboard.noPoliciesText")} /></div>
            : <div className="grid gap-4 sm:grid-cols-2">{data?.policies.slice(0, 4).map((p) => <PolicyTile key={p.id} p={p} />)}</div>}
        </section>

        <Card title={t("dashboard.recentClaims")} action={<Link href="/claims" className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("common.viewAll")}</Link>}>
          {wait ? <Skeleton className="h-20" />
            : clmDown ? <p className="text-sm text-slate-500">{t("dashboard.partialClaims")}</p>
            : data && data.claims.length === 0 ? <EmptyState title={t("claims.none")} text={t("claims.noneText")} action={<Link href="/claims/new" className="btn-secondary">{t("claims.new")}</Link>} />
            : <ul className="-my-1 divide-y divide-slate-100">{data?.claims.slice(0, 4).map((c) => <ClaimLine key={c.id} c={c} />)}</ul>}
        </Card>
      </div>
    </div>
  );
}
