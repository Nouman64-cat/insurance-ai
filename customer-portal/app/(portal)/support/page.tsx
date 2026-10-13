"use client";
import Link from "next/link";
import { Card, ErrorState, KeyValue, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Profile } from "@/lib/types";

const FAQ = ["pay", "claim", "password", "details", "nominee"] as const;

export default function SupportPage() {
  const { t } = useI18n();
  const { data: p, error, loading, reload } = useApi<Profile>("profile");
  if (error && !p) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  const c = p?.tenant;
  return (
    <div className="space-y-5">
      <PageHeader title={t("support.title")} subtitle={t("support.subtitle")} />
      <div className="grid lg:grid-cols-2 gap-5">
        <Card title={c?.name || t("support.insurer")}>
          {loading && !p ? <Skeleton className="h-24" /> : (
            <>
              <KeyValue label={t("support.phone")}>{c?.contact_phone ? <a className="ltr-num text-blue-700 hover:underline" href={`tel:${c.contact_phone.replace(/\s/g, "")}`}>{c.contact_phone}</a> : t("support.notProvided")}</KeyValue>
              <KeyValue label={t("support.email")}>{c?.contact_email ? <a className="text-blue-700 hover:underline" href={`mailto:${c.contact_email}`}>{c.contact_email}</a> : t("support.notProvided")}</KeyValue>
              {c?.address && <KeyValue label={t("support.office")}>{c.address}</KeyValue>}
              {c?.website && <KeyValue label={t("support.website")}><span className="ltr-num">{c.website}</span></KeyValue>}
              <p className="text-xs text-slate-400 pt-3">{t("support.quote", { policyholder: p?.policyholder_id || p?.username || "" })}</p>
            </>)}
        </Card>
        <Card title={t("support.faq")}>
          <dl className="space-y-4">{FAQ.map((k) => (
            <div key={k}><dt className="text-sm font-bold text-slate-800">{t(`support.faq.${k}.q`)}</dt><dd className="text-sm text-slate-500 mt-0.5">{t(`support.faq.${k}.a`)}</dd></div>))}</dl>
          <div className="mt-4 flex gap-2"><Link href="/claims/new" className="btn-secondary">{t("claims.new")}</Link><Link href="/payments" className="btn-secondary">{t("nav.payments")}</Link></div>
        </Card>
      </div>
    </div>
  );
}
