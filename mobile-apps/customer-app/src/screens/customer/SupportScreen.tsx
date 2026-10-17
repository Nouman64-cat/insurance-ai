import React, { useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { Banner, Button, Card, EmptyState, Field, Pressable, Select, Sheet, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, KeyValue, LoadingCards, Panel, TicketStatus } from '../../components/common';
import { useApi } from '../../hooks/useApi';
import { ApiError } from '../../api/client';
import { post } from '../../api/portal';
import { DEMO } from '../../config';
import { dateTime, newIdempotencyKey } from '../../lib/format';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { PolicyCard, Profile, SupportTicket } from '../../api/portalTypes';

const CATEGORIES = ['GENERAL', 'POLICY_SERVICING', 'BILLING', 'CLAIM_ENQUIRY', 'COMPLAINT', 'DOCUMENTS'] as const;
const FAQ = ['pay', 'claim', 'password', 'details', 'nominee'] as const;

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const policies = useApi<{ items: PolicyCard[] }>('/policies');
  const [f, setF] = useState({ title: '', description: '', category: 'GENERAL', policy_id: '' });
  const key = useRef(newIdempotencyKey()); // one key per form: a double tap or retry creates one ticket
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const dl = f.description.trim().length;
  const ok = f.title.trim().length >= 3 && dl >= 10;

  async function submit() {
    if (!ok || busy) return;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { title: f.title.trim(), description: f.description.trim(), category: f.category };
      if (f.policy_id) body.policy_id = f.policy_id;
      const r = await post<{ id: string }>('/support/tickets', body, { key: key.current });
      onCreated(r.id);
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  }
  return (
    <Sheet visible onClose={busy ? () => undefined : onClose} title={t('ticket.new')} maxHeightRatio={0.92}
      footer={<View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title={t('common.cancel')} variant="outline" onPress={onClose} disabled={busy} style={{ flex: 1 }} />
        <Button title={t('ticket.submit')} onPress={submit} loading={busy} disabled={!ok || busy} style={{ flex: 1 }} />
      </View>}>
      <View style={{ gap: 14 }}>
        {error ? <Banner tone="danger" title={errorText(error)} /> : null}
        {DEMO ? <Button size="sm" variant="outline" icon="flash-outline" title={t('ticket.demo')} onPress={() => setF({ title: 'Change my contact address', description: 'I have moved to a new house and need my address updated on all my policies. Please tell me what documents you need.', category: 'POLICY_SERVICING', policy_id: policies.data?.items[0]?.id ?? '' })} /> : null}
        <Select label={t('ticket.category')} value={f.category} options={CATEGORIES.map((c) => ({ value: c, label: t(`ticket.cat.${c}`) }))} onSelect={(v) => setF({ ...f, category: v })} />
        <Select label={t('ticket.policy')} helperText={t('ticket.policyHint')} value={f.policy_id || null} placeholder={t('ticket.noPolicy')} clearable
          options={(policies.data?.items || []).map((p) => ({ value: p.id, label: `${p.policy_number} — ${p.product_name}` }))} onSelect={(v) => setF({ ...f, policy_id: v })} />
        <Field label={`${t('ticket.subject')} *`} value={f.title} onChangeText={(v) => setF({ ...f, title: v })} maxLength={200} />
        <Field label={`${t('ticket.details')} *`} value={f.description} onChangeText={(v) => setF({ ...f, description: v })} multiline maxLength={5000} inputStyle={{ minHeight: 120 }}
          helperText={dl > 0 && dl < 10 ? t('ticket.moreChars', { n: 10 - dl }) : t('ticket.detailsHint')} />
      </View>
    </Sheet>
  );
}

export default function SupportScreen({ navigation }: { navigation: any }) {
  const profile = useApi<Profile>('/profile');
  const list = useApi<{ items: SupportTicket[] }>('/support/tickets', { pollMs: 30_000 });
  const [creating, setCreating] = useState(false);
  const c = profile.data?.tenant;
  const items = list.data?.items || [];
  return (
    <Screen header={<ScreenHeader title={t('support.title')} subtitle={t('support.subtitle')} leading="back" />}
      scrollable padded refreshing={list.loading && !!list.data} onRefresh={() => { list.reload(); profile.reload(); }} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <Panel title={t('ticket.mine')} action={<Button size="sm" icon="add" title={t('ticket.new')} onPress={() => setCreating(true)} />}>
        {list.loading && !list.data ? <LoadingCards count={2} height={56} />
          : list.error && !list.data ? <ErrorView error={list.error} onRetry={list.reload} />
          : items.length === 0 ? <EmptyState compact icon="chatbubbles-outline" title={t('ticket.none')} description={t('ticket.noneText')} actionLabel={t('ticket.new')} onAction={() => setCreating(true)} />
          : items.map((x) => (
            <Pressable key={x.id} onPress={() => navigation.navigate('TicketDetail', { id: x.id })} accessibilityRole="button" style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong" numberOfLines={1}>{x.title}</Text>
                <Text variant="caption" color="muted">{t(`ticket.cat.${x.category}`)} · {t('ticket.updated', { when: dateTime(x.updated_at) })}</Text>
              </View>
              <TicketStatus status={x.status} />
            </Pressable>
          ))}
      </Panel>

      <Panel title={c?.name || t('support.insurer')}>
        <KeyValue label={t('support.phone')}>{c?.contact_phone
          ? <Pressable onPress={() => Linking.openURL(`tel:${c.contact_phone!.replace(/\s/g, '')}`)} accessibilityRole="link"><Text variant="calloutStrong" color="brand">{c.contact_phone}</Text></Pressable> : t('support.notProvided')}</KeyValue>
        <KeyValue label={t('support.email')}>{c?.contact_email
          ? <Pressable onPress={() => Linking.openURL(`mailto:${c.contact_email}`)} accessibilityRole="link"><Text variant="calloutStrong" color="brand">{c.contact_email}</Text></Pressable> : t('support.notProvided')}</KeyValue>
        {c?.address ? <KeyValue label={t('support.office')}>{c.address}</KeyValue> : null}
        {c?.website ? <KeyValue label={t('support.website')}>{c.website}</KeyValue> : null}
        <Text variant="caption" color="subtle" style={{ marginTop: 8 }}>{t('support.quote', { policyholder: profile.data?.policyholder_id || profile.data?.username || '' })}</Text>
      </Panel>

      <Panel title={t('support.faq')}>
        {FAQ.map((k) => (
          <View key={k} style={{ paddingVertical: 6 }}>
            <Text variant="bodyStrong">{t(`support.faq.${k}.q`)}</Text>
            <Text variant="callout" color="muted">{t(`support.faq.${k}.a`)}</Text>
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Button size="sm" variant="outline" title={t('claims.new')} onPress={() => navigation.navigate('NewClaim', {})} />
          <Button size="sm" variant="outline" title={t('nav.payments')} onPress={() => navigation.navigate('Tabs', { screen: 'Payments' })} />
        </View>
      </Panel>

      {creating ? <NewTicket onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); list.reload(); navigation.navigate('TicketDetail', { id }); }} /> : null}
    </Screen>
  );
}
