import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, LoadingCards } from '../../components/common';
import { useApi } from '../../hooks/useApi';
import { t } from '../../i18n/t';
import type { WalkInLead, WalkInPlan, WalkInProfile } from '../../api/types';
import SelfApplicationForm from './SelfApplicationForm';
import FamilyApplicationForm from './FamilyApplicationForm';

type Who = 'Self' | 'Family';

/** My Application: choose who the cover is for, then fill the matching form. Opened from a plan card with its id. */
export default function ApplyScreen({ navigation, route }: { navigation: any; route: any }) {
  const planParam: string = route?.params?.planId || '';
  const me = useApi<WalkInProfile>('/walk-in/me');
  const plans = useApi<{ plans: WalkInPlan[] }>('/walk-in/plans');
  const mine = useApi<{ leads: WalkInLead[] }>('/walk-in/application');
  const [who, setWho] = useState<Who>('Self');
  const [done, setDone] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  // Opened from a plan: a family plan means a family application.
  useEffect(() => {
    const p = plans.data?.plans.find((x) => x.id === planParam);
    if (p) { setWho(p.category === 'Family' ? 'Family' : 'Self'); setFormKey((n) => n + 1); }
  }, [plans.data, planParam]);

  if (done) {
    return (
      <Screen header={<ScreenHeader title={t('walkin.apply.title')} leading="none" />} scrollable padded contentContainerStyle={{ paddingVertical: 24 }}>
        <Card>
          <View style={{ alignItems: 'center', gap: 10, paddingVertical: 12 }}>
            <Text variant="bodyStrong" color="success">{t('walkin.apply.received')}</Text>
            <Text variant="caption" color="muted">{t('walkin.apply.reference')}</Text>
            <Text variant="title1" selectable>{done}</Text>
            <Text variant="callout" color="muted" align="center">{t('walkin.apply.receivedText')}</Text>
            <Button title={t('walkin.apply.track')} onPress={() => { mine.reload(); setDone(null); navigation.navigate('Status'); }} />
          </View>
        </Card>
      </Screen>
    );
  }

  const allPlans = plans.data?.plans ?? [];
  const chosenFamily = allPlans.find((p) => p.id === planParam)?.category === 'Family' ? planParam : '';
  const chosenSelf = allPlans.find((p) => p.id === planParam && p.category !== 'Family') ? planParam : '';

  return (
    <Screen header={<ScreenHeader title={t('walkin.apply.title')} subtitle={t('walkin.apply.subtitle')} leading="none" />}
      scrollable padded keyboardAvoiding contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      {(mine.data?.leads.length ?? 0) > 0
        ? <Banner tone="info" title={t('walkin.apply.existing', { count: mine.data!.leads.length })} actionLabel={t('walkin.nav.status')} onAction={() => navigation.navigate('Status')} /> : null}
      <View style={{ gap: 8 }} accessibilityRole="radiogroup">
        <Text variant="calloutStrong">{t('walkin.who.title')}</Text>
        {(['Self', 'Family'] as const).map((k) => (
          <Card key={k} bordered variant={who === k ? 'outline' : 'surface'} onPress={() => { setWho(k); setFormKey((n) => n + 1); }} accessibilityLabel={t(`walkin.who.${k}`)}>
            <Text variant="bodyStrong" color={who === k ? 'brand' : 'default'}>{t(`walkin.who.${k}`)}</Text>
            <Text variant="caption" color="muted">{t(`walkin.who.${k}Text`)}</Text>
          </Card>
        ))}
      </View>
      {plans.error && !plans.data ? <ErrorView error={plans.error} onRetry={plans.reload} />
        : plans.loading && !plans.data ? <LoadingCards count={2} height={160} />
        : who === 'Family'
          ? <FamilyApplicationForm key={`f${formKey}`} plans={allPlans} plansLoading={plans.loading} email={me.data?.email || ''} initialPlanId={chosenFamily} onDone={(r) => { setDone(r); mine.reload(); }} />
          : <SelfApplicationForm key={`s${formKey}`} plans={allPlans} plansLoading={plans.loading} email={me.data?.email || ''} initialPlanId={chosenSelf} onDone={(r) => { setDone(r); mine.reload(); }} />}
    </Screen>
  );
}
