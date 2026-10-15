import React from 'react';
import { Banner, Button, Card, EmptyState } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, LoadingCards } from '../../components/common';
import NoticeRow from '../../components/NoticeRow';
import { useApi } from '../../hooks/useApi';
import { useCustomer } from '../../context/CustomerContext';
import { post } from '../../api/portal';
import { t } from '../../i18n/t';
import type { Notice } from '../../api/portalTypes';

export default function NotificationsScreen() {
  const { refreshNotices } = useCustomer();
  const { data, error, loading, reload } = useApi<{ items: Notice[]; unread: number; partial: boolean }>('/notifications', { pollMs: 30_000 });

  async function mark(body: { keys?: string[]; all?: boolean }) {
    await post('/notifications/read', body);
    await reload();
    refreshNotices();
  }

  return (
    <Screen header={<ScreenHeader title={t('notifications.title')} subtitle={t('notifications.subtitle')} leading="back" />}
      scrollable padded refreshing={loading && !!data} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      {(data?.unread ?? 0) > 0 ? <Button size="sm" variant="outline" title={t('notifications.markAll')} onPress={() => mark({ all: true })} /> : null}
      {data?.partial ? <Banner tone="warning" title={t('notifications.partial')} /> : null}
      {error && !data ? <ErrorView error={error} onRetry={reload} />
        : loading && !data ? <LoadingCards count={3} height={80} />
        : (data?.items.length ?? 0) === 0 ? <EmptyState icon="notifications-outline" title={t('notifications.none')} description={t('notifications.noneText')} />
        : <Card>{data?.items.map((n) => <NoticeRow key={n.key} n={n} onMarkRead={() => mark({ keys: [n.key] })} />)}</Card>}
    </Screen>
  );
}
