import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { Badge, Banner, Button, Card, EmptyState, Select, SegmentedControl, StatTile, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, KeyValue, LoadingCards, Panel } from '../../components/common';
import PolicyCardItem from '../../components/PolicyCardItem';
import RequestSheet, { RequestKind } from '../../components/RequestSheet';
import { useApi } from '../../hooks/useApi';
import { useCustomer } from '../../context/CustomerContext';
import { ApiError } from '../../api/client';
import { post } from '../../api/portal';
import { compactMoney, date, dateTime, money, tOr } from '../../lib/format';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { BeneficiariesView, FamilyGroupSummary, FamilyOverview, FamilyRequest, MemberRow } from '../../api/portalTypes';

export function FamilyListScreen({ navigation }: { navigation: any }) {
  const { data, error, loading, reload } = useApi<{ items: FamilyGroupSummary[] }>('/family');
  return (
    <Screen header={<ScreenHeader title={t('family.title')} subtitle={t('family.subtitle')} leading="back" />}
      scrollable padded refreshing={loading && !!data} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      {error && !data ? <ErrorView error={error} onRetry={reload} />
        : loading && !data ? <LoadingCards count={2} height={160} />
        : (data?.items.length ?? 0) === 0 ? <EmptyState icon="people-outline" title={t('family.none')} description={t('family.noneText')} />
        : data?.items.map((g) => (
          <Card key={g.id} onPress={() => navigation.navigate('FamilyDetail', { id: g.id })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text variant="title3">{g.name}</Text>
                <Text variant="caption" color="muted">{g.plan_types.map((p) => t(`plan.${p}`)).join(' · ')} · {t(`family.role.${g.role}`)}</Text>
              </View>
              <Badge label={t('family.open')} tone="brand" size="sm" />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, rowGap: 6 }}>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('family.members')}</Text><Text variant="bodyStrong">{g.members.listed} · {t('family.insuredCount', { count: g.members.insured })}</Text></View>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('family.coverage')}</Text><Text variant="bodyStrong">{compactMoney(g.totals.coverage)}</Text></View>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('dashboard.nextPremium')}</Text><Text variant="bodyStrong">{g.totals.next_premium ? money(g.totals.next_premium.amount) : t('dashboard.none')}</Text></View>
              <View style={{ width: '50%' }}><Text variant="caption" color="subtle">{t('dashboard.outstanding')}</Text><Text variant="bodyStrong">{money(g.totals.outstanding)}</Text></View>
            </View>
          </Card>
        ))}
    </Screen>
  );
}

function Members({ o, onRequest }: { o: FamilyOverview; onRequest: (k: RequestKind, m?: MemberRow) => void }) {
  const canEdit = o.role === 'head' && o.totals.policies_in_force > 0;
  return (
    <Panel title={t('family.membersTitle')} action={canEdit ? <Button size="sm" variant="outline" title={t('family.addMember')} onPress={() => onRequest('MEMBER_ADD')} /> : undefined}>
      <Text variant="caption" color="muted" style={{ marginBottom: 6 }}>{t('family.membersNote')}</Text>
      {o.members_list.map((r) => (
        <Card key={`${r.key}-${r.policy_id}`} variant="sunken" style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{r.name}{r.is_you ? ` (${t('family.you')})` : ''}{r.is_minor ? ` · ${t('policy.minor')}` : ''}</Text>
              <Text variant="caption" color="muted">{tOr(t, `relationship.${r.relationship}`, r.relationship)} · {r.dob ? `${date(r.dob)} (${r.age ?? '—'})` : r.age ?? '—'}</Text>
            </View>
            {r.kind === 'insured'
              ? <Badge label={t(`family.eligibility.${r.eligibility}`)} tone={r.eligibility === 'covered' ? 'success' : r.eligibility === 'pending' ? 'info' : 'neutral'} size="sm" />
              : <Badge label={t('family.nomineeOnly')} tone="neutral" size="sm" />}
          </View>
          <Text variant="caption" color="subtle">{r.policy_number} · {t(`plan.${r.plan_type}`)}</Text>
          <Text variant="calloutStrong">{r.coverage ? `${money(r.coverage.amount)} (${r.coverage.kind === 'shared_pool' ? t('family.sharedPool') : t('family.ownCover')})` : r.share_pct != null ? `${r.share_pct}% ${t('family.ofBenefit')}` : '—'}</Text>
          {r.kind === 'nominee' && r.also_insured ? <Text variant="micro" color="subtle">{t('family.alsoInsured')}</Text> : null}
          {r.can_manage && r.eligibility !== 'ended' && o.totals.policies_in_force > 0 && !(r.relationship === 'Self' && r.kind === 'insured') ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Button size="sm" variant="soft" title={t('family.correct')} onPress={() => onRequest('MEMBER_CORRECTION', r)} />
              <Button size="sm" variant="soft" tone="danger" title={t('common.remove')} onPress={() => onRequest('MEMBER_REMOVE', r)} />
            </View>
          ) : null}
        </Card>
      ))}
    </Panel>
  );
}

