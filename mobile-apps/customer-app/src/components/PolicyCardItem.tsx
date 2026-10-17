import React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Badge, Card, Text } from './ui';
import { PolicyStatus } from './common';
import { compactMoney, date, money } from '../lib/format';
import { t } from '../i18n/t';
import type { PolicyCard } from '../api/portalTypes';

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: '50%', paddingVertical: 6, paddingRight: 8 }}>
      <Text variant="caption" color="subtle">{label}</Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

/** A policy in a list (policy number, status, cover, premium, dates, next due). Same facts as the web portal's card. */
export default function PolicyCardItem({ p }: { p: PolicyCard }) {
  const nav = useNavigation<any>();
  return (
    <Card onPress={() => nav.navigate('PolicyDetail', { id: p.id })} accessibilityLabel={`${p.product_name} ${p.policy_number ?? ''}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text variant="title3" numberOfLines={2}>{p.product_name}</Text>
          <Text variant="caption" color="muted">{p.policy_number || t('policies.numberPending')}</Text>
        </View>
        <PolicyStatus statusKey={p.status_key} />
      </View>
      {p.family ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Badge label={t(`plan.${p.family.plan_type}`)} tone="brand" size="sm" />
          {p.holder_name ? <Text variant="caption" color="muted">{t('family.holder')}: {p.holder_name}</Text> : null}
          {p.access === 'guardian' ? <Badge label={t('family.access.guardian')} tone="warning" size="sm" /> : null}
          {p.access === 'summary' ? <Badge label={t('family.access.summary')} tone="neutral" size="sm" /> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
        <Cell label={t('policies.sumAssured')} value={compactMoney(p.sum_assured)} />
        <Cell label={t('policies.premium')} value={p.installment_amount != null ? `${money(p.installment_amount)}${p.premium_frequency ? ` / ${t(`frequency.${p.premium_frequency}`)}` : ''}` : '—'} />
        <Cell label={t('policies.effective')} value={date(p.effective_date)} />
        <Cell label={t('policies.expiry')} value={date(p.expiry_date || p.maturity_date)} />
      </View>
      {p.in_force && p.premium.next_due_date ? (
        <Text variant="caption" color="muted" style={{ marginTop: 6 }}>
          {t('policies.nextDue')}: {date(p.premium.next_due_date)} · {money(p.premium.next_due_amount)}
        </Text>
      ) : null}
    </Card>
  );
}
