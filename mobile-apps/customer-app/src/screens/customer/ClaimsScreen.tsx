import React, { useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, EmptyState, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ClaimStatus, ErrorView, LoadingCards } from '../../components/common';
import SegmentSwitch, { Segment, segmentQuery } from '../../components/SegmentSwitch';
import { useApi } from '../../hooks/useApi';
import { date, money } from '../../lib/format';
import { t } from '../../i18n/t';
import type { ClaimRow } from '../../api/portalTypes';

export default function ClaimsScreen({ navigation }: { navigation: any }) {
  const [segment, setSegment] = useState<Segment>('individual');
  const { data, error, loading, reload } = useApi<{ items: ClaimRow[] }>(`/claims${segmentQuery(segment)}`);
  return (
    <Screen header={<ScreenHeader title={t('claims.title')} subtitle={t('claims.subtitle')} leading="none" />}
      scrollable padded refreshing={loading && !!data} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <Button title={t('claims.new')} icon="add" onPress={() => navigation.navigate('NewClaim', {})} fullWidth />
      <SegmentSwitch value={segment} onChange={setSegment} />
      <Banner tone="info" title={t('claims.death.title')} description={t('claims.death.text')} />
      {error && !data ? <ErrorView error={error} onRetry={reload} />
        : loading && !data ? <LoadingCards count={3} height={110} />
        : (data?.items.length ?? 0) === 0 ? <EmptyState icon="medkit-outline" title={t('claims.none')} description={t('claims.noneText')} actionLabel={t('claims.new')} onAction={() => navigation.navigate('NewClaim', {})} />
        : data?.items.map((c) => (
          <Card key={c.id} onPress={() => navigation.navigate('ClaimDetail', { id: c.id })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text variant="title3" selectable>{c.claim_number}</Text>
                <Text variant="caption" color="muted">{c.policy_number}{c.covered_person?.name ? ` · ${c.covered_person.name}` : ''}</Text>
              </View>
              <ClaimStatus statusKey={c.status_key} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, rowGap: 6 }}>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('claims.type')}</Text><Text variant="calloutStrong">{c.category ? t(`claimType.${c.category}`) : c.claim_type}</Text></View>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('claims.incident')}</Text><Text variant="calloutStrong">{date(c.incident_date)}</Text></View>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('claims.claimed')}</Text><Text variant="calloutStrong">{money(c.claimed_amount)}</Text></View>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('claims.approved')}</Text><Text variant="calloutStrong">{c.approved_amount != null ? money(c.approved_amount) : '—'}</Text>
                {c.settled_amount ? <Text variant="micro" color="success">{t('claims.paidOut', { amount: money(c.settled_amount) })}</Text> : null}</View>
            </View>
          </Card>
        ))}
    </Screen>
  );
}
