import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, EmptyState, Field, Select, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { CheckRow, DateField, ErrorView, KeyValue, LoadingCards, Panel, Stepper } from '../../components/common';
import { useApi } from '../../hooks/useApi';
import { ApiError } from '../../api/client';
import { post } from '../../api/portal';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import { DEMO } from '../../config';
import { localISO, money, newIdempotencyKey, tOr } from '../../lib/format';
import type { ClaimDetail, ClaimOptions, PolicyCard } from '../../api/portalTypes';

/** Three steps (policy and claim type → what happened → review), with the same rules as the web portal. */
export default function NewClaimScreen({ route, navigation }: { route: any; navigation: any }) {
  const policies = useApi<{ items: PolicyCard[] }>('/policies?segment=all'); // individual + the family policies this customer may act on
  const [policyId, setPolicyId] = useState<string>(route?.params?.policyId || '');
  const options = useApi<ClaimOptions>(policyId ? `/policies/${encodeURIComponent(policyId)}/claims/options` : null);
  const today = localISO();
  const [f, setF] = useState({ category: '', event_date: '', event_end_date: '', cause: '', event_place: '', description: '', claimed_amount: '', hospital: '', diagnosis: '' });
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [coveredId, setCoveredId] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const key = useRef(newIdempotencyKey());

  const eligible = (policies.data?.items || []).filter((p) => !p.pending_issuance);
  useEffect(() => { if (!policyId && eligible.length === 1) setPolicyId(eligible[0].id); }, [policyId, eligible.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const opt = options.data;
  const cats = (opt?.categories || []).filter((c) => c.available);
  const persons = opt?.covered_persons || [];
  const isFamily = opt?.segment === 'family';
  const covered = persons.find((c) => c.id === (coveredId || persons.find((x) => x.is_you)?.id)) || persons[0];
  useEffect(() => { setCoveredId(''); setConsent(false); }, [policyId]);
  useEffect(() => { if (cats.length && !cats.some((c) => c.key === f.category)) setF((x) => ({ ...x, category: cats[0].key })); }, [opt]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const amount = Number(f.claimed_amount);
  const valid1 = !!policyId && !!opt?.can_claim_online && cats.length > 0 && !!f.category && (!isFamily || (!!covered && (!covered.needs_consent || consent)));
  const descLen = f.description.trim().length;
  const problems2: string[] = [];
  if (!f.event_date) problems2.push(t('claimNew.need.eventDate'));
  else if (f.event_date > today) problems2.push(t('claimNew.need.eventFuture'));
  if (f.event_end_date && f.event_date && f.event_end_date < f.event_date) problems2.push(t('claimNew.need.endBefore'));
  if (f.category === 'Hospitalization' && f.hospital.trim().length < 2) problems2.push(t('claimNew.need.hospital'));
  if (descLen < 10) problems2.push(t('claimNew.need.description', { n: 10 - descLen }));
  if (!(amount > 0)) problems2.push(t('claimNew.need.amount'));
  const valid2 = problems2.length === 0;

  async function submit() {
    setBusy(true); setError(null);
    try {
      const body = {
        category: f.category, event_date: f.event_date, event_end_date: f.event_end_date || null, cause: f.cause || null, event_place: f.event_place || null,
        description: f.description.trim(), claimed_amount: amount,
        ...(isFamily && covered ? { covered_person_id: covered.id, consent_confirmed: consent } : {}),
        event_details: Object.fromEntries(Object.entries({ hospital: f.hospital.trim(), diagnosis: f.diagnosis.trim() }).filter(([, v]) => v)),
      };
      const created = await post<ClaimDetail>(`/policies/${encodeURIComponent(policyId)}/claims`, body, { key: key.current });
      navigation.replace('ClaimDetail', { id: created.id, submitted: true });
    } catch (e) {
      const err = e as ApiError;
      setError(err);
      if (err.code === 'DUPLICATE_CLAIM' && err.details?.claim_id) navigation.replace('ClaimDetail', { id: err.details.claim_id });
      else if (!['NETWORK', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'DOMAIN_UNAVAILABLE', 'REQUEST_IN_PROGRESS'].includes(err.code)) key.current = newIdempotencyKey();
    } finally { setBusy(false); }
  }

  // Fills the form with a believable claim for the chosen type, to save time when trying the flow out (same text as the web portal).
  const demo = () => {
    const back = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localISO(d); };
    const start = back(9), end = back(5);
    const cause = (opt?.causes || []).find((c) => c === 'Illness') || (opt?.causes || [])[0] || '';
    setF((x) => f.category === 'Hospitalization'
      ? { ...x, event_date: start, event_end_date: end, cause, event_place: 'Lahore', hospital: 'Shaukat Khanum Memorial Hospital', diagnosis: 'Acute appendicitis',
          description: 'Admitted with severe abdominal pain, diagnosed with appendicitis and operated on. Discharged after four days.', claimed_amount: '185000' }
      : { ...x, event_date: start, event_end_date: end, cause, event_place: 'Lahore', hospital: '', diagnosis: '',
          description: 'Disabled by an accident at work and unable to work since. Medical reports are available.', claimed_amount: '250000' });
  };

  const policy = eligible.find((p) => p.id === policyId);
  const head = <ScreenHeader title={t('claimNew.title')} subtitle={t('claimNew.subtitle')} leading="back" />;
  if (policies.error && !policies.data) return <Screen header={head} padded><ErrorView error={policies.error} onRetry={policies.reload} /></Screen>;

  return (
    <Screen header={head} scrollable padded keyboardAvoiding contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <Stepper steps={[t('claimNew.step.1'), t('claimNew.step.2'), t('claimNew.step.3')]} index={step} />
      {policies.loading && !policies.data ? <LoadingCards count={1} height={220} />
        : eligible.length === 0 ? <EmptyState icon="shield-outline" title={t('claimNew.noPolicy')} description={t('claimNew.noPolicyText')} />
        : (
          <View style={{ gap: 12 }}>
            {error && error.code !== 'DUPLICATE_CLAIM' ? <Banner tone="danger" title={errorText(error)} /> : null}

            {step === 0 ? (
              <Panel title={t('claimNew.step.1')}>
                <View style={{ gap: 14 }}>
                  <Select label={t('claimNew.policy')} value={policyId || null} placeholder={t('claimNew.choosePolicy')}
                    options={eligible.map((p) => ({ value: p.id, label: `${p.policy_number} — ${p.product_name}`, description: `${p.family ? `${t(`plan.${p.family.plan_type}`)} · ` : ''}${t(`policyStatus.${p.status_key}`)}` }))}
                    onSelect={(v) => { setPolicyId(v); setF((x) => ({ ...x, category: '' })); }} />
                  {policyId && options.loading ? <LoadingCards count={1} height={48} /> : null}
                  {policyId && options.error ? <ErrorView error={options.error} onRetry={options.reload} /> : null}
                  {opt ? (
                    <>
                      {opt.note ? <Banner tone="info" title={t('claimNew.lateOk.title')} description={t('claimNew.lateOk.text')} /> : null}
                      {!opt.can_claim_online ? <Banner tone="warning" title={t('claimNew.cannotOnline')} />
                        : cats.length === 0 ? <Banner tone="warning" title={t('claimNew.noBenefit.title')} description={t('claimNew.noBenefit.text')} />
                        : <Select label={t('claimNew.type')} value={f.category || null} options={cats.map((c) => ({ value: c.key, label: t(`claimType.${c.key}`) }))} onSelect={set('category')} />}
                      {isFamily && persons.length > 0 ? (
                        <Select label={t('claimNew.forPerson')} helperText={t('claimNew.forPersonHint')} value={covered?.id || null}
                          options={persons.map((c) => ({ value: c.id, label: `${c.name}${c.is_you ? ` (${t('family.you')})` : ''}`, description: tOr(t, `relationship.${c.relationship}`, c.relationship) }))}
                          onSelect={(v) => { setCoveredId(v); setConsent(false); }} />
                      ) : null}
                      {isFamily && covered?.needs_consent ? <CheckRow value={consent} onChange={setConsent} label={t('claimNew.consent', { name: covered.name })} hint={t('claimNew.consentHint')} /> : null}
                      {isFamily ? <Banner tone="info" title={t('claimNew.nomineeNotCovered.title')} description={t('claimNew.nomineeNotCovered.text')} /> : null}
                      <Banner tone="info" title={t('claims.death.title')} description={isFamily ? t('claims.death.familyText') : t('claims.death.text')} />
                    </>
                  ) : null}
                  <Button title={t('common.next')} disabled={!valid1} onPress={() => setStep(1)} fullWidth />
                </View>
              </Panel>
            ) : null}

            {step === 1 ? (
              <Panel title={t('claimNew.step.2')} action={DEMO ? <Button size="sm" variant="outline" icon="flash-outline" title={t('claimNew.demo')} onPress={demo} /> : undefined}>
                <View style={{ gap: 14 }}>
                  <DateField label={t('claimNew.eventDate')} value={f.event_date} onChange={set('event_date')} maxToday required />
                  <DateField label={t('claimNew.eventEnd')} value={f.event_end_date} onChange={set('event_end_date')} maxToday min={f.event_date || undefined} />
                  {f.category === 'Hospitalization' ? (
                    <>
                      <Field label={`${t('claimNew.hospital')} *`} value={f.hospital} onChangeText={set('hospital')} maxLength={150} />
                      <Field label={t('claimNew.diagnosis')} value={f.diagnosis} onChangeText={set('diagnosis')} maxLength={200} />
                    </>
                  ) : null}
                  <Select label={t('claimNew.cause')} value={f.cause || null} placeholder={t('claimNew.noCause')} clearable options={(opt?.causes || []).map((c) => ({ value: c, label: t(`cause.${c}`) }))} onSelect={set('cause')} />
                  <Field label={t('claimNew.place')} value={f.event_place} onChangeText={set('event_place')} maxLength={200} />
                  <Field label={`${t('claimNew.description')} *`} value={f.description} onChangeText={set('description')} multiline maxLength={4000} inputStyle={{ minHeight: 110 }}
                    helperText={descLen > 0 && descLen < 10 ? t('claimNew.need.description', { n: 10 - descLen }) : t('claimNew.descriptionHint')} />
                  <Field label={`${t('claimNew.amount')} *`} value={f.claimed_amount} onChangeText={set('claimed_amount')} keyboardType="decimal-pad" helperText={t('claimNew.amountHint')} />
                  {problems2.length > 0 ? <Text variant="caption" color="warning">{t('claimNew.need.title')} {problems2.join(' · ')}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button title={t('common.back')} variant="outline" onPress={() => setStep(0)} style={{ flex: 1 }} />
                    <Button title={t('common.next')} disabled={!valid2} onPress={() => setStep(2)} style={{ flex: 1 }} />
                  </View>
                </View>
              </Panel>
            ) : null}

            {step === 2 ? (
              <Panel title={t('claimNew.step.3')}>
                <KeyValue label={t('claimNew.policy')}>{`${policy?.policy_number} — ${policy?.product_name}`}</KeyValue>
                {isFamily && covered ? <KeyValue label={t('claimNew.forPerson')}>{covered.name}</KeyValue> : null}
                <KeyValue label={t('claimNew.type')}>{t(`claimType.${f.category}`)}</KeyValue>
                <KeyValue label={t('claimNew.eventDate')}>{f.event_date}</KeyValue>
                <KeyValue label={t('claimNew.amount')}>{money(amount)}</KeyValue>
                <KeyValue label={t('claimNew.description')} last>{f.description}</KeyValue>
                <Text variant="caption" color="muted" style={{ marginVertical: 10 }}>{t('claimNew.afterSubmit')}</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Button title={t('common.back')} variant="outline" onPress={() => setStep(1)} disabled={busy} style={{ flex: 1 }} />
                  <Button title={t('claimNew.submit')} onPress={submit} loading={busy} disabled={busy} style={{ flex: 1 }} />
                </View>
              </Panel>
            ) : null}
          </View>
        )}
    </Screen>
  );
}
