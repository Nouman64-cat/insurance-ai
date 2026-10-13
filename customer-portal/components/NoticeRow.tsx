"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { date, money } from "@/lib/format";
import type { Notice } from "@/lib/types";
import { Icon } from "./ui";

const TONE: Record<Notice["severity"], string> = {
  critical: "bg-rose-50 text-rose-600", warning: "bg-amber-50 text-amber-600", success: "bg-emerald-50 text-emerald-600", info: "bg-blue-50 text-blue-600",
};

/** A notification, worded from its kind and parameters in the viewer's language. */
export function NoticeRow({ n, compact = false, action }: { n: Notice; compact?: boolean; action?: React.ReactNode }) {
  const { t, locale } = useI18n();
  const p = n.params;
  const vars = {
    policy: p.policy_number ?? "", amount: typeof p.amount === "number" ? money(p.amount) : "", date: p.due_date ? date(String(p.due_date), locale) : p.date ? date(String(p.date), locale) : "",
    graceUntil: p.grace_until ? date(String(p.grace_until), locale) : "", days: p.days ?? p.days_left ?? "", claim: p.claim_number ?? "",
  };
  const href = n.claim_id ? `/claims/${n.claim_id}` : n.policy_id ? `/policies/${n.policy_id}` : "/dashboard";
  return (
    <li className={`flex items-start gap-3 ${n.read ? "opacity-70" : ""}`}>
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${TONE[n.severity]}`}><Icon name={n.severity === "success" ? "check" : n.severity === "info" ? "bell" : "alert"} className="w-4 h-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-800">{t(`notice.${n.kind}.title`, vars)}</p>
        {!compact && <p className="text-sm text-slate-500 mt-0.5">{t(`notice.${n.kind}.text`, vars)}</p>}
        <div className="flex items-center gap-3 mt-1">
          <Link href={href} className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("common.open")}</Link>
          {action}
        </div>
      </div>
      {!n.read && <span className="w-2 h-2 rounded-full bg-blue-500 mt-2 shrink-0" aria-label={t("notifications.unread")} />}
    </li>
  );
}
