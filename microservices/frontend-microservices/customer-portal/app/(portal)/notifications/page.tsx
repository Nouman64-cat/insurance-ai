"use client";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { NoticeRow } from "@/components/NoticeRow";
import { NOTICES_CHANGED } from "@/components/Shell";
import { api, useApi } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Notice } from "@/lib/types";
import { Banner, Icon } from "@/components/ui";

export default function NotificationsPage() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<{ items: Notice[]; unread: number; partial: boolean }>("notifications");

  async function mark(body: { keys?: string[]; all?: boolean }) {
    await api("notifications/read", { method: "POST", body });
    reload();
    window.dispatchEvent(new Event(NOTICES_CHANGED));
  }

  return (
    <div>
      <PageHeader title={t("notifications.title")} subtitle={t("notifications.subtitle")}
        actions={(data?.unread ?? 0) > 0 ? <button type="button" className="btn-secondary" onClick={() => mark({ all: true })}>{t("notifications.markAll")}</button> : undefined} />
      {data?.partial && <div className="mb-4"><Banner tone="warning">{t("notifications.partial")}</Banner></div>}
      {error && !data ? <div className="card"><ErrorState error={error} onRetry={reload} /></div>
        : loading && !data ? <Skeleton className="h-40" />
        : (data?.items.length ?? 0) === 0 ? <div className="card"><EmptyState title={t("notifications.none")} text={t("notifications.noneText")} icon={<Icon name="bell" className="w-6 h-6" />} /></div>
        : <Card><ul className="space-y-5">{data?.items.map((n) => (
            <NoticeRow key={n.key} n={n} action={!n.read ? <button type="button" onClick={() => mark({ keys: [n.key] })} className="text-xs font-semibold text-slate-500 hover:text-slate-800">{t("notifications.markRead")}</button> : undefined} />))}</ul></Card>}
    </div>
  );
}
