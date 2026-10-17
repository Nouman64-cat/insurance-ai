"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { date, money } from "@/lib/format";
import type { ClaimRow } from "@/lib/types";
import { Icon } from "./ui";

// How a claim is presented: a strong status badge, a progress tracker, and the card the Claims page lists.

const STATUS: Record<string, { cls: string; icon: string }> = {
  submitted: { cls: "bg-blue-600 text-white", icon: "M12 19V5m-6 6 6-6 6 6" },
  in_review: { cls: "bg-indigo-600 text-white", icon: "M21 21l-4.35-4.35M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z" },
  assessment: { cls: "bg-indigo-600 text-white", icon: "M21 21l-4.35-4.35M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z" },
  documents_needed: { cls: "bg-amber-500 text-white", icon: "M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" },
  approved: { cls: "bg-emerald-600 text-white", icon: "M5 13l4 4L19 7" },
  partially_approved: { cls: "bg-emerald-600 text-white", icon: "M5 13l4 4L19 7" },
  settled: { cls: "bg-teal-600 text-white", icon: "M12 8c-1.7 0-3 .9-3 2s1.3 2 3 2 3 .9 3 2-1.3 2-3 2m0-8V6m0 12v-2" },
  declined: { cls: "bg-rose-600 text-white", icon: "M6 6l12 12M18 6 6 18" },
  closed: { cls: "bg-slate-600 text-white", icon: "M5 13l4 4L19 7" },
};

/** A status that can be read from across the room: solid colour, an icon, and the word. */
export function StrongStatus({ statusKey, flash = false }: { statusKey: string; flash?: boolean }) {
  const { t } = useI18n();
  const s = STATUS[statusKey] ?? { cls: "bg-slate-600 text-white", icon: "M5 13l4 4L19 7" };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold shadow-sm transition ${s.cls} ${flash ? "ring-4 ring-blue-300/60" : ""}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true"><path d={s.icon} /></svg>
      {t(`claimStatus.${statusKey}`)}
    </span>
  );
}

type StepState = "done" | "current" | "todo" | "bad";

/** Where the claim is on its way: Submitted → Under review → Decision → Paid. A request for documents shows as a flag on the review step. */
export function ClaimTracker({ c }: { c: ClaimRow }) {
  const { t } = useI18n();
  const k = c.status_key;
  const decided = ["approved", "partially_approved", "declined"].includes(k) || (k === "closed" && c.approved_amount != null) || k === "settled" || (k === "closed" && !!c.settled_amount);
  const paid = k === "settled" || !!c.settled_amount;
  const declined = k === "declined";
  const reviewing = ["in_review", "assessment", "documents_needed"].includes(k);
  const state = (i: number): StepState => {
    if (i === 0) return k === "submitted" ? "current" : "done";
    if (i === 1) return reviewing ? "current" : k === "submitted" ? "todo" : "done";
    if (i === 2) return declined ? "bad" : decided ? (paid ? "done" : "current") : "todo";
    return paid ? "done" : "todo";
  };
  const labels = [t("claims.track.submitted"), t("claims.track.review"), declined ? t("claims.track.declined") : k === "partially_approved" ? t("claims.track.partial") : decided ? t("claims.track.approved") : t("claims.track.decision"), t("claims.track.paid")];
  const dot: Record<StepState, string> = {
    done: "bg-blue-600 text-white", current: "bg-white text-blue-700 ring-4 ring-blue-200 border-2 border-blue-600", todo: "bg-slate-100 text-slate-400 border border-slate-200", bad: "bg-rose-600 text-white",
  };
  return (
    <div>
      <ol className="flex items-start" aria-label={t("claims.track.label")}>
        {labels.map((label, i) => {
          const st = state(i);
          return (
            <li key={i} className="flex flex-1 items-start last:flex-none" aria-current={st === "current" ? "step" : undefined}>
              <div className="flex w-[4.5rem] flex-col items-center text-center sm:w-24">
                <span className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold transition-all ${dot[st]}`}>
                  {st === "done" ? <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg> : st === "bad" ? "✕" : i + 1}
                </span>
                <span className={`mt-1.5 text-[11px] leading-tight ${st === "current" ? "font-bold text-blue-700" : st === "bad" ? "font-bold text-rose-700" : st === "done" ? "font-medium text-slate-700" : "text-slate-400"}`}>{label}</span>
              </div>
              {i < labels.length - 1 && <span className={`mt-3.5 h-0.5 min-w-[10px] flex-1 rounded ${state(i + 1) === "todo" ? "bg-slate-200" : "bg-blue-600"}`} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {k === "documents_needed" && (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800"><Icon name="alert" className="h-3.5 w-3.5" />{t("claims.track.docsFlag")}</p>
      )}
    </div>
  );
}

export function ClaimCard({ c, flash }: { c: ClaimRow; flash: boolean }) {
  const { t, locale } = useI18n();
  const needsDocs = c.status_key === "documents_needed";
  const open = !["closed", "settled", "declined"].includes(c.status_key);
  const fact = (label: string, value: React.ReactNode) => (
    <div className="min-w-0"><dt className="text-[11px] font-medium text-slate-400">{label}</dt><dd className="mt-0.5 truncate text-sm font-semibold text-slate-800">{value}</dd></div>
  );
  return (
    <article className={`overflow-hidden rounded-2xl border bg-white shadow-[0_2px_12px_rgb(15,23,42,0.04)] transition-all duration-300 hover:shadow-[0_8px_24px_rgb(15,23,42,0.08)] ${flash ? "border-blue-400 ring-2 ring-blue-300/60" : needsDocs ? "border-amber-300" : "border-slate-200/80"}`}>
      {needsDocs && <div className="h-1 bg-gradient-to-r from-amber-400 to-amber-300" aria-hidden="true" />}
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600" aria-hidden="true"><Icon name="claims" className="h-5 w-5" /></span>
            <div className="min-w-0">
              <p className="truncate text-base font-bold text-slate-900 ltr-num">{c.claim_number || t("claims.numberPending")}</p>
              <p className="truncate text-xs text-slate-500"><span className="ltr-num">{c.policy_number}</span>{c.covered_person?.name && <> · <bdi>{c.covered_person.name}</bdi></>}</p>
            </div>
          </div>
          <StrongStatus statusKey={c.status_key} flash={flash} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {fact(t("claims.type"), <bdi>{c.category ? t(`claimType.${c.category}`) : c.claim_type}</bdi>)}
          {fact(t("claims.incident"), <bdi>{date(c.incident_date, locale)}</bdi>)}
          {fact(t("claims.claimed"), <span className="ltr-num">{money(c.claimed_amount)}</span>)}
          {fact(t("claims.approved"), c.approved_amount != null ? <span className="text-emerald-700 ltr-num">{money(c.approved_amount)}</span> : <span className="text-slate-400">—</span>)}
        </dl>
        {c.settled_amount ? <p className="mt-2 text-xs font-semibold text-teal-700">{t("claims.paidOut", { amount: money(c.settled_amount) })}</p> : null}

        <div className="mt-5 border-t border-slate-100 pt-4"><ClaimTracker c={c} /></div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-slate-400">{t("claims.lastUpdate")}: <bdi>{date(c.last_update, locale)}</bdi></p>
          <Link href={`/claims/${c.id}`} className={needsDocs ? "btn-primary !py-1.5 text-xs" : "btn-secondary !py-1.5 text-xs"}>
            {needsDocs ? t("claims.uploadDocs") : open ? t("claims.trackProgress") : t("claims.viewDetails")} →
          </Link>
        </div>
      </div>
    </article>
  );
}
