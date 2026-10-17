"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { compactMoney, date, money } from "@/lib/format";
import type { PolicyCard } from "@/lib/types";
import { PolicyStatus } from "./ui";

export function PolicyCardItem({ p }: { p: PolicyCard }) {
  const { t, locale } = useI18n();
  return (
    <Link href={`/policies/${p.id}`} className="card min-w-0 p-5 block hover:shadow-md hover:-translate-y-0.5 transition-all focus-visible:ring-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-900 truncate">{p.product_name}</p>
          <p className="text-xs text-slate-400 mt-0.5 ltr-num">{p.policy_number || t("policies.numberPending")}</p>
        </div>
        <PolicyStatus statusKey={p.status_key} />
      </div>
      {p.family && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          <span className="font-semibold text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">{t(`plan.${p.family.plan_type}`)}</span>
          {p.holder_name && <span>{t("family.holder")}: <bdi className="font-semibold text-slate-700">{p.holder_name}</bdi></span>}
          {p.access === "guardian" && <span className="text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">{t("family.access.guardian")}</span>}
          {p.access === "summary" && <span className="text-slate-600 bg-slate-100 rounded-full px-2 py-0.5">{t("family.access.summary")}</span>}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 mt-4 text-xs">
        <div><dt className="text-slate-400 font-medium">{t("policies.sumAssured")}</dt><dd className="text-sm font-bold text-slate-900 mt-0.5">{compactMoney(p.sum_assured)}</dd></div>
        <div><dt className="text-slate-400 font-medium">{t("policies.premium")}</dt><dd className="text-sm font-bold text-slate-900 mt-0.5">{p.installment_amount != null ? money(p.installment_amount) : "—"}{p.premium_frequency && <span className="text-slate-400 font-medium"> / {t(`frequency.${p.premium_frequency}`)}</span>}</dd></div>
        <div><dt className="text-slate-400 font-medium">{t("policies.effective")}</dt><dd className="text-sm font-semibold text-slate-700 mt-0.5">{date(p.effective_date, locale)}</dd></div>
        <div><dt className="text-slate-400 font-medium">{t("policies.expiry")}</dt><dd className="text-sm font-semibold text-slate-700 mt-0.5">{date(p.expiry_date || p.maturity_date, locale)}</dd></div>
      </dl>
      {p.in_force && p.premium.next_due_date && (
        <p className="mt-4 text-xs text-slate-500 border-t border-slate-100 pt-3">
          {t("policies.nextDue")}: <bdi className="font-semibold text-slate-700">{date(p.premium.next_due_date, locale)}</bdi> · <bdi className="font-semibold text-slate-700">{money(p.premium.next_due_amount)}</bdi>
        </p>
      )}
    </Link>
  );
}
