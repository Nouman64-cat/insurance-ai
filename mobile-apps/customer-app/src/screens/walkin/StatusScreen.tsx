import React from 'react';
import { View } from 'react-native';
import { Badge, Banner, Button, Card, EmptyState, Skeleton, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../context/AuthContext';
import { date, money } from '../../lib/format';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { WalkInLead } from '../../api/types';

// The steps a request moves through, in order. Each is a real state on the insurer's side, not an estimate.
// (Same list and stage rules as customer-portal/app/walk-in/(app)/status/page.tsx.)
const STEPS = [
  ['Submitted', 'submitted'], ['Agent Assigned', 'agent_assigned'], ['In Progress', 'in_progress'], ['Proposal Being Prepared', 'proposal'],
  ['Application Under Review', 'review'], ['Initial Payment', 'payment'], ['Underwriting', 'underwriting'], ['Approved', 'approved'], ['Policy Issued', 'issued'],
] as const;
const POLL_MS = 15000;

function LeadCard({ lead, navigation }: { lead: WalkInLead; navigation: any }) {
  const { signOut } = useAuth();
  const declined = lead.stage === 'Declined';
  const paying = lead.stage === 'Payment Due' || lead.stage === 'Payment Verification';
  const idx = declined ? STEPS.findIndex(([s]) => s === 'Underwriting') : STEPS.findIndex(([s]) => s === (paying ? 'Initial Payment' : lead.stage));
  const slug = declined ? 'declined' : lead.stage === 'Payment Due' ? 'payment_due' : lead.stage === 'Payment Verification' ? 'payment_check' : STEPS[Math.max(idx, 0)][1];
  const issued = lead.stage === 'Policy Issued';
  const tone = declined ? 'danger' : issued ? 'success' : 'brand';
  const reached = (i: number) => i <= idx;

  return (
    <Card>
      <View style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text variant="caption" color="subtle">{t('walkin.status.reference')}</Text>
            <Text variant="title2" selectable>{lead.reference}</Text>
          </View>
          <View style={{ alignItems: 'flex-end', flex: 1 }}>
            <Text variant="bodyStrong" align="right">{lead.plan.label}</Text>
            {lead.applicant_type === 'Family' ? <Badge label={t('walkin.who.Family')} tone="brand" size="sm" /> : null}
            <Text variant="caption" color="subtle">{t('walkin.status.submitted', { date: date(lead.submitted_at) })}</Text>
          </View>
        </View>

        <View>
          <Text variant="bodyStrong" color={tone}>{lead.closed && !declined ? t('walkin.stage.closed') : t(`walkin.stage.${slug}`)}</Text>
          <Text variant="callout" color="muted">{lead.closed && !declined ? t('walkin.stageNote.closed') : t(`walkin.stageNote.${slug}`)}</Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 3 }} accessibilityLabel={t('walkin.status.progress')}>
          {STEPS.map(([name], i) => (
            <View key={name} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: reached(i) && idx >= 0 ? (declined ? '#fb7185' : issued ? '#10b981' : '#2d6fe6') : '#cbd5e1' }} />
          ))}
        </View>
        <View style={{ gap: 4 }}>
          {STEPS.map(([name, s], i) => (
            <Text key={name} variant="caption" color={reached(i) && !declined ? 'default' : 'muted'} style={reached(i) && !declined ? { fontWeight: '700' } : undefined}>
              {reached(i) && !declined ? '✓ ' : '○ '}{t(`walkin.stage.${s}`)}
            </Text>
          ))}
        </View>

        {lead.agent ? (
          <Card variant="sunken" padding="md">
            <Text variant="caption" color="subtle">{t('walkin.status.advisor')}</Text>
            <Text variant="bodyStrong">{lead.agent.name}</Text>
            <Text variant="caption" color="muted" selectable>{[lead.agent.phone, lead.agent.email].filter(Boolean).join('  ·  ')}</Text>
          </Card>
        ) : <Text variant="caption" color="muted">{t('walkin.status.findingAdvisor')}</Text>}

        {lead.payment && !lead.payment.expired && lead.stage === 'Payment Due' ? (
          <Banner tone="warning" title={t('walkin.status.payDue', { amount: money(lead.payment.amount) })}
            description={lead.payment.proof_status === 'Rejected' ? t('walkin.pay.rejectedText') : t('walkin.status.payText')}
            actionLabel={lead.payment.proof_status === 'Rejected' ? t('walkin.status.payAgain') : t('walkin.status.payNow')}
            onAction={() => navigation.navigate('Pay', { token: lead.payment!.token })} />
        ) : null}
        {lead.payment && lead.stage === 'Payment Verification' ? <Banner tone="info" title={t('walkin.pay.checking')} description={t('walkin.pay.checkingText')} /> : null}
        {lead.payment?.expired ? <Banner tone="warning" title={t('walkin.pay.expired')} description={t('walkin.pay.expiredText')} /> : null}

        {issued && lead.handoff.available ? (
          <View style={{ gap: 8 }}>
            <Banner tone="success" title={t('walkin.handoff.title')} description={lead.handoff.account_ready ? t('walkin.handoff.ready') : t('walkin.handoff.pending')} />
            {/* The policyholder app is a different session: end this guest session and the sign-in screen opens. */}
            <Button title={t('walkin.handoff.signIn')} onPress={signOut} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export default function StatusScreen({ navigation }: { navigation: any }) {
  const mine = useApi<{ leads: WalkInLead[] }>('/walk-in/application', { pollMs: POLL_MS });
  return (
    <Screen header={<ScreenHeader title={t('walkin.status.title')} subtitle={t('walkin.status.subtitle')} leading="none" />}
      scrollable padded refreshing={mine.loading && !!mine.data} onRefresh={mine.reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      {mine.loading && !mine.data ? <Skeleton height={220} radius={16} />
        : mine.error && !mine.data ? <EmptyState tone="danger" icon="alert-circle" title={t('error.title')} description={errorText(mine.error)} actionLabel={t('common.retry')} onAction={mine.reload} />
        : (mine.data?.leads.length ?? 0) === 0 ? <EmptyState icon="document-text-outline" title={t('walkin.status.none')} description={t('walkin.status.noneText')} actionLabel={t('walkin.nav.plans')} onAction={() => navigation.navigate('Plans')} />
        : mine.data!.leads.map((l) => <LeadCard key={l.reference} lead={l} navigation={navigation} />)}
    </Screen>
  );
}
