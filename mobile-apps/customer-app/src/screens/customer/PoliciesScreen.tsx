import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { EmptyState, Field, SegmentedControl } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, LoadingCards } from '../../components/common';
import PolicyCardItem from '../../components/PolicyCardItem';
import SegmentSwitch, { Segment, segmentQuery } from '../../components/SegmentSwitch';
import { useApi } from '../../hooks/useApi';
import { t } from '../../i18n/t';
import type { PolicyCard } from '../../api/portalTypes';

const FILTERS = ['all', 'active', 'attention', 'closed'] as const;
const ATTENTION = ['grace_period', 'lapsed', 'pending_issuance', 'issued'];
const CLOSED = ['cancelled', 'expired', 'matured', 'surrendered'];

export default function PoliciesScreen() {
  const [segment, setSegment] = useState<Segment>('individual');
  const { data, error, loading, reload } = useApi<{ items: PolicyCard[] }>(`/policies${segmentQuery(segment)}`);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [q, setQ] = useState('');

  const inFilter = (p: PolicyCard, f: (typeof FILTERS)[number]) =>
    f === 'all' || (f === 'active' && ['active', 'reinstated'].includes(p.status_key)) || (f === 'attention' && ATTENTION.includes(p.status_key)) || (f === 'closed' && CLOSED.includes(p.status_key));

  // How many policies each filter would show, so the chips say what they hold before they are tapped.
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, (data?.items || []).filter((p) => inFilter(p, f)).length])) as Record<(typeof FILTERS)[number], number>, [data]);

  const items = useMemo(() => (data?.items || []).filter((p) => {
    if (!inFilter(p, filter)) return false;
    const needle = q.trim().toLowerCase();
    return !needle || (p.policy_number || '').toLowerCase().includes(needle) || p.product_name.toLowerCase().includes(needle);
  }), [data, filter, q]);

  return (
    <Screen header={<ScreenHeader title={t('policies.title')} subtitle={t('policies.subtitle')} leading="none" />}
      scrollable padded refreshing={loading && !!data} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <SegmentSwitch value={segment} onChange={setSegment} />
      <SegmentedControl variant="chips" value={filter} onChange={setFilter} segments={FILTERS.map((f) => ({ value: f, label: t(`policies.filter.${f}`), count: data ? counts[f] : undefined }))} />
      <Field value={q} onChangeText={setQ} placeholder={t('policies.search')} leftIcon="search" autoCorrect={false} accessibilityLabel={t('policies.search')} />
      {error && !data ? <ErrorView error={error} onRetry={reload} />
        : loading && !data ? <LoadingCards count={3} height={170} />
        : (data?.items.length ?? 0) === 0 ? <EmptyState icon="documents-outline" title={t('policies.none')} description={t('policies.noneText')} />
        : items.length === 0 ? <EmptyState icon="search" title={t('policies.noMatch')} />
        : <View style={{ gap: 12 }}>{items.map((p) => <PolicyCardItem key={p.id} p={p} />)}</View>}
    </Screen>
  );
}
