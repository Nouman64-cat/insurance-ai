import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Card, EmptyState, Field, SegmentedControl, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, LoadingCards } from '../../components/common';
import DownloadButton from '../../components/DownloadButton';
import SegmentSwitch, { Segment, segmentQuery } from '../../components/SegmentSwitch';
import { useApi } from '../../hooks/useApi';
import { date, tOr } from '../../lib/format';
import { t } from '../../i18n/t';
import type { DocumentItem } from '../../api/portalTypes';

const GROUPS: Record<string, string[]> = {
  policy: ['policy_document', 'welcome_kit'],
  receipts: ['receipt'],
  changes: ['endorsement', 'renewal_confirmation', 'reinstatement_confirmation', 'exit_confirmation'],
  claims: ['claim_checklist', 'claim_confirmation', 'claim_document'],
};

export default function DocumentsScreen() {
  const [segment, setSegment] = useState<Segment>('individual');
  const { data, error, loading, reload } = useApi<{ items: DocumentItem[] }>(`/documents${segmentQuery(segment)}`);
  const [group, setGroup] = useState<'all' | keyof typeof GROUPS>('all');
  const [q, setQ] = useState('');
  const items = useMemo(() => (data?.items || []).filter((d) => {
    if (group !== 'all' && !GROUPS[group].includes(d.kind)) return false;
    const n = q.trim().toLowerCase();
    return !n || d.title.toLowerCase().includes(n) || (d.policy_number || '').toLowerCase().includes(n);
  }), [data, group, q]);

  return (
    <Screen header={<ScreenHeader title={t('documents.title')} subtitle={t('documents.subtitle')} leading="back" />}
      scrollable padded refreshing={loading && !!data} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <SegmentSwitch value={segment} onChange={setSegment} />
      <SegmentedControl variant="chips" value={group} onChange={(g) => setGroup(g as typeof group)} segments={(['all', ...Object.keys(GROUPS)] as const).map((g) => ({ value: g, label: t(`documents.group.${g}`) }))} />
      <Field value={q} onChangeText={setQ} placeholder={t('documents.search')} leftIcon="search" autoCorrect={false} accessibilityLabel={t('documents.search')} />
      {error && !data ? <ErrorView error={error} onRetry={reload} />
        : loading && !data ? <LoadingCards count={4} height={80} />
        : (data?.items.length ?? 0) === 0 ? <EmptyState icon="document-outline" title={t('documents.none')} description={t('documents.noneText')} />
        : items.length === 0 ? <EmptyState icon="search" title={t('documents.noMatch')} />
        : items.map((d) => (
          <Card key={d.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong" numberOfLines={2}>{d.title}</Text>
                <Text variant="caption" color="muted">{tOr(t, `documents.kind.${d.kind}`, d.kind)} · {d.policy_number} · {date(d.date)}</Text>
              </View>
              <DownloadButton handle={d.id} fallbackName={`${d.title}.pdf`} available={d.available} />
            </View>
          </Card>
        ))}
    </Screen>
  );
}
