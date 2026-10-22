"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Banner, Card, ClaimStatus, EmptyState, ErrorState, KeyValue, PageHeader, Skeleton, Spinner, errorText, useToast } from "@/components/ui";
import { ApiError, api, useApi } from "@/lib/api";
import { date, dateTime, money, newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { ClaimDetail } from "@/lib/types";

const STEP_STYLE: Record<string, string> = {
  complete: "bg-emerald-500 text-white border-emerald-500", current: "bg-blue-600 text-white border-blue-600", attention: "bg-amber-500 text-white border-amber-500",
  skipped: "bg-slate-200 text-slate-500 border-slate-200", pending: "bg-white text-slate-300 border-slate-200",
};

function Tracker({ c }: { c: ClaimDetail }) {
  const { t } = useI18n();
  if (!c.stages) return null;
  return (
    <ol className="grid grid-cols-1 sm:grid-cols-7 gap-3 sm:gap-1" aria-label={t("claim.journey")}>
      {c.stages.map((s) => (
        <li key={s.key} className="flex sm:flex-col items-center sm:text-center gap-3 sm:gap-2" aria-current={s.state === "current" ? "step" : undefined}>
          <span className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 ${STEP_STYLE[s.state]}`}>{s.state === "complete" ? "✓" : s.step}</span>
          <span className={`text-xs font-semibold ${s.state === "pending" ? "text-slate-400" : "text-slate-800"}`}>{t(`claim.stage.${s.key}`)}
            <span className="block text-[10px] font-medium text-slate-400">{t(`claim.state.${s.state}`)}</span></span>
        </li>))}
    </ol>
  );
}

function Detail() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const submitted = useSearchParams().get("submitted") === "1";
  const toast = useToast();
  const { data: c, error, loading, reload } = useApi<ClaimDetail>(`claims/${encodeURIComponent(id)}`);
  const [uploading, setUploading] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const target = useRef<string>("");
  const keys = useRef(new Map<string, string>());      // one operation key per document slot, kept until that upload is settled

  async function upload(file: File, key: string) {
    setUploading(key);
    try {
      const form = new FormData();
      form.append("file", file);
      const opKey = keys.current.get(key) ?? newIdempotencyKey();
      keys.current.set(key, opKey);
      await api(`claims/${encodeURIComponent(id)}/documents/${encodeURIComponent(key)}`, { method: "POST", form, idempotencyKey: opKey });
      keys.current.delete(key);
      toast(t("claim.uploaded"), "success");
      reload();
    } catch (e) {
      // A refused upload ends this attempt (a new file is a new operation); a lost connection keeps the key so the retry is the same upload.
      if (!["NETWORK", "SERVICE_UNAVAILABLE", "DOMAIN_UNAVAILABLE", "REQUEST_IN_PROGRESS"].includes((e as ApiError).code)) keys.current.delete(key);
      toast(errorText(t, e as ApiError), "error");
    }
    finally { setUploading(null); if (pick.current) pick.current.value = ""; }
  }

  if (error && !c) {
    return <div className="card">{(error as ApiError).code === "NOT_FOUND"
      ? <EmptyState title={t("claim.notFound")} text={t("claim.notFoundText")} action={<Link href="/claims" className="btn-primary">{t("claim.back")}</Link>} /> : <ErrorState error={error} onRetry={reload} />}</div>;
  }
  if (loading || !c) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;

  const outstanding = c.documents.filter((d) => d.required && d.status !== "Received");
  return (
    <div className="space-y-5">
      <PageHeader title={<span className="ltr-num">{c.claim_number}</span>} subtitle={<><ClaimStatus statusKey={c.status_key} /> <span className="ms-2">{c.product_name} · <span className="ltr-num">{c.policy_number}</span></span></>}
        actions={<Link href="/claims" className="btn-secondary">{t("claim.back")}</Link>} />
      {submitted && <Banner tone="success" title={t("claim.submitted.title")}>{t("claim.submitted.text")}</Banner>}
      {c.eligibility?.status === "Ineligible" && <Banner tone="warning" title={t("claim.ineligible.title")}>{t("claim.ineligible.text")}{c.eligibility.message ? ` ${c.eligibility.message}` : ""}</Banner>}
      {c.status_key === "documents_needed" && outstanding.length > 0 && <Banner tone="warning" title={t("claim.docsNeeded.title")}>{t("claim.docsNeeded.text", { count: outstanding.length })}</Banner>}

      <Card title={t("claim.journey")}><Tracker c={c} /></Card>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <Card title={t("claim.documents")} action={c.documents_progress ? <span className="text-xs text-slate-400">{t("claim.docsProgress", { received: c.documents_progress.received, required: c.documents_progress.required })}</span> : undefined}>
            {c.documents.length === 0 ? <EmptyState title={t("claim.noDocuments")} text={t("claim.noDocumentsText")} /> : (
              <ul className="divide-y divide-slate-100">{c.documents.map((d) => (
                <li key={d.key} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0"><p className="text-sm font-semibold text-slate-800">{d.label}{d.required && <span className="ms-1.5 text-[10px] font-bold text-rose-600">{t("claim.required")}</span>}</p>
                    <p className="text-xs text-slate-400">{d.status === "Received" ? t("claim.received", { date: date(d.received_at, locale) }) : t("claim.notYet")}{d.file_name ? ` · ${d.file_name}` : ""}</p></div>
                  {d.can_upload && <button type="button" className="btn-secondary !py-1.5 !min-h-0 text-xs" disabled={uploading === d.key} onClick={() => { target.current = d.key; pick.current?.click(); }}>
                    {uploading === d.key ? <><Spinner className="w-3.5 h-3.5" />{t("common.uploading")}</> : d.status === "Received" ? t("claim.replace") : t("claim.upload")}</button>}
                </li>))}</ul>)}
            <input ref={pick} type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" aria-label={t("claim.upload")} onChange={(e) => { const f = e.target.files?.[0]; if (f && target.current) upload(f, target.current); }} />
            <p className="text-xs text-slate-400 mt-3">{t("claim.fileRules")}</p>
          </Card>

          <Card title={t("claim.activity")}>
            {c.timeline.length === 0 ? <EmptyState title={t("claim.noActivity")} /> : (
              <ol className="relative border-s border-slate-200 ms-2 space-y-4">{c.timeline.map((e) => (
                <li key={e.id} className="ms-4"><span className="absolute -start-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-blue-500 ring-4 ring-white" aria-hidden="true" />
                  <p className="text-sm font-semibold text-slate-800">{e.title}</p><p className="text-xs text-slate-400">{dateTime(e.at, locale)}</p></li>))}</ol>)}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t("claim.summary")}>
            <KeyValue label={t("claims.type")}>{c.category ? t(`claimType.${c.category}`) : c.claim_type}</KeyValue>
            <KeyValue label={t("claims.incident")}>{date(c.incident_date, locale)}</KeyValue>
            <KeyValue label={t("claim.reported")}>{date(c.reported_date, locale)}</KeyValue>
            <KeyValue label={t("claims.claimed")}><span className="ltr-num">{money(c.claimed_amount)}</span></KeyValue>
            {c.approved_amount != null && <KeyValue label={t("claims.approved")}><span className="ltr-num">{money(c.approved_amount)}</span></KeyValue>}
            {c.event?.place && <KeyValue label={t("claimNew.place")}>{c.event.place}</KeyValue>}
            {c.event?.description && <KeyValue label={t("claimNew.description")}>{c.event.description}</KeyValue>}
          </Card>
          {c.decision && (
            <Card title={t("claim.decision")}>
              <KeyValue label={t("claims.status")}><ClaimStatus statusKey={c.status_key} /></KeyValue>
              {c.decision.amount != null && c.decision.amount > 0 && <KeyValue label={t("claim.decisionAmount")}><span className="ltr-num">{money(c.decision.amount)}</span></KeyValue>}
              {c.decision.reason && <KeyValue label={t("claim.reason")}>{c.decision.reason}</KeyValue>}
              {c.decision.at && <KeyValue label={t("claim.decidedOn")}>{date(c.decision.at, locale)}</KeyValue>}
            </Card>)}
          {c.settlement && (
            <Card title={t("claim.settlement")}>
              <KeyValue label={t("claim.paidTotal")}><span className="ltr-num">{money(c.settlement.paid_total)}</span></KeyValue>
              {c.settlement.payouts.map((p, i) => <KeyValue key={i} label={`${p.method} · ${p.status}`}><span className="ltr-num">{money(p.amount)}</span>{p.reference ? <span className="block text-xs text-slate-400 ltr-num">{p.reference}</span> : null}</KeyValue>)}
            </Card>)}
        </div>
      </div>
    </div>
  );
}

export default function ClaimDetailPage() { return <Suspense><Detail /></Suspense>; }
