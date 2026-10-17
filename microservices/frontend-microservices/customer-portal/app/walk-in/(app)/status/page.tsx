"use client";
import Link from "next/link";
import { useEffect } from "react";
import { Banner, Card, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { WalkInLead } from "@/lib/types";

// The steps a request moves through, in order. Each is a real state on the insurer's side, not an estimate.
const STEPS = [
  ["Submitted", "submitted"], ["Agent Assigned", "agent_assigned"], ["In Progress", "in_progress"], ["Proposal Being Prepared", "proposal"],
  ["Application Under Review", "review"], ["Initial Payment", "payment"], ["Underwriting", "underwriting"], ["Approved", "approved"], ["Policy Issued", "issued"],
] as const;
const POLL_MS = 15000;

function Lead({ lead }: { lead: WalkInLead }) {
  const { t } = useI18n();
  const declined = lead.stage === "Declined";
  const paying = lead.stage === "Payment Due" || lead.stage === "Payment Verification";
  const idx = declined ? STEPS.findIndex(([s]) => s === "Underwriting") : STEPS.findIndex(([s]) => s === (paying ? "Initial Payment" : lead.stage));
  const slug = declined ? "declined" : lead.stage === "Payment Due" ? "payment_due" : lead.stage === "Payment Verification" ? "payment_check" : STEPS[Math.max(idx, 0)][1];
  return (
    <Card>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-slate-400">{t("walkin.status.reference")}</p>
            <p className="text-lg font-bold text-slate-900 ltr-num" dir="ltr">{lead.reference}</p>
          </div>
          <div className="text-end">
            <p className="text-sm font-bold text-slate-800">{lead.plan.label}{lead.applicant_type === "Family" && <span className="ms-2 text-[10px] font-bold text-blue-700 bg-blue-50 ring-1 ring-blue-200 rounded-full px-2 py-0.5 align-middle">{t("walkin.who.Family")}</span>}</p>
            <p className="text-xs text-slate-400">{t("walkin.status.submitted", { date: date(lead.submitted_at) })}</p>
          </div>
        </div>
        <div>
          <p className={`text-sm font-bold ${declined ? "text-rose-700" : lead.stage === "Policy Issued" ? "text-emerald-700" : "text-blue-700"}`}>{lead.closed && !declined ? t("walkin.stage.closed") : t(`walkin.stage.${slug}`)}</p>
          <p className="text-sm text-slate-600 mt-0.5">{lead.closed && !declined ? t("walkin.stageNote.closed") : t(`walkin.stageNote.${slug}`)}</p>
        </div>
        <ol className="flex items-center gap-1" aria-label={t("walkin.status.progress")}>
          {STEPS.map(([name], i) => (
            <li key={name} className={`h-1.5 flex-1 rounded-full ${declined ? (i <= idx ? "bg-rose-400" : "bg-slate-200") : i <= idx ? (lead.stage === "Policy Issued" ? "bg-emerald-500" : "bg-blue-500") : "bg-slate-200"}`} />
          ))}
        </ol>
        <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-500">
          {STEPS.map(([name, s], i) => (
            <li key={name} className={i <= idx && !declined ? "font-semibold text-slate-800" : ""}>{i <= idx && !declined ? "✓ " : "○ "}{t(`walkin.stage.${s}`)}</li>
          ))}
        </ul>
        {lead.agent ? (
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm">
            <p className="text-xs text-slate-400">{t("walkin.status.advisor")}</p>
            <p className="font-bold text-slate-800">{lead.agent.name}</p>
            <p className="text-xs text-slate-600 ltr-num" dir="ltr">{[lead.agent.phone, lead.agent.email].filter(Boolean).join("  ·  ")}</p>
          </div>
        ) : <p className="text-xs text-slate-500">{t("walkin.status.findingAdvisor")}</p>}
        {lead.payment && !lead.payment.expired && lead.stage === "Payment Due" && (
          <Banner tone="warning" title={t("walkin.status.payDue", { amount: money(lead.payment.amount) })}
            action={<Link href={`/walk-in/pay/${lead.payment.token}`} className="btn-primary">{lead.payment.proof_status === "Rejected" ? t("walkin.status.payAgain") : t("walkin.status.payNow")}</Link>}>
            {lead.payment.proof_status === "Rejected" ? t("walkin.pay.rejectedText") : t("walkin.status.payText")}
          </Banner>
        )}
        {lead.payment && lead.stage === "Payment Verification" && <Banner tone="info" title={t("walkin.pay.checking")}>{t("walkin.pay.checkingText")}</Banner>}
        {lead.payment?.expired && <Banner tone="warning" title={t("walkin.pay.expired")}>{t("walkin.pay.expiredText")}</Banner>}
        {lead.stage === "Policy Issued" && lead.handoff.available && (
          <Banner tone="success" title={t("walkin.handoff.title")}
            action={<Link href="/login" className="btn-primary">{t("walkin.handoff.signIn")}</Link>}>
            {lead.handoff.account_ready ? t("walkin.handoff.ready") : t("walkin.handoff.pending")}
          </Banner>
        )}
      </div>
    </Card>
  );
}

export default function StatusPage() {
  const { t } = useI18n();
  const mine = useApi<{ leads: WalkInLead[] }>("walk-in/application");
  const reload = mine.reload;
  useEffect(() => {                         // follows the request without a manual refresh; paused while the tab is hidden
    const id = setInterval(() => { if (document.visibilityState === "visible") reload(); }, POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  return (
    <>
      <PageHeader title={t("walkin.status.title")} subtitle={t("walkin.status.subtitle")} />
      {mine.loading && !mine.data ? <Skeleton className="h-56 w-full" />
        : mine.error && !mine.data ? <ErrorState error={mine.error} onRetry={reload} />
        : (mine.data?.leads.length ?? 0) === 0 ? <EmptyState title={t("walkin.status.none")} text={t("walkin.status.noneText")} action={<Link href="/walk-in/plans" className="btn-primary">{t("walkin.nav.plans")}</Link>} />
        : <div className="space-y-4">{mine.data!.leads.map((l) => <Lead key={l.reference} lead={l} />)}</div>}
    </>
  );
}
