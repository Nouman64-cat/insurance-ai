"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Banner, ClaimStatus, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { SegmentTabs, useSegment } from "@/components/SegmentTabs";
import { Suspense } from "react";
import { date, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { ClaimRow } from "@/lib/types";

function ClaimsInner() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [segment, setSegment, hasFamily] = useSegment();
  const { data, error, loading, reload } = useApi<{ items: ClaimRow[] }>(segment === "family" ? "claims?segment=family" : "claims");
  return (
    <div>
      <PageHeader title={t("claims.title")} subtitle={t("claims.subtitle")} actions={<Link href="/claims/new" className="btn-primary">{t("claims.new")}</Link>} />
      {hasFamily && <SegmentTabs segment={segment} onChange={setSegment} />}
      <div className="mb-4"><Banner tone="info" title={t("claims.death.title")}>{t("claims.death.text")}</Banner></div>
      {error && !data ? <div className="card"><ErrorState error={error} onRetry={reload} /></div>
        : loading && !data ? <Skeleton className="h-48" />
        : (data?.items.length ?? 0) === 0 ? <div className="card"><EmptyState title={t("claims.none")} text={t("claims.noneText")} action={<Link href="/claims/new" className="btn-primary">{t("claims.new")}</Link>} /></div>
        : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead><tr><th className="th">{t("claims.number")}</th><th className="th">{t("claims.policy")}</th><th className="th">{t("claims.type")}</th><th className="th">{t("claims.incident")}</th><th className="th">{t("claims.claimed")}</th><th className="th">{t("claims.approved")}</th><th className="th">{t("claims.status")}</th></tr></thead>
              <tbody>{data?.items.map((c) => (
                <tr key={c.id} tabIndex={0} role="link" onClick={() => router.push(`/claims/${c.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/claims/${c.id}`)} className="cursor-pointer hover:bg-blue-50/40 focus-visible:bg-blue-50/60">
                  <td className="td font-semibold text-slate-900 ltr-num">{c.claim_number}</td>
                  <td className="td ltr-num">{c.policy_number}{c.covered_person?.name && <span className="block text-[10px] text-slate-400"><bdi>{c.covered_person.name}</bdi></span>}</td>
                  <td className="td">{c.category ? t(`claimType.${c.category}`) : c.claim_type}</td>
                  <td className="td">{date(c.incident_date, locale)}</td>
                  <td className="td ltr-num">{money(c.claimed_amount)}</td>
                  <td className="td ltr-num">{c.approved_amount != null ? money(c.approved_amount) : "—"}{c.settled_amount ? <span className="block text-[10px] text-emerald-700">{t("claims.paidOut", { amount: money(c.settled_amount) })}</span> : null}</td>
                  <td className="td"><ClaimStatus statusKey={c.status_key} /></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
    </div>
  );
}

export default function ClaimsPage() { return <Suspense><ClaimsInner /></Suspense>; }
