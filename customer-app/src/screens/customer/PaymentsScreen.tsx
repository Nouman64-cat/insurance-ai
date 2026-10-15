import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Banner, Button, Card, EmptyState, StatTile, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, InstallmentState, LoadingCards, Panel, PolicyStatus } from '../../components/common';
import DownloadButton from '../../components/DownloadButton';
import PaySheet from '../../components/PaySheet';
import SegmentSwitch, { Segment, segmentQuery } from '../../components/SegmentSwitch';
import { useApi } from '../../hooks/useApi';
import { useTheme } from '../../theme/ThemeContext';
import { date, dateTime, money, tOr } from '../../lib/format';
import { t } from '../../i18n/t';
import type { Installment, PaymentsOverview, PolicyCard } from '../../api/portalTypes';

export default function PaymentsScreen({ navigation }: { navigation: any }) {
  const { colors } = useTheme();
  const [segment, setSegment] = useState<Segment>('individual');
  const { data, error, loading, reload } = useApi<PaymentsOverview>(`/payments${segmentQuery(segment)}`);
  const [paying, setPaying] = useState<{ policy: PolicyCard; installment: Installment } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const head = <ScreenHeader title={t('payments.title')} subtitle={t('payments.subtitle')} leading="none" />;
  if (error && !data) return <Screen header={head} padded><ErrorView error={error} onRetry={reload} /></Screen>;
  const rows = data?.policies || [];
  const withSchedule = rows.filter((r) => r.premiums && r.premiums.installments.length > 0);
  const ld = loading && !data;
  const tt = data?.totals;

  return (
    <Screen header={head} scrollable padded refreshing={loading && !!data} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <SegmentSwitch value={segment} onChange={setSegment} />
      {segment === 'family' ? <Banner tone="info" title={t('family.paymentsNote')} /> : null}
      {data?.simulated_payments ? <Banner tone="warning" title={t('pay.simulated.title')} description={t('pay.simulated.text')} /> : null}
      {data && !data.payments_enabled ? <Banner tone="info" title={t('payments.disabled')} /> : null}
      {data?.partial ? <Banner tone="warning" title={t('payments.partial')} actionLabel={t('common.retry')} onAction={reload} /> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <View style={{ width: '48.5%' }}><StatTile loading={ld} label={t('payments.totalPaid')} value={money(tt?.total_paid)} caption={t('payments.receiptsCount', { count: data?.history.length ?? 0 })} icon="checkmark-circle-outline" tone="success" /></View>
        <View style={{ width: '48.5%' }}><StatTile loading={ld} label={t('payments.dueNow')} value={money(tt?.outstanding)} caption={(tt?.overdue ?? 0) > 0 ? t('payments.overdue', { amount: money(tt?.overdue) }) : t('payments.nothingDue')} icon="alert-circle-outline" tone={(tt?.outstanding ?? 0) > 0 ? 'danger' : 'neutral'} /></View>
        <View style={{ width: '48.5%' }}><StatTile loading={ld} label={t('payments.nextDue')} value={tt?.next_due ? money(tt.next_due.amount) : t('dashboard.none')} caption={tt?.next_due ? `${date(tt.next_due.date)} · ${tt.next_due.policy_number}` : t('dashboard.noUpcoming')} icon="calendar-outline" tone="info" /></View>
        <View style={{ width: '48.5%' }}><StatTile loading={ld} label={t('payments.remaining')} value={money(tt?.remaining)} caption={t('payments.remainingNote')} icon="wallet-outline" tone="neutral" /></View>
      </View>

      {ld ? <LoadingCards count={2} height={160} />
        : rows.length === 0 ? <EmptyState icon="card-outline" title={t('payments.noPolicies')} description={t('payments.noPoliciesText')} />
        : (
          <View style={{ gap: 12 }}>
            {withSchedule.length === 0 ? <EmptyState icon="calendar-outline" title={t('payments.noSchedule')} description={t('payments.noScheduleText')} /> : null}
            {withSchedule.map(({ policy, premiums }) => premiums && (
              <Panel key={policy.id} title={`${policy.product_name} · ${policy.policy_number}`}
                action={<Text variant="caption" color="muted">{t('payments.progress', { paid: premiums.summary.paid, total: premiums.summary.total })}</Text>}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <PolicyStatus statusKey={policy.status_key} />
                  {policy.family ? <Text variant="caption" color="subtle">{t(`plan.${policy.family.plan_type}`)}{policy.holder_name ? ` · ${policy.holder_name}` : ''}</Text> : null}
                  <Button size="sm" variant="ghost" title={t('nav.policies')} onPress={() => navigation.navigate('PolicyDetail', { id: policy.id })} />
                </View>
                {premiums.summary.in_grace ? <Banner tone="warning" title={t('payments.grace.title')} description={t('payments.grace.text', { date: date(premiums.summary.grace_until), days: premiums.summary.grace_days_left ?? 0 })} style={{ marginBottom: 8 }} /> : null}
                {!policy.in_force && !policy.pending_issuance ? <Banner tone="info" title={t('payments.notInForce')} style={{ marginBottom: 8 }} /> : null}
                {premiums.installments.map((i) => {
                  const receipt = i.receipt ? premiums.receipts.find((r) => r.receipt_no === i.receipt?.receipt_no) : undefined;
                  const expanded = !!open[i.id];
                  return (
                    <Card key={i.id} variant="sunken" style={{ marginBottom: 8 }} onPress={() => setOpen((o) => ({ ...o, [i.id]: !o[i.id] }))}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Text variant="bodyStrong">#{i.installment_no} · {date(i.due_date)}</Text>
                          <Text variant="calloutStrong">{money(i.status === 'Paid' ? i.amount_paid || i.amount_due : i.payable)}</Text>
                          {i.surcharge > 0 ? <Text variant="caption" color="warning">{t('payments.incSurcharge', { amount: money(i.surcharge) })}</Text> : null}
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <InstallmentState state={i.state} />
                          {i.payable_now && data?.payments_enabled ? <Button size="sm" title={t('payments.pay')} onPress={() => setPaying({ policy, installment: i })} /> : null}
                        </View>
                      </View>
                      {expanded ? (
                        <View style={{ marginTop: 8, gap: 4 }}>
                          <Text variant="caption" color="muted">{t('payments.dueDate')}: {date(i.due_date)}</Text>
                          <Text variant="caption" color="muted">{t('payments.amount')}: {money(i.amount_due)}</Text>
                          <Text variant="caption" color="muted">{t('payments.paidOn')}: {i.paid_at ? date(i.paid_at) : '—'}</Text>
                          {i.receipt ? <DownloadButton handle={`receipt:${policy.id}:${receipt?.id ?? ''}`} fallbackName={`${i.receipt.receipt_no}.pdf`} label={t('payments.receipt')} available={!!receipt?.has_document} /> : null}
                        </View>
                      ) : null}
                    </Card>
                  );
                })}
              </Panel>
            ))}

            <Panel title={t('payments.history')}>
              {(data?.history.length ?? 0) === 0 ? <EmptyState compact icon="receipt-outline" title={t('payments.noHistory')} description={t('payments.noHistoryText')} />
                : data?.history.map((r, i) => (
                  <View key={r.id} style={{ paddingVertical: 12, gap: 8, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                      {/* The left column takes the remaining width and may shrink (minWidth 0); the amount keeps its own width. */}
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text variant="bodyStrong" numberOfLines={1} ellipsizeMode="middle" selectable>{r.receipt_no}</Text>
                        <Text variant="caption" color="muted">{r.policy_number}</Text>
                        <Text variant="caption" color="muted">{dateTime(r.paid_at)} · {tOr(t, `pay.methods.${r.method}`, r.method)}</Text>
                      </View>
                      <Text variant="bodyStrong" style={{ flexShrink: 0 }}>{money(r.total)}</Text>
                    </View>
                    <View style={{ alignSelf: 'flex-start' }}>
                      <DownloadButton handle={`receipt:${r.policy_id}:${r.id}`} fallbackName={`${r.receipt_no}.pdf`} available={r.has_document} />
                    </View>
                  </View>))}
            </Panel>
          </View>
        )}

      {paying ? <PaySheet policy={paying.policy} installment={paying.installment} onClose={() => setPaying(null)} onPaid={reload} /> : null}
    </Screen>
  );
}
