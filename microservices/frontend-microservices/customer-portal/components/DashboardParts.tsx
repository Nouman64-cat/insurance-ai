"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { compactMoney, date, daysUntil, money } from "@/lib/format";
import type { ClaimRow, FamilyGroupSummary, Notice, PolicyCard } from "@/lib/types";
import { noticeVars } from "./NoticeRow";
import { ClaimStatus, Icon, PolicyStatus } from "./ui";

// Building blocks of the dashboard. Every number comes from the dashboard API; nothing here computes or invents one.

const TONES = {
  blue: { chip: "bg-blue-50 text-blue-600", value: "text-slate-900", ring: "hover:border-blue-200" },
  emerald: { chip: "bg-emerald-50 text-emerald-600", value: "text-slate-900", ring: "hover:border-emerald-200" },
  amber: { chip: "bg-amber-50 text-amber-600", value: "text-amber-700", ring: "border-amber-200 hover:border-amber-300" },
  red: { chip: "bg-rose-50 text-rose-600", value: "text-rose-700", ring: "border-rose-200 hover:border-rose-300" },
  muted: { chip: "bg-slate-100 text-slate-400", value: "text-slate-400", ring: "hover:border-slate-300" },
} as const;
export type StatTone = keyof typeof TONES;

/** One headline figure. A zero reads as muted ("nothing here") so the figures that matter stand out. */
export function StatTile({ label, value, note, icon, tone = "blue", href, loading, unavailable }: {
  label: string; value: ReactNode; note?: ReactNode; icon: string; tone?: StatTone; href?: string; loading?: boolean; unavailable?: boolean;
}) {
  const c = TONES[tone];
  const body = (
    <div className={`group h-full rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_12px_rgb(15,23,42,0.04)] transition-all duration-200 ${href ? `hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgb(15,23,42,0.08)] ${c.ring}` : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold text-slate-500">{label}</p>
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${c.chip}`} aria-hidden="true"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
      </div>
      <div className="mt-2 min-h-[34px]">
        {loading ? <div className="h-7 w-24 animate-pulse rounded-md bg-slate-200/70" />
          : unavailable ? <p className="text-2xl font-bold text-slate-300">—</p>
          : <p className={`truncate text-[1.65rem] font-bold leading-tight tracking-tight ${c.value}`}>{value}</p>}
      </div>
      {note && <p className="mt-1 truncate text-xs text-slate-500">{note}</p>}
    </div>
  );
  return href ? <Link href={href} className="block min-w-0 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{body}</Link> : <div className="min-w-0">{body}</div>;
}

const ACTIONABLE = ["premium_overdue", "premium_due", "claim_documents_needed", "policy_expiry", "policy_lapsed"] as const;
const SEVERITY_RANK: Record<Notice["severity"], number> = { critical: 0, warning: 1, info: 2, success: 3 };