function Beneficiaries({ o, onRequest }: { o: FamilyOverview; onRequest: (k: RequestKind, policyId: string, view: BeneficiariesView) => void }) {
  const policies = o.arrangements.flatMap((a) => a.policies).filter((p) => p.access !== 'summary');
  const [pid, setPid] = useState(policies[0]?.id || '');
  const { data, error, loading, reload } = useApi<BeneficiariesView>(pid ? `/family/${encodeURIComponent(o.id)}/beneficiaries?policy_id=${encodeURIComponent(pid)}` : null);
  if (policies.length === 0) return <EmptyState icon="lock-closed-outline" title={t('family.noBeneficiaryAccess')} description={t('family.noBeneficiaryAccessText')} />;
  return (
    <View style={{ gap: 12 }}>
      {policies.length > 1 ? <Select label={t('pay.policy')} value={pid} options={policies.map((p) => ({ value: p.id, label: `${p.policy_number} — ${p.product_name}`, description: p.holder_name }))} onSelect={setPid} /> : null}
      {error && !data ? <ErrorView error={error} onRetry={reload} /> : loading && !data ? <LoadingCards count={1} height={140} /> : data ? (
        <>
          {!data.complete ? <Banner tone="warning" title={t('family.nominationIncomplete')} description={t('family.nominationIncompleteText', { total: data.total_share })} /> : null}
          <Panel title={t('family.beneficiaries')} action={data.can_request_change ? <Button size="sm" variant="outline" title={t('family.changeNominees')} onPress={() => onRequest('NOMINEE_CHANGE', pid, data)} /> : undefined}>
            {data.beneficiaries.length === 0 ? <Text variant="callout" color="muted">{t('policy.noNominees')}</Text> : (
              <>
                {data.beneficiaries.map((b, i) => (
                  <KeyValue key={b.id} label={b.name} last={false}>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text variant="calloutStrong">{tOr(t, `relationship.${b.relationship}`, b.relationship)} · {b.share_pct}%</Text>
                      {b.is_minor ? <Text variant="caption" color="subtle">{t('policy.minor')} · {t('family.guardian')}: {b.guardian_name || '—'}</Text> : null}
                    </View>
                  </KeyValue>
                ))}
                <KeyValue label={t('family.total')} last><Text variant="calloutStrong" color={data.complete ? 'success' : 'danger'}>{data.total_share}%</Text></KeyValue>
              </>
            )}
            {!data.can_request_change && data.change_blocked_reason ? <Text variant="caption" color="subtle" style={{ marginTop: 8 }}>{t(`family.blocked.${data.change_blocked_reason}`)}</Text> : null}
            <Text variant="caption" color="subtle" style={{ marginTop: 8 }}>{t('family.nomineeNotInsured')}</Text>
          </Panel>
          <Panel title={t('family.versionHistory')}>
            {data.versions.length === 0 ? <Text variant="callout" color="muted">{t('family.noVersions')}</Text> : data.versions.map((v) => (
              <View key={v.sequence} style={{ paddingVertical: 8, borderLeftWidth: 2, borderLeftColor: '#93c5fd', paddingLeft: 12, marginLeft: 4 }}>
                <Text variant="bodyStrong">{t('family.version', { n: v.sequence })} · {t(`family.changedBy.${v.changed_by}`)}</Text>
                <Text variant="caption" color="subtle">{dateTime(v.at)}{v.reason ? ` · ${v.reason}` : ''}</Text>
                <Text variant="caption" color="muted">{v.beneficiaries.map((b) => `${b.name} ${b.share_pct}%`).join(', ')}</Text>
              </View>))}
          </Panel>
        </>) : null}
    </View>
  );
}

