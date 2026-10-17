"use client";
import Link from "next/link";
import { SupportTickets } from "@/components/SupportTickets";
import { Card, ErrorState, Icon, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Profile } from "@/lib/types";

const FAQ = ["pay", "claim", "password", "details", "nominee"] as const;

/** One way to reach the insurer: an icon, what it is, and the value as a link when it can be. */
function ContactRow({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600" aria-hidden="true"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
      <div className="min-w-0"><p className="text-xs font-medium text-slate-400">{label}</p><div className="break-words text-sm font-semibold text-slate-800">{children}</div></div>
    </div>
  );
}

export default function SupportPage() {
  const { t } = useI18n();
  const { data: p, error, loading, reload } = useApi<Profile>("profile");
  if (error && !p) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  const c = p?.tenant;
  return (
    <div className="space-y-6">
      <PageHeader title={t("support.helpCenter")} subtitle={t("support.helpSubtitle")} />
      <SupportTickets />

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="lg:col-span-3" aria-labelledby="faq-title">
          <h3 id="faq-title" className="mb-3 text-sm font-bold text-slate-900">{t("support.faq")}</h3>
          <div className="space-y-2">
            {FAQ.map((k) => (
              <details key={k} className="group rounded-2xl border border-slate-200/80 bg-white shadow-[0_2px_12px_rgb(15,23,42,0.03)] open:border-blue-200 open:shadow-[0_6px_20px_rgb(37,99,235,0.08)]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-sm font-semibold text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
                  {t(`support.faq.${k}.q`)}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-180 group-open:text-blue-600" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </summary>
                <p className="px-4 pb-4 text-sm leading-relaxed text-slate-600">{t(`support.faq.${k}.a`)}</p>
              </details>))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2"><Link href="/claims/new" className="btn-secondary">{t("claims.new")}</Link><Link href="/payments" className="btn-secondary">{t("nav.payments")}</Link></div>
        </section>

        <Card className="lg:col-span-2 self-start" title={c?.name || t("support.insurer")}>
          {loading && !p ? <Skeleton className="h-40" /> : (
            <div className="divide-y divide-slate-100">
              <ContactRow icon="support" label={t("support.phone")}>{c?.contact_phone ? <a className="ltr-num text-blue-700 hover:underline" href={`tel:${c.contact_phone.replace(/\s/g, "")}`}>{c.contact_phone}</a> : <span className="font-medium text-slate-400">{t("support.notProvided")}</span>}</ContactRow>
              <ContactRow icon="bell" label={t("support.email")}>{c?.contact_email ? <a className="text-blue-700 hover:underline" href={`mailto:${c.contact_email}`}>{c.contact_email}</a> : <span className="font-medium text-slate-400">{t("support.notProvided")}</span>}</ContactRow>
              {c?.address && <ContactRow icon="shield" label={t("support.office")}>{c.address}</ContactRow>}
              {c?.website && <ContactRow icon="download" label={t("support.website")}><span className="ltr-num">{c.website}</span></ContactRow>}
              <p className="pt-3 text-xs text-slate-500">{t("support.quote", { policyholder: p?.policyholder_id || p?.username || "" })}</p>
            </div>)}
        </Card>
      </div>
    </div>
  );
}
