import React, { useState } from 'react';
import { View } from 'react-native';
import { Badge, Banner, Button, Card, EmptyState, ListRow, SegmentedControl, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, InstallmentState, KeyValue, LoadingCards, Panel, PolicyStatus } from '../../components/common';
import DownloadButton from '../../components/DownloadButton';
import RequestSheet, { RequestKind } from '../../components/RequestSheet';
import { useApi } from '../../hooks/useApi';
import { ApiError } from '../../api/client';
import { post } from '../../api/portal';
import { compactMoney, date, dateTime, daysUntil, money, tOr } from '../../lib/format';
import { t } from '../../i18n/t';
import type { PolicyDetail, RenewalView } from '../../api/portalTypes';

const TABS = ['overview', 'coverage', 'premiums', 'documents', 'activity'] as const;
const FAMILY_TABS = ['overview', 'coverage', 'premiums', 'documents', 'activity', 'servicing'] as const;
type TabKey = (typeof FAMILY_TABS)[number];

/** Renewal status and, only when the renewal engine is waiting for it, acceptance of renewed terms. */
function Renewal({ policyId }: { policyId: string }) {
  const { data, error, reload } = useApi<RenewalView>(`/policies/${encodeURIComponent(policyId)}/renewal`);
  const [busy, setBusy] = useState(false);
  if (error || !data) return null;
  const n = data.next;
  async function answer(accepted: boolean) {
    setBusy(true);
    try { await post(`/policies/${encodeURIComponent(policyId)}/renewal/acceptance`, { accepted }); await reload(); } finally { setBusy(false); }
  }
  return (
    <Panel title={t('renewal.title')}>
      {n ? (
        <>
          <KeyValue label={t('renewal.next')}>{`${date(n.due_date)} · ${money(n.payable)}`}</KeyValue>
          <KeyValue label={t('renewal.type')}>{n.renewal_type_label}</KeyValue>
          <KeyValue label={t('renewal.window')} last>{n.days_until >= 0 ? t('renewal.inDays', { days: n.days_until }) : t('renewal.overdueBy', { days: Math.abs(n.days_until) })}</KeyValue>
        </>
      ) : <Text variant="callout" color="muted">{t('renewal.none')}</Text>}
      {data.eligible === false && data.eligibility_message ? <Banner tone="warning" title={data.eligibility_message} style={{ marginTop: 8 }} /> : null}
      {data.case?.can.accept ? (
        <Card variant="sunken" style={{ marginTop: 10 }}>
          <Text variant="bodyStrong">{t('renewal.acceptTitle')}</Text>
          <Text variant="caption" color="muted">{t('renewal.acceptText', { amount: money(data.case.quoted_amount) })}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Button title={t('renewal.accept')} disabled={busy} onPress={() => answer(true)} style={{ flex: 1 }} />
            <Button title={t('renewal.decline')} variant="outline" disabled={busy} onPress={() => answer(false)} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : null}
      {data.case?.can.pay ? <Text variant="caption" color="muted" style={{ marginTop: 8 }}>{t('renewal.payFromPayments')}</Text> : null}
    </Panel>
  );
}

function StatusBanner({ p, onPay }: { p: PolicyDetail; onPay: () => void }) {
  const k = p.status_key;
  const pay = { actionLabel: t('policy.payNow'), onAction: onPay };
  if (k === 'grace_period') return <Banner tone="warning" title={t('policy.banner.grace.title')} description={t('policy.banner.grace.text', { date: date(p.premium.grace_until || p.grace_period_end_date), amount: money(p.premium.due_now) })} {...pay} />;
  if (k === 'lapsed') return <Banner tone="danger" title={t('policy.banner.lapsed.title')} description={t('policy.banner.lapsed.text')} />;
  if (k === 'pending_issuance' || k === 'issued') return <Banner tone="info" title={t('policy.banner.pending.title')} description={t('policy.banner.pending.text')} />;
  if (k === 'cancelled') return <Banner tone="danger" title={t('policy.banner.cancelled.title')} description={t('policy.banner.cancelled.text')} />;
  if (k === 'expired' || k === 'matured' || k === 'surrendered') return <Banner tone="info" title={t(`policy.banner.${k}.title`)} description={t(`policy.banner.${k}.text`)} />;
  if (k === 'reinstated') return <Banner tone="success" title={t('policy.banner.reinstated.title')} description={t('policy.banner.reinstated.text')} />;
  if (p.in_force && p.premium.due_now > 0) return <Banner tone="warning" title={t('policy.banner.due.title')} description={t('policy.banner.due.text', { amount: money(p.premium.due_now) })} {...pay} />;
  const d = daysUntil(p.premium.next_due_date);
  if (p.in_force && d != null && d >= 0 && d <= 14) return <Banner tone="info" title={t('policy.banner.soon.title')} description={t('policy.banner.soon.text', { date: date(p.premium.next_due_date), amount: money(p.premium.next_due_amount) })} {...pay} />;
  return null;
}

export default function PolicyDetailScreen({ route, navigation }: { route: any; navigation: any }) {
  const id: string = route.params.id;
  const { data: p, error, loading, reload } = useApi<PolicyDetail>(`/policies/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<TabKey>('overview');
  const [dialog, setDialog] = useState<RequestKind | null>(null);

  const head = <ScreenHeader title={p?.product_name ?? t('nav.policies')} subtitle={p ? (p.policy_number || t('policies.numberPending')) : undefined} leading="back" />;
  if (error && !p) {
    const missing = (error as ApiError).code === 'NOT_FOUND';
    return <Screen header={head} padded>{missing
      ? <EmptyState icon="search" title={t('policy.notFound')} description={t('policy.notFoundText')} actionLabel={t('policy.backToPolicies')} onAction={() => navigation.goBack()} />
      : <ErrorView error={error} onRetry={reload} />}</Screen>;
  }
  if (loading || !p) return <Screen header={head} padded scrollable><LoadingCards count={3} height={110} /></Screen>;

  const tabs = p.segment === 'family' ? (p.restricted ? (['overview', 'coverage'] as const) : FAMILY_TABS) : TABS;
  const goPay = () => navigation.navigate('Tabs', { screen: 'Payments' });

  return (
    <Screen header={head} scrollable padded refreshing={loading} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <PolicyStatus statusKey={p.status_key} />
        {p.family ? <Badge label={`${t(`plan.${p.family.plan_type}`)} · ${p.family.family_name}`} tone="brand" size="sm" /> : null}
      </View>
      {p.in_force && !p.restricted ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title={t('policy.fileClaim')} variant="outline" onPress={() => navigation.navigate('NewClaim', { policyId: p.id })} style={{ flex: 1 }} />
          <Button title={t('policy.premiums')} onPress={goPay} style={{ flex: 1 }} />
        </View>
      ) : null}
      {p.family ? <Button size="sm" variant="ghost" title={t('family.backToFamily')} onPress={() => navigation.navigate('FamilyDetail', { id: p.family!.family_id })} /> : null}
      {p.restricted ? <Banner tone="info" title={t('family.restricted.title')} description={t('family.restricted.text', { name: p.policyholder.name || '' })} /> : null}
      <StatusBanner p={p} onPay={goPay} />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {[{ k: 'sumAssured', v: compactMoney(p.sum_assured) }, { k: 'premium', v: p.installment_amount != null ? `${money(p.installment_amount)} / ${t(`frequency.${p.premium_frequency}`)}` : '—' },
          { k: 'effective', v: date(p.effective_date) }, { k: 'expiry', v: date(p.expiry_date || p.maturity_date) }].map((x) => (
          <Card key={x.k} style={{ width: '48.5%' }} padding="md"><Text variant="overline" color="subtle" uppercase>{t(`policies.${x.k}`)}</Text><Text variant="title3">{x.v}</Text></Card>
        ))}
      </View>

      <SegmentedControl variant="chips" value={tab} onChange={setTab} segments={tabs.map((k) => ({ value: k as TabKey, label: t(`policy.tab.${k}`) }))} />

      {tab === 'overview' ? (
        <View style={{ gap: 12 }}>
          {p.restricted ? (
            <Panel title={t('policy.policyholder')}><KeyValue label={t('profile.name')} last>{p.policyholder.name}</KeyValue><Text variant="caption" color="subtle">{t('family.restricted.private')}</Text></Panel>
          ) : (
            <Panel title={t('policy.policyholder')}>
              <KeyValue label={t('profile.name')}>{p.policyholder.name}</KeyValue>
              <KeyValue label={t('profile.policyholderId')}>{p.policyholder.policyholder_id}</KeyValue>
              <KeyValue label={t('profile.cnic')}>{p.policyholder.cnic_masked}</KeyValue>
              <KeyValue label={t('profile.dob')}>{date(p.policyholder.dob)}</KeyValue>
              <KeyValue label={t('profile.email')}>{p.policyholder.email}</KeyValue>
              <KeyValue label={t('profile.phone')} last>{p.policyholder.phone}</KeyValue>
            </Panel>
          )}
          {p.insured_lives ? (
            <Panel title={t('family.insuredPersons')}>
              <Text variant="caption" color="muted">{p.family?.plan_type === 'Floater' ? t('family.floaterInsuredNote') : t('family.bundleInsuredNote')}</Text>
              {p.insured_lives.map((c, i) => (
                <KeyValue key={c.customer_id} label={tOr(t, `relationship.${c.relationship}`, c.relationship)} last={i === p.insured_lives!.length - 1}>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text variant="calloutStrong" align="right">{c.name}{c.is_you ? ` (${t('family.you')})` : ''}{c.is_minor ? ` · ${t('policy.minor')}` : ''}</Text>
                    <Text variant="caption" color="subtle">{c.dob ? date(c.dob) : c.age != null ? t('family.ageYears', { count: c.age }) : ''}</Text>
                  </View>
                </KeyValue>
              ))}
            </Panel>
          ) : (
            <Panel title={t('policy.insured')}>
              <KeyValue label={t('profile.name')}>{p.insured.name}</KeyValue>
              <KeyValue label={t('policy.relationship')}>{p.insured.relationship === 'Self' ? t('policy.self') : p.insured.relationship}</KeyValue>
              <KeyValue label={t('profile.dob')} last>{date(p.insured.dob)}</KeyValue>
            </Panel>
          )}
          {p.segment === 'family' && !p.restricted && p.in_force ? <Renewal policyId={p.id} /> : null}
          <Panel title={t('policy.plan')}>
            <KeyValue label={t('policy.product')}>{p.plan.product_name}</KeyValue>
            <KeyValue label={t('policy.planType')}>{t(`insuranceType.${p.plan.insurance_type}`)}</KeyValue>
            <KeyValue label={t('policy.term')}>{t('policy.years', { count: p.plan.term_years })}</KeyValue>
            <KeyValue label={t('policy.annualPremium')} last>{money(p.annual_premium)}</KeyValue>
          </Panel>
          <Panel title={t('policy.dates')}>
            <KeyValue label={t('policies.effective')}>{date(p.effective_date)}</KeyValue>
            <KeyValue label={t('policies.expiry')}>{date(p.expiry_date)}</KeyValue>
            {p.maturity_date && p.maturity_date !== p.expiry_date ? <KeyValue label={t('policy.maturity')}>{date(p.maturity_date)}</KeyValue> : null}
            <KeyValue label={t('policy.issued')}>{date(p.issued_at)}</KeyValue>
            <KeyValue label={t('policy.freeLook')} last={!p.in_force}>{date(p.free_look_end_date)}</KeyValue>
            {p.in_force ? <KeyValue label={t('policy.nextDue')} last>{p.premium.next_due_date ? `${date(p.premium.next_due_date)} · ${money(p.premium.next_due_amount)}` : t('policy.noneDue')}</KeyValue> : null}
          </Panel>
        </View>
      ) : null}

      {tab === 'coverage' ? (
        <View style={{ gap: 12 }}>
          <Panel title={t('policy.coverage')}>
            <KeyValue label={t('policies.sumAssured')} last={p.coverage.benefits.length === 0}>{money(p.coverage.sum_assured)}</KeyValue>
            {p.coverage.benefits.length === 0 ? <Text variant="callout" color="muted" style={{ marginTop: 8 }}>{t('policy.noBenefits')}</Text>
              : p.coverage.benefits.map((b, i) => <KeyValue key={b.category} label={b.label} last={i === p.coverage.benefits.length - 1}>{b.sum_assured ? money(b.sum_assured) : '—'}</KeyValue>)}
          </Panel>
          <Panel title={t('policy.riders')}>
            {p.coverage.riders.length === 0 ? <Text variant="callout" color="muted">{t('policy.noRiders')}</Text>
              : p.coverage.riders.map((r, i) => <KeyValue key={r.name} label={r.name} last={i === p.coverage.riders.length - 1}>{`${money(r.sum_assured)}${r.annual_premium ? ` · ${money(r.annual_premium)} / ${t('frequency.Annual')}` : ''}`}</KeyValue>)}
          </Panel>
          <Panel title={t('policy.nominees')}>
            {p.nominees.length === 0 ? <Text variant="callout" color="muted">{t('policy.noNominees')}</Text>
              : p.nominees.map((n, i) => (
                <KeyValue key={i} label={`${n.name}${n.is_minor ? ` (${t('policy.minor')})` : ''}`} last={i === p.nominees.length - 1}>{`${n.relationship} · ${n.share_pct}%`}</KeyValue>))}
            <Text variant="caption" color="subtle" style={{ marginTop: 8 }}>{t('policy.nomineeChange')}</Text>
          </Panel>
        </View>
      ) : null}

      {tab === 'premiums' ? (
        <Panel title={t('policy.schedule')} action={p.in_force ? <Button size="sm" variant="ghost" title={t('policy.goToPayments')} onPress={goPay} /> : undefined}>
          {p.premium_schedule.length === 0 ? <EmptyState compact icon="calendar-outline" title={t('policy.noSchedule')} />
            : p.premium_schedule.map((s, i) => (
              <KeyValue key={s.id} label={`#${s.installment_no} · ${date(s.due_date)}`} last={i === p.premium_schedule.length - 1}>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text variant="calloutStrong">{money(s.amount_due)}</Text>
                  <InstallmentState state={s.state} />
                </View>
              </KeyValue>))}
        </Panel>
      ) : null}

      {tab === 'documents' ? (
        <Panel title={t('policy.documents')}>
          {p.documents.length === 0 ? <EmptyState compact icon="document-outline" title={t('documents.none')} description={t('documents.noneText')} />
            : p.documents.map((d) => (
              <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 8 }}>
                <View style={{ flex: 1 }}><Text variant="bodyStrong" numberOfLines={2}>{d.title}</Text><Text variant="caption" color="subtle">{date(d.date)}</Text></View>
                <DownloadButton handle={d.id} fallbackName={`${d.title}.pdf`} available={d.available} />
              </View>))}
        </Panel>
      ) : null}

      {tab === 'servicing' && p.segment === 'family' && !p.restricted ? (
        <Panel title={t('family.servicing')}>
          <Text variant="caption" color="muted">{t('family.servicingNote')}</Text>
          {p.actions.filter((a) => a.available).length === 0
            ? <EmptyState compact icon="construct-outline" title={t('family.noActions')} description={t('family.noActionsText')} />
            : p.actions.filter((a) => a.available).map((a) => <ListRow key={a.kind} title={t(`request.kind.${a.kind}`)} subtitle={t(`request.hint.${a.kind}`)} onPress={() => setDialog(a.kind as RequestKind)} />)}
          {p.actions.some((a) => !a.available && a.reason === 'POLICY_NOT_IN_FORCE') ? <Text variant="caption" color="subtle">{t('family.notInForceNote')}</Text> : null}
        </Panel>
      ) : null}

      {tab === 'activity' ? (
        <Panel title={t('policy.activity')}>
          {p.timeline.length === 0 ? <EmptyState compact icon="time-outline" title={t('policy.noActivity')} />
            : p.timeline.map((e) => (
              <View key={e.id} style={{ paddingVertical: 8, borderLeftWidth: 2, borderLeftColor: '#93c5fd', paddingLeft: 12, marginLeft: 4 }}>
                <Text variant="bodyStrong">{e.title}{e.detail?.amount ? ` · ${money(e.detail.amount)}` : ''}</Text>
                <Text variant="caption" color="subtle">{dateTime(e.at)}{e.detail?.receipt_no ? ` · ${e.detail.receipt_no}` : ''}{e.detail?.claim_number ? ` · ${e.detail.claim_number}` : ''}</Text>
              </View>))}
        </Panel>
      ) : null}

      {dialog && p.family ? <RequestSheet familyId={p.family.family_id} kind={dialog} policy={{ id: p.id, policy_number: p.policy_number, sum_assured: p.sum_assured }} onClose={() => setDialog(null)} onDone={() => undefined} /> : null}
    </Screen>
  );
}