function Requests({ familyId, refreshKey }: { familyId: string; refreshKey: number }) {
  const { data, error, loading, reload } = useApi<{ items: FamilyRequest[] }>('/family/requests');
  React.useEffect(() => { if (refreshKey) reload(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = (data?.items || []).filter((r) => r.family_id === familyId);
  async function withdraw(id: string) {
    try { await post(`/family/requests/${id}/withdraw`); Alert.alert(t('family.withdrawn')); reload(); }
    catch (e) { Alert.alert(t('error.title'), errorText(e as ApiError)); }
  }
  if (error && !data) return <ErrorView error={error} onRetry={reload} />;
  return (
    <Panel title={t('family.requests')}>
      <Text variant="caption" color="muted" style={{ marginBottom: 6 }}>{t('family.requestsNote')}</Text>
      {loading && !data ? <LoadingCards count={1} height={80} /> : items.length === 0 ? <EmptyState compact icon="mail-outline" title={t('family.noRequests')} description={t('family.noRequestsText')} />
        : items.map((r) => (
          <Card key={r.id} variant="sunken" style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text variant="bodyStrong" selectable>{r.reference}</Text>
              <Badge label={t(`family.requestStatus.${r.status}`)} tone={r.status === 'SUBMITTED' ? 'info' : 'neutral'} size="sm" />
            </View>
            <Text variant="callout">{t(`request.kind.${r.kind}`)}</Text>
            <Text variant="caption" color="muted">{r.policy_number} · {dateTime(r.created_at)}</Text>
            {r.status === 'SUBMITTED' ? <Button size="sm" variant="soft" tone="danger" title={t('family.withdraw')} onPress={() => withdraw(r.id)} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
          </Card>))}
    </Panel>
  );
}

const TABS = ['policies', 'members', 'beneficiaries', 'requests'] as const;
type Tab = (typeof TABS)[number];

export function FamilyDetailScreen({ route, navigation }: { route: any; navigation: any }) {
  const id: string = route.params.id;
  const { reloadFamilies } = useCustomer();
  const { data: o, error, loading, reload } = useApi<FamilyOverview>(`/family/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<Tab>('policies');
  const [dialog, setDialog] = useState<{ kind: RequestKind; member?: MemberRow | null; policyId?: string; view?: BeneficiariesView | null } | null>(null);
  const [reqKey, setReqKey] = useState(0);

  const head = <ScreenHeader title={o?.name ?? t('family.title')} subtitle={o ? `${o.plan_types.map((x) => t(`plan.${x}`)).join(' · ')} · ${t(`family.role.${o.role}`)}` : undefined} leading="back" />;
  if (error && !o) {
    return <Screen header={head} padded>{(error as ApiError).code === 'NOT_FOUND'
      ? <EmptyState icon="search" title={t('family.notFound')} description={t('family.notFoundText')} actionLabel={t('family.title')} onAction={() => navigation.goBack()} />
      : <ErrorView error={error} onRetry={reload} />}</Screen>;
  }
  if (loading || !o) return <Screen header={head} padded scrollable><LoadingCards count={3} height={120} /></Screen>;

  const allPolicies = o.arrangements.flatMap((a) => a.policies);
  const claimPolicy = allPolicies.find((p) => p.access !== 'summary' && p.in_force);
  const dialogPolicy = (pid?: string) => allPolicies.find((p) => p.id === pid) || allPolicies.find((p) => p.access === 'owner' && p.in_force) || claimPolicy;
  const p = dialog ? dialogPolicy(dialog.policyId || dialog.member?.policy_id) : undefined;
  const half = { width: '48.5%' as const };

  return (
    <Screen header={head} scrollable padded refreshing={loading} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {claimPolicy ? <Button title={t('policy.fileClaim')} variant="outline" onPress={() => navigation.navigate('NewClaim', { policyId: claimPolicy.id })} style={{ flex: 1 }} /> : null}
        <Button title={t('nav.payments')} onPress={() => navigation.navigate('Tabs', { screen: 'Payments' })} style={{ flex: 1 }} />
      </View>
      {o.members.insured_total > o.members.insured ? <Banner tone="info" title={t('family.someNotInForce')} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <View style={half}><StatTile label={t('family.members')} value={o.members.listed} caption={t('family.listedNote')} icon="people-outline" tone="brand" /></View>
        <View style={half}><StatTile label={t('family.insured')} value={o.members.insured} caption={t('family.nomineesCount', { count: o.members.nominees })} icon="shield-checkmark-outline" tone="success" /></View>
        <View style={half}><StatTile label={t('family.coverage')} value={compactMoney(o.totals.coverage)} caption={t('family.coverageNote')} icon="checkmark-circle-outline" tone="success" /></View>
        <View style={half}><StatTile label={t('dashboard.nextPremium')} value={o.totals.next_premium ? money(o.totals.next_premium.amount) : t('dashboard.none')} caption={o.totals.next_premium ? `${date(o.totals.next_premium.date)} · ${o.totals.next_premium.policy_number}` : t('dashboard.noUpcoming')} icon="calendar-outline" tone="info" /></View>
        <View style={half}><StatTile label={t('dashboard.outstanding')} value={money(o.totals.outstanding)} caption={o.totals.outstanding > 0 ? t('dashboard.outstandingDue') : t('dashboard.nothingDue')} icon="cash-outline" tone={o.totals.outstanding > 0 ? 'danger' : 'neutral'} /></View>
        <View style={half}><StatTile label={t('dashboard.openClaims')} value={o.totals.open_claims} caption={t('dashboard.openClaimsNote')} icon="medkit-outline" tone="neutral" /></View>
      </View>
      <SegmentedControl variant="chips" value={tab} onChange={setTab} segments={TABS.map((k) => ({ value: k, label: t(`family.tab.${k}`) }))} />

      {tab === 'policies' ? (
        <View style={{ gap: 14 }}>
          {o.arrangements.map((a) => (
            <View key={a.family_policy_id} style={{ gap: 8 }}>
              <Text variant="title3">{t(`plan.${a.plan_type}`)} <Text variant="caption" color="subtle">· {t('family.since')} {date(a.effective_date)}</Text></Text>
              {a.plan_type === 'Floater' && a.shared_sum_insured != null ? <Text variant="caption" color="muted">{t('family.sharedPoolNote', { amount: money(a.shared_sum_insured) })}</Text> : null}
              {a.plan_type === 'LifeBundle' && a.discount_percentage != null ? <Text variant="caption" color="muted">{t('family.bundleNote', { pct: a.discount_percentage })}</Text> : null}
              {a.policies.map((pol) => <PolicyCardItem key={pol.id} p={pol} />)}
            </View>))}
          {allPolicies.length === 0 ? <EmptyState icon="documents-outline" title={t('policies.none')} /> : null}
        </View>
      ) : null}
      {tab === 'members' ? <Members o={o} onRequest={(kind, member) => setDialog({ kind, member })} /> : null}
      {tab === 'beneficiaries' ? <Beneficiaries o={o} onRequest={(kind, policyId, view) => setDialog({ kind, policyId, view })} /> : null}
      {tab === 'requests' ? <Requests familyId={o.id} refreshKey={reqKey} /> : null}

      {dialog ? <RequestSheet familyId={o.id} kind={dialog.kind} policy={p ? { id: p.id, policy_number: p.policy_number, sum_assured: p.sum_assured } : undefined} member={dialog.member} nominees={dialog.view}
        onClose={() => setDialog(null)} onDone={() => { setReqKey((n) => n + 1); reloadFamilies(); }} /> : null}
    </Screen>
  );
}
