import React from 'react';
import { View } from 'react-native';
import { Banner, Card, EmptyState, ListRow, SectionHeader, StatTile, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ClaimStatus, ErrorView, LoadingCards } from '../../components/common';
import PolicyCardItem from '../../components/PolicyCardItem';
import NoticeRow from '../../components/NoticeRow';
import { useApi } from '../../hooks/useApi';
import { useCustomer } from '../../context/CustomerContext';
import { compactMoney, date, daysUntil, money } from '../../lib/format';
import { t } from '../../i18n/t';
import type { Dashboard } from '../../api/portalTypes';

const Grid = ({ children }: { children: React.ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{children}</View>;
const Cell = ({ children }: { children: React.ReactNode }) => <View style={{ width: '48.5%' }}>{children}</View>;

export default function DashboardScreen({ navigation }: { navigation: any }) {
  const { refreshNotices } = useCustomer();
  const { data, error, loading, reload } = useApi<Dashboard>('/dashboard', { pollMs: 60_000 });
  const refresh = async () => { await reload(); refreshNotices(); };

  if (error && !data) return <Screen header={<ScreenHeader title={t('nav.dashboard')} leading="none" />} padded><ErrorView error={error} onRetry={reload} /></Screen>;
  const s = data?.summary;
  const ld = loading && !data;
  const polDown = !!data && !data.sections.policies;
  const clmDown = !!data && !data.sections.claims;
  const next = s?.next_premium;
  const nextDays = daysUntil(next?.date);
  const expiry = s?.upcoming_expiry?.[0];
  const out = s?.outstanding_amount ?? 0;
  const dash = (v: string | number) => (polDown ? '—' : v);

  return (
    <Screen header={<ScreenHeader title={t('dashboard.welcome', { name: data?.customer.name || '' })} subtitle={data ? `${t('dashboard.policyholderId')}: ${data.customer.policyholder_id}${data.customer.company ? ` · ${data.customer.company}` : ''}` : undefined} leading="none"
      actions={[{ icon: 'notifications-outline', onPress: () => navigation.navigate('Notifications'), accessibilityLabel: t('notifications.title') }]} />}
      scrollable padded refreshing={loading && !!data} onRefresh={refresh} contentContainerStyle={{ gap: 16, paddingVertical: 12 }}>
      {polDown || clmDown ? <Banner tone="warning" title={t('dashboard.partial')} description={polDown ? t('dashboard.partialPolicies') : t('dashboard.partialClaims')} actionLabel={t('common.retry')} onAction={reload} /> : null}

      <Grid>
        <Cell><StatTile loading={ld} label={t('dashboard.totalPolicies')} value={dash(s?.total_policies ?? 0)} caption={t('dashboard.activeCount', { count: s?.active_policies ?? 0 })} icon="documents-outline" tone="brand" onPress={() => navigation.navigate('Policies')} /></Cell>
        <Cell><StatTile loading={ld} label={t('dashboard.coverage')} value={polDown ? '—' : compactMoney(s?.coverage_total)} caption={t('dashboard.coverageNote')} icon="shield-checkmark-outline" tone="success" /></Cell>
        <Cell><StatTile loading={ld} label={t('dashboard.nextPremium')} value={polDown ? '—' : next ? money(next.amount) : t('dashboard.none')} caption={next ? `${date(next.date)} · ${next.policy_number}` : t('dashboard.noUpcoming')} icon="calendar-outline" tone={next && (nextDays ?? 99) <= 7 ? 'warning' : 'info'} onPress={() => navigation.navigate('Payments')} /></Cell>
        <Cell><StatTile loading={ld} label={t('dashboard.outstanding')} value={polDown ? '—' : money(out)} caption={out > 0 ? t('dashboard.outstandingDue') : t('dashboard.nothingDue')} icon="cash-outline" tone={out > 0 ? 'danger' : 'neutral'} onPress={() => navigation.navigate('Payments')} /></Cell>
        <Cell><StatTile loading={ld} label={t('dashboard.openClaims')} value={clmDown && s?.open_claims == null ? '—' : s?.open_claims ?? 0} caption={t('dashboard.openClaimsNote')} icon="medkit-outline" tone="neutral" onPress={() => navigation.navigate('Claims')} /></Cell>
        <Cell><StatTile loading={ld} label={t('dashboard.expiry')} value={polDown ? '—' : expiry ? date(expiry.date) : t('dashboard.none')} caption={expiry ? expiry.policy_number : t('dashboard.noExpiry')} icon="hourglass-outline" tone={expiry ? 'warning' : 'neutral'} /></Cell>
        <Cell><StatTile loading={ld} label={t('dashboard.remaining')} value={polDown ? '—' : money(s?.remaining_amount ?? 0)} caption={t('dashboard.remainingNote')} icon="wallet-outline" tone="neutral" /></Cell>
        <Cell><StatTile loading={ld} label={t('dashboard.inForce')} value={dash(s?.in_force_policies ?? 0)} caption={t('dashboard.inForceNote')} icon="checkmark-circle-outline" tone="success" /></Cell>
      </Grid>

      {data && !data.sections.family ? <Banner tone="warning" title={t('dashboard.partialFamily')} /> : null}
      {data?.family && data.family.length > 0 ? (
        <View style={{ gap: 8 }}>
          <SectionHeader title={t('dashboard.family')} actionLabel={t('common.viewAll')} onAction={() => navigation.navigate('FamilyList')} />
          {data.family.map((g) => (
            <Card key={g.id} onPress={() => navigation.navigate('FamilyDetail', { id: g.id })}>
              <Text variant="title3">{g.name}</Text>
              <Text variant="caption" color="muted">{g.plan_types.map((p) => t(`plan.${p}`)).join(' · ')} · {t(`family.role.${g.role}`)}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, rowGap: 6 }}>
                <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('family.members')}</Text><Text variant="bodyStrong">{g.members.listed} · {t('family.insuredCount', { count: g.members.insured })}</Text></View>
                <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('family.coverage')}</Text><Text variant="bodyStrong">{compactMoney(g.totals.coverage)}</Text></View>
                <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('dashboard.nextPremium')}</Text><Text variant="bodyStrong">{g.totals.next_premium ? money(g.totals.next_premium.amount) : t('dashboard.none')}</Text></View>
                <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('dashboard.outstanding')}</Text><Text variant="bodyStrong">{money(g.totals.outstanding)}</Text></View>
              </View>
              {g.totals.renewals_soon.length > 0 ? <Banner tone="warning" title={t('family.renewalSoon', { policy: g.totals.renewals_soon[0].policy_number, date: date(g.totals.renewals_soon[0].date) })} style={{ marginTop: 8 }} /> : null}
            </Card>
          ))}
        </View>
      ) : null}

      <View style={{ gap: 4 }}>
        <SectionHeader title={t('dashboard.quickActions')} />
        <Card padding="xs">
          <ListRow icon="documents-outline" title={t('dashboard.action.viewPolicies')} onPress={() => navigation.navigate('Policies')} />
          <ListRow icon="card-outline" title={t('dashboard.action.viewPayments')} onPress={() => navigation.navigate('Payments')} />
          <ListRow icon="medkit-outline" title={t('dashboard.action.viewClaims')} onPress={() => navigation.navigate('Claims')} />
          <ListRow icon="download-outline" title={t('dashboard.action.downloadDocuments')} onPress={() => navigation.navigate('Documents')} />
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeader title={t('dashboard.yourPolicies')} actionLabel={t('common.viewAll')} onAction={() => navigation.navigate('Policies')} />
        {ld ? <LoadingCards count={2} height={150} />
          : polDown ? <Text variant="callout" color="muted">{t('dashboard.partialPolicies')}</Text>
          : data && data.policies.length === 0 ? <EmptyState icon="documents-outline" title={t('dashboard.noPolicies')} description={t('dashboard.noPoliciesText')} />
          : data?.policies.slice(0, 4).map((p) => <PolicyCardItem key={p.id} p={p} />)}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeader title={t('dashboard.recentClaims')} actionLabel={t('common.viewAll')} onAction={() => navigation.navigate('Claims')} />
        {ld ? <LoadingCards count={1} height={70} />
          : clmDown ? <Text variant="callout" color="muted">{t('dashboard.partialClaims')}</Text>
          : data && data.claims.length === 0 ? <EmptyState icon="medkit-outline" title={t('claims.none')} description={t('claims.noneText')} />
          : data?.claims.map((c) => (
            <Card key={c.id} onPress={() => navigation.navigate('ClaimDetail', { id: c.id })}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{c.claim_number}</Text>
                  <Text variant="caption" color="muted">{c.category ? t(`claimType.${c.category}`) : c.claim_type} · {date(c.reported_date)}</Text>
                </View>
                <ClaimStatus statusKey={c.status_key} />
              </View>
            </Card>
          ))}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeader title={t('dashboard.notices')} actionLabel={t('common.viewAll')} onAction={() => navigation.navigate('Notifications')} />
        {ld ? <LoadingCards count={1} height={80} />
          : !data || data.notices.length === 0 ? <EmptyState icon="notifications-outline" title={t('notifications.none')} description={t('notifications.noneText')} />
          : <Card>{data.notices.map((n) => <NoticeRow key={n.key} n={n} compact />)}</Card>}
      </View>
    </Screen>
  );
}
