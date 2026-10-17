import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Field, Select, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, KeyValue, LoadingCards } from '../../components/common';
import http, { ApiError } from '../../api/client';
import { post, upload } from '../../api/portal';
import { PickedFile, filePart, pickDocument, pickPhoto } from '../../lib/files';
import { date, money } from '../../lib/format';
import { useLiveRefresh } from '../../live/LiveProvider';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { WalkInPayView } from '../../api/portalTypes';

const MAX = 10 * 1024 * 1024;

/** Initial premium: shows ONE payment (the link token is the credential) and accepts a receipt photo/PDF or an "I have paid" note. */
export default function PayScreen({ route }: { route: any }) {
  const token: string = route.params.token;
  const base = `/walk-in/pay/${encodeURIComponent(token)}`;
  const [view, setView] = useState<WalkInPayView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try { setView((await http.get<WalkInPayView>(base)).data); setError(null); }
    catch (e) { setError(e as ApiError); }
  }, [base]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(() => { load(); });     // staff confirm or reject the payment: the screen updates at once
  useEffect(() => {                         // follows the insurer's decision while the screen stays open
    if (view?.state !== 'ProofSubmitted') return;
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [view?.state, load]);

  const accept = (f: PickedFile | null) => {
    setError(null);
    if (f && f.size && f.size > MAX) { setError(new ApiError(413, 'FILE_TOO_LARGE', '')); return; }
    setFile(f);
  };
  const choose = async (kind: 'doc' | 'photo' | 'camera') => {
    try { accept(kind === 'doc' ? await pickDocument() : await pickPhoto(kind === 'camera')); }
    catch (e) { setError(e as ApiError); }
  };

  async function submit() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      let next: WalkInPayView;
      if (file) {
        const form = new FormData();
        form.append('file', filePart(file));
        if (note.trim()) form.append('note', note.trim());
        if (method) form.append('method', method);
        if (reference.trim()) form.append('reference', reference.trim());
        next = await upload<WalkInPayView>(`${base}/proof`, form);
      } else {
        next = await post<WalkInPayView>(`${base}/declare`, { method: method || undefined, reference: reference.trim() || undefined, note: note.trim() || undefined });
      }
      setView(next); setSent(true); setFile(null); setNote(''); setReference('');
    } catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  }

  const state = view?.state;
  return (
    <Screen header={<ScreenHeader title={t('walkin.pay.title')} subtitle={view ? t('walkin.pay.for', { name: view.customer_name, plan: view.plan_label }) : undefined} leading="back" />}
      scrollable padded keyboardAvoiding contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      {!view && !error ? <LoadingCards count={1} height={260} /> : null}
      {!view && error ? <ErrorView error={error} onRetry={load} /> : null}
      {view ? (
        <Card>
          <View style={{ gap: 14 }}>
            <KeyValue label={t('walkin.pay.amount')}><Text variant="title2" color="brand">{money(view.amount)}</Text></KeyValue>
            {view.reference ? <Text variant="caption" color="muted">{t('walkin.pay.reference')}: <Text variant="captionStrong" selectable>{view.reference}</Text></Text> : null}

            {state === 'Paid' ? <Banner tone="success" title={t('walkin.pay.paid')} description={t('walkin.pay.paidText')} /> : null}
            {state === 'Paid' && view.receipt ? (
              <Card variant="sunken">
                <Text variant="overline" color="success" uppercase>{t('walkin.receipt.title')}</Text>
                <Text variant="title3" selectable>{view.receipt.receipt_no}</Text>
                <KeyValue label={t('walkin.receipt.from')}>{view.receipt.customer_name}</KeyValue>
                <KeyValue label={t('walkin.receipt.for')}>{view.receipt.plan_label}</KeyValue>
                <KeyValue label={t('walkin.receipt.date')}>{date(view.receipt.received_at)}</KeyValue>
                <KeyValue label={t('walkin.receipt.method')}>{view.receipt.method}</KeyValue>
                <KeyValue label={t('walkin.receipt.reference')}>{view.receipt.reference}</KeyValue>
                <KeyValue label={t('walkin.receipt.amount')} last>{money(view.receipt.amount)}</KeyValue>
              </Card>
            ) : null}
            {state === 'Expired' ? <Banner tone="warning" title={t('walkin.pay.expired')} description={t('walkin.pay.expiredText')} /> : null}
            {state === 'ProofSubmitted' ? (
              <Banner tone="info" title={sent ? t('walkin.pay.thanks') : t('walkin.pay.checking')}
                description={`${t('walkin.pay.checkingText')}\n${view.has_receipt ? t('walkin.pay.withReceipt') : t('walkin.pay.noReceipt')}${view.proof_reference ? ` · ${t('walkin.pay.txRef')}: ${view.proof_reference}` : ''}`} />
            ) : null}
            {state === 'Rejected' ? <Banner tone="danger" title={t('walkin.pay.rejected')} description={view.review_note ? t('walkin.pay.rejectedWhy', { why: view.review_note }) : t('walkin.pay.rejectedText')} /> : null}

            {state === 'Open' || state === 'Rejected' ? (
              <>
                <Card variant="sunken">
                  <Text variant="bodyStrong">{t('walkin.pay.how')}</Text>
                  <Text variant="caption" color="muted">1. {t('walkin.pay.step1', { amount: money(view.amount) })}</Text>
                  <Text variant="caption" color="muted">2. {t('walkin.pay.step2')}</Text>
                  <Text variant="caption" color="muted">3. {t('walkin.pay.step3')}</Text>
                  {view.channels.length > 0 ? <Text variant="caption" color="muted">{t('walkin.pay.channels')}: {view.channels.join(', ')}</Text> : null}
                  {view.insurer.phone || view.insurer.email ? <Text variant="caption" color="muted" selectable>{t('walkin.pay.help')}: {[view.insurer.phone, view.insurer.email].filter(Boolean).join('  ·  ')}</Text> : null}
                </Card>
                {error ? <Banner tone="danger" title={errorText(error)} /> : null}
                <Text variant="caption" color="muted">{t('walkin.pay.declareHint')}</Text>
                <Select label={t('walkin.pay.method')} value={method || null} placeholder={t('walkin.apply.optional')} clearable options={view.channels.map((c) => ({ value: c, label: c }))} onSelect={setMethod} />
                <Field label={t('walkin.pay.txRef')} value={reference} onChangeText={setReference} maxLength={100} autoCapitalize="none" />
                <View style={{ gap: 8 }}>
                  <Text variant="calloutStrong">{t('walkin.pay.screenshot')}</Text>
                  <Text variant="caption" color="muted">{t('walkin.pay.screenshotHint')}</Text>
                  {file ? <Text variant="callout" color="brand">{file.name}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="outline" icon="camera-outline" title="Camera" onPress={() => choose('camera')} />
                    <Button size="sm" variant="outline" icon="image-outline" title="Photos" onPress={() => choose('photo')} />
                    <Button size="sm" variant="outline" icon="document-outline" title="PDF / file" onPress={() => choose('doc')} />
                    {file ? <Button size="sm" variant="ghost" title={t('common.remove')} onPress={() => setFile(null)} /> : null}
                  </View>
                </View>
                <Field label={t('walkin.pay.note')} value={note} onChangeText={setNote} maxLength={500} />
                <Button title={t('walkin.pay.iHavePaid')} onPress={submit} loading={busy} disabled={busy} fullWidth />
              </>
            ) : null}
            {view.expires_at && state !== 'Paid' ? <Text variant="micro" color="subtle" align="center">{t('walkin.pay.validUntil', { date: date(view.expires_at) })}</Text> : null}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}
