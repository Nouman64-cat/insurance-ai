import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { ActionSheetIOS, Platform } from 'react-native';
import { Banner, Button, EmptyState, ProgressBar, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ClaimStatus, ErrorView, KeyValue, LoadingCards, Panel } from '../../components/common';
import { useApi } from '../../hooks/useApi';
import { ApiError } from '../../api/client';
import { upload } from '../../api/portal';
import { PickedFile, filePart, pickDocument, pickPhoto } from '../../lib/files';
import { date, dateTime, money } from '../../lib/format';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { ClaimDetail } from '../../api/portalTypes';

const STEP_COLOR: Record<string, string> = { complete: '#10b981', current: '#2d6fe6', attention: '#f59e0b', skipped: '#cbd5e1', pending: '#e2e8f0' };

function Tracker({ c }: { c: ClaimDetail }) {
  if (!c.stages) return null;
  return (
    <View style={{ gap: 10 }} accessibilityLabel={t('claim.journey')}>
      {c.stages.map((s) => (
        <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} accessibilityState={{ selected: s.state === 'current' }}>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: STEP_COLOR[s.state], alignItems: 'center', justifyContent: 'center' }}>
            <Text variant="captionStrong" style={{ color: s.state === 'pending' || s.state === 'skipped' ? '#64748b' : '#fff' }}>{s.state === 'complete' ? '✓' : s.step}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong" color={s.state === 'pending' ? 'subtle' : 'default'}>{t(`claim.stage.${s.key}`)}</Text>
            <Text variant="micro" color="subtle">{t(`claim.state.${s.state}`)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export default function ClaimDetailScreen({ route, navigation }: { route: any; navigation: any }) {
  const id: string = route.params.id;
  const submitted: boolean = !!route.params.submitted;
  const { data: c, error, loading, reload } = useApi<ClaimDetail>(`/claims/${encodeURIComponent(id)}`, { pollMs: 30_000 });
  const [uploading, setUploading] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function send(file: PickedFile, key: string) {
    setUploading(key); setNote(null);
    try {
      const form = new FormData();
      form.append('file', filePart(file));
      await upload(`/claims/${encodeURIComponent(id)}/documents/${encodeURIComponent(key)}`, form);
      setNote(t('claim.uploaded'));
      await reload();
    } catch (e) { Alert.alert(t('error.title'), errorText(e as ApiError)); }
    finally { setUploading(null); }
  }

  const choose = (key: string) => {
    const run = async (kind: 'doc' | 'photo' | 'camera') => {
      try {
        const f = kind === 'doc' ? await pickDocument() : await pickPhoto(kind === 'camera');
        if (f) await send(f, key);
      } catch (e) { Alert.alert(t('error.title'), errorText(e as ApiError)); }
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: ['Camera', 'Photos', 'PDF / file', t('common.cancel')], cancelButtonIndex: 3 }, (i) => { if (i === 0) run('camera'); else if (i === 1) run('photo'); else if (i === 2) run('doc'); });
    } else {
      Alert.alert(t('claim.upload'), undefined, [{ text: 'Camera', onPress: () => run('camera') }, { text: 'Photos', onPress: () => run('photo') }, { text: 'PDF / file', onPress: () => run('doc') }, { text: t('common.cancel'), style: 'cancel' }]);
    }
  };

  const head = <ScreenHeader title={c?.claim_number ?? t('claims.title')} subtitle={c ? `${c.product_name} · ${c.policy_number}` : undefined} leading="back" />;
  if (error && !c) {
    return <Screen header={head} padded>{(error as ApiError).code === 'NOT_FOUND'
      ? <EmptyState icon="search" title={t('claim.notFound')} description={t('claim.notFoundText')} actionLabel={t('claim.back')} onAction={() => navigation.goBack()} />
      : <ErrorView error={error} onRetry={reload} />}</Screen>;
  }
  if (loading || !c) return <Screen header={head} padded scrollable><LoadingCards count={3} height={120} /></Screen>;

  const outstanding = c.documents.filter((d) => d.required && d.status !== 'Received');
  return (
    <Screen header={head} scrollable padded refreshing={loading} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <ClaimStatus statusKey={c.status_key} />
      {submitted ? <Banner tone="success" title={t('claim.submitted.title')} description={t('claim.submitted.text')} /> : null}
      {note ? <Banner tone="success" title={note} onDismiss={() => setNote(null)} /> : null}
      {c.eligibility?.status === 'Ineligible' ? <Banner tone="warning" title={t('claim.ineligible.title')} description={`${t('claim.ineligible.text')}${c.eligibility.message ? ` ${c.eligibility.message}` : ''}`} /> : null}
      {c.status_key === 'documents_needed' && outstanding.length > 0 ? <Banner tone="warning" title={t('claim.docsNeeded.title')} description={t('claim.docsNeeded.text', { count: outstanding.length })} /> : null}

      <Panel title={t('claim.journey')}><Tracker c={c} /></Panel>

      <Panel title={t('claim.documents')} action={c.documents_progress ? <Text variant="caption" color="muted">{t('claim.docsProgress', { received: c.documents_progress.received, required: c.documents_progress.required })}</Text> : undefined}>
        {c.documents_progress && c.documents_progress.required > 0 ? <ProgressBar value={c.documents_progress.received / c.documents_progress.required} tone="success" style={{ marginBottom: 8 }} /> : null}
        {c.documents.length === 0 ? <EmptyState compact icon="document-outline" title={t('claim.noDocuments')} description={t('claim.noDocumentsText')} />
          : c.documents.map((d) => (
            <View key={d.key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 8 }}>
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">{d.label}{d.required ? <Text variant="micro" color="danger">  {t('claim.required')}</Text> : null}</Text>
                <Text variant="caption" color="subtle">{d.status === 'Received' ? t('claim.received', { date: date(d.received_at) }) : t('claim.notYet')}{d.file_name ? ` · ${d.file_name}` : ''}</Text>
              </View>
              {d.can_upload ? <Button size="sm" variant="soft" icon="cloud-upload-outline" loading={uploading === d.key} disabled={!!uploading} title={d.status === 'Received' ? t('claim.replace') : t('claim.upload')} onPress={() => choose(d.key)} /> : null}
            </View>))}
        <Text variant="caption" color="subtle" style={{ marginTop: 6 }}>{t('claim.fileRules')}</Text>
      </Panel>

      <Panel title={t('claim.summary')}>
        <KeyValue label={t('claims.type')}>{c.category ? t(`claimType.${c.category}`) : c.claim_type}</KeyValue>
        <KeyValue label={t('claims.incident')}>{date(c.incident_date)}</KeyValue>
        <KeyValue label={t('claim.reported')}>{date(c.reported_date)}</KeyValue>
        <KeyValue label={t('claims.claimed')}>{money(c.claimed_amount)}</KeyValue>
        {c.approved_amount != null ? <KeyValue label={t('claims.approved')}>{money(c.approved_amount)}</KeyValue> : null}
        {c.event?.place ? <KeyValue label={t('claimNew.place')}>{c.event.place}</KeyValue> : null}
        {c.event?.description ? <KeyValue label={t('claimNew.description')} last>{c.event.description}</KeyValue> : null}
      </Panel>

      {c.decision ? (
        <Panel title={t('claim.decision')}>
          <KeyValue label={t('claims.status')}><ClaimStatus statusKey={c.status_key} /></KeyValue>
          {c.decision.amount != null && c.decision.amount > 0 ? <KeyValue label={t('claim.decisionAmount')}>{money(c.decision.amount)}</KeyValue> : null}
          {c.decision.reason ? <KeyValue label={t('claim.reason')}>{c.decision.reason}</KeyValue> : null}
          {c.decision.at ? <KeyValue label={t('claim.decidedOn')} last>{date(c.decision.at)}</KeyValue> : null}
        </Panel>
      ) : null}

      {c.settlement ? (
        <Panel title={t('claim.settlement')}>
          <KeyValue label={t('claim.paidTotal')}>{money(c.settlement.paid_total)}</KeyValue>
          {c.settlement.payouts.map((p, i) => <KeyValue key={i} label={`${p.method} · ${p.status}`} last={i === c.settlement!.payouts.length - 1}>{`${money(p.amount)}${p.reference ? `\n${p.reference}` : ''}`}</KeyValue>)}
        </Panel>
      ) : null}

      <Panel title={t('claim.activity')}>
        {c.timeline.length === 0 ? <EmptyState compact icon="time-outline" title={t('claim.noActivity')} />
          : c.timeline.map((e) => (
            <View key={e.id} style={{ paddingVertical: 8, borderLeftWidth: 2, borderLeftColor: '#93c5fd', paddingLeft: 12, marginLeft: 4 }}>
              <Text variant="bodyStrong">{e.title}</Text><Text variant="caption" color="subtle">{dateTime(e.at)}</Text>
            </View>))}
      </Panel>
    </Screen>
  );
}
