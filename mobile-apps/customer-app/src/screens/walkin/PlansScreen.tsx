import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Badge, Button, Card, EmptyState, Field, SegmentedControl, SkeletonList, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { useApi } from '../../hooks/useApi';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { WalkInPlan } from '../../api/types';

const TABS = ['All', 'Individual', 'Family', 'Corporate'] as const;
type Tab = (typeof TABS)[number];

/** Browse the catalogue (same data and filters as the web portal's Explore Insurance Plans). */
export default function PlansScreen({ navigation }: { navigation: any }) {
  const plans = useApi<{ plans: WalkInPlan[] }>('/walk-in/plans');
  const [tab, setTab] = useState<Tab>('All');
  const [q, setQ] = useState('');

  const list = useMemo(() => (plans.data?.plans ?? []).filter((p) =>
    (tab === 'All' || p.category === tab) && (!q.trim() || `${p.label} ${p.description}`.toLowerCase().includes(q.trim().toLowerCase()))), [plans.data, tab, q]);

  return (
    <Screen header={<ScreenHeader title={t('walkin.plans.title')} subtitle={t('walkin.plans.subtitle')} leading="none" />}
      scrollable padded refreshing={plans.loading && !!plans.data} onRefresh={plans.reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <SegmentedControl variant="chips" value={tab} onChange={setTab}
        segments={TABS.map((k) => ({ value: k, label: k === 'All' ? t('common.all') : t(`walkin.category.${k}`) }))} />
      <Field value={q} onChangeText={setQ} placeholder={t('walkin.plans.search')} leftIcon="search" autoCorrect={false} accessibilityLabel={t('walkin.plans.search')} />
      {plans.loading && !plans.data ? <SkeletonList count={4} />
        : plans.error && !plans.data ? <EmptyState tone="danger" icon="alert-circle" title={t('error.title')} description={errorText(plans.error)} actionLabel={t('common.retry')} onAction={plans.reload} />
        : list.length === 0 ? <EmptyState icon="search" title={t('walkin.plans.none')} description={t('walkin.plans.noneText')} />
        : list.map((p) => (
          <Card key={p.id}>
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <Text variant="title3" style={{ flex: 1 }}>{p.label}</Text>
                <Badge label={t(`walkin.category.${p.category}`)} tone="brand" size="sm" />
              </View>
              <Text variant="callout" color="muted" numberOfLines={4}>{p.description}</Text>
              <View style={{ flexDirection: 'row', gap: 24 }}>
                <View><Text variant="caption" color="subtle">{t('walkin.plans.age')}</Text><Text variant="bodyStrong">{p.entry_age_min}–{p.entry_age_max}</Text></View>
                <View><Text variant="caption" color="subtle">{t('walkin.plans.term')}</Text><Text variant="bodyStrong">{t('walkin.plans.years', { min: p.term_min_years, max: p.term_max_years })}</Text></View>
              </View>
              <Button title={t('walkin.plans.apply')} onPress={() => navigation.navigate('Apply', { planId: p.id })} />
            </View>
          </Card>
        ))}
    </Screen>
  );
}