/** What needs the customer to do something, taken from their real notifications (overdue and due premiums, claim documents, expiries). */
export function actionItems(notices: Notice[]): Notice[] {
  return notices.filter((n) => (ACTIVE_KINDS as readonly string[]).includes(n.kind)).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
const ACTIVE_KINDS = ACTIONABLE;

export function ActionCenter({ items, outstanding, loading }: { items: Notice[]; outstanding: number; loading: boolean }) {
  const { t, locale } = useI18n();
  const cta = (n: Notice): { href: string; label: string } =>
    n.kind.startsWith("premium_") ? { href: "/payments", label: t("dashboard.act.pay") }
      : n.kind === "claim_documents_needed" && n.claim_id ? { href: `/claims/${n.claim_id}`, label: t("dashboard.act.upload") }
      : { href: n.policy_id ? `/policies/${n.policy_id}` : "/policies", label: t("dashboard.act.view") };
  const dot: Record<Notice["severity"], string> = { critical: "bg-rose-500", warning: "bg-amber-500", info: "bg-blue-500", success: "bg-emerald-500" };
  const chip: Record<Notice["severity"], string> = { critical: "bg-rose-50 text-rose-600", warning: "bg-amber-50 text-amber-600", info: "bg-blue-50 text-blue-600", success: "bg-emerald-50 text-emerald-600" };
  const urgent = items.length > 0;
  return (
    <section aria-labelledby="action-center" className={`overflow-hidden rounded-2xl border bg-white shadow-[0_2px_12px_rgb(15,23,42,0.04)] ${urgent ? "border-amber-200" : "border-slate-200/80"}`}>
      <header className={`flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 ${urgent ? "bg-gradient-to-r from-amber-50 to-white" : "border-b border-slate-100"}`}>
        <div className="flex items-center gap-2.5">
          <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${urgent ? "bg-amber-100 text-amber-700" : "bg-emerald-50 text-emerald-600"}`} aria-hidden="true"><Icon name={urgent ? "alert" : "check"} className="h-4 w-4" /></span>
          <h3 id="action-center" className="text-sm font-bold text-slate-900">{t("dashboard.actionRequired")}{urgent && <span className="ms-2 rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">{items.length}</span>}</h3>
        </div>
        {outstanding > 0 && <p className="text-xs font-semibold text-rose-700">{t("dashboard.dueNowAmount", { amount: money(outstanding) })}</p>}
      </header>
      {loading ? <div className="space-y-3 p-5"><div className="h-10 animate-pulse rounded-lg bg-slate-100" /><div className="h-10 animate-pulse rounded-lg bg-slate-100" /></div>
        : !urgent ? <p className="px-5 py-5 text-sm text-slate-500">{t("dashboard.allCaughtUp")}</p>
        : (
          <ul className="divide-y divide-slate-100">
            {items.slice(0, 5).map((n) => {
              const v = noticeVars(n.params, locale), a = cta(n);
              return (
                <li key={n.key} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${chip[n.severity]}`} aria-hidden="true"><Icon name={n.kind.startsWith("premium_") ? "payments" : n.kind.startsWith("claim") ? "claims" : "calendar"} className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-semibold text-slate-800"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[n.severity]}`} aria-hidden="true" /><span className="truncate">{t(`notice.${n.kind}.title`, v)}</span></p>
                    <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{t(`notice.${n.kind}.text`, v)}</p>
                  </div>
                  <Link href={a.href} className="btn-primary !px-3.5 !py-1.5 text-xs">{a.label}</Link>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

/** A policy as a compact tile: what it is, its state, the figures that matter, and the next thing to do with it. */
export function PolicyTile({ p }: { p: PolicyCard }) {
  const { t, locale } = useI18n();
  const dueIn = daysUntil(p.premium.next_due_date);
  const payable = p.in_force && !!p.premium.next_due_date && (dueIn ?? 99) <= 30 && p.access !== "summary";
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_12px_rgb(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgb(15,23,42,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{p.product_name}</p>
          <p className="mt-0.5 text-xs text-slate-400 ltr-num">{p.policy_number || t("policies.numberPending")}</p>
        </div>
        <PolicyStatus statusKey={p.status_key} />
      </div>
      {p.family && <p className="mt-2"><span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">{t(`plan.${p.family.plan_type}`)}</span></p>}
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-slate-400">{t("policies.sumAssured")}</dt><dd className="mt-0.5 text-sm font-bold text-slate-900">{compactMoney(p.sum_assured)}</dd></div>
        <div><dt className="text-slate-400">{t("policies.premium")}</dt><dd className="mt-0.5 text-sm font-bold text-slate-900">{p.installment_amount != null ? money(p.installment_amount) : "—"}{p.premium_frequency && <span className="font-medium text-slate-400"> / {t(`frequency.${p.premium_frequency}`)}</span>}</dd></div>
      </dl>
      {p.in_force && p.premium.next_due_date && (
        <p className={`mt-3 rounded-lg px-2.5 py-1.5 text-xs ${payable && (dueIn ?? 99) <= 7 ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-600"}`}>
          {t("policies.nextDue")}: <bdi className="font-semibold">{date(p.premium.next_due_date, locale)}</bdi> · <bdi className="font-semibold">{money(p.premium.next_due_amount)}</bdi>
        </p>
      )}
      <div className="mt-auto flex items-center gap-2 pt-4">
        <Link href={`/policies/${p.id}`} className="btn-secondary flex-1 !py-1.5 text-xs">{t("dashboard.act.details")}</Link>
        {payable && <Link href="/payments" className="btn-primary flex-1 !py-1.5 text-xs">{t("dashboard.act.pay")}</Link>}
      </div>
    </article>
  );
}

export function ClaimLine({ c }: { c: ClaimRow }) {
  const { t, locale } = useI18n();
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500" aria-hidden="true"><Icon name="claims" className="h-[18px] w-[18px]" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-800 ltr-num">{c.claim_number}</p>
        <p className="truncate text-xs text-slate-400"><bdi>{c.category ? t(`claimType.${c.category}`) : c.claim_type}</bdi> · <bdi>{date(c.reported_date, locale)}</bdi></p>
      </div>
      <ClaimStatus statusKey={c.status_key} />
      <Link href={`/claims/${c.id}`} className="btn-secondary !px-3 !py-1.5 text-xs">{t("dashboard.act.track")}</Link>
    </li>
  );
}

/** A family as a compact overview. Its figures are the family's own and are labelled so: they are not part of the individual totals. */
export function FamilyOverviewCard({ g }: { g: FamilyGroupSummary }) {
  const { t, locale } = useI18n();
  const next = g.totals.next_premium;
  const stat = (label: string, value: ReactNode, tone = "text-slate-900") => (
    <div className="min-w-0"><dt className="truncate text-xs text-slate-500">{label}</dt><dd className={`mt-0.5 truncate text-lg font-bold ${tone}`}>{value}</dd></div>
  );
  return (
    <Link href={`/family/${g.id}`} className="group block overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50/70 via-white to-white p-5 shadow-[0_2px_12px_rgb(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgb(15,23,42,0.08)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm" aria-hidden="true"><Icon name="family" className="h-5 w-5" /></span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-slate-900">{g.name}</p>
            <p className="truncate text-xs text-slate-500">{g.plan_types.map((p) => t(`plan.${p}`)).join(" · ")} · {t(`family.role.${g.role}`)}</p>
          </div>
        </div>
        <span className="text-xs font-semibold text-blue-600 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5">{t("family.open")} →</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-blue-100/80 pt-4 lg:grid-cols-4">
        {stat(t("family.members"), <>{g.members.listed}<span className="ms-1.5 text-xs font-medium text-slate-400">{t("family.insuredCount", { count: g.members.insured })}</span></>)}
        {stat(t("family.coverage"), compactMoney(g.totals.coverage), "text-emerald-700")}
        {stat(t("dashboard.nextPremium"), next ? money(next.amount) : t("dashboard.none"), next ? "text-slate-900" : "text-slate-400")}
        {stat(t("dashboard.outstanding"), money(g.totals.outstanding), g.totals.outstanding > 0 ? "text-rose-700" : "text-slate-400")}
      </dl>
      <p className="mt-3 text-[11px] text-slate-500">
        {next && <>{date(next.date, locale)} · <span className="ltr-num">{next.policy_number}</span> · </>}{t("family.openClaimsLine", { count: g.totals.open_claims })}
      </p>
      {g.totals.renewals_soon.length > 0 && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{t("family.renewalSoon", { policy: g.totals.renewals_soon[0].policy_number, date: date(g.totals.renewals_soon[0].date, locale) })}</p>}
    </Link>
  );
}
