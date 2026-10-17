import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { Banner, Button, Card, Field, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, LoadingCards, TicketStatus } from '../../components/common';
import { useApi } from '../../hooks/useApi';
import { ApiError } from '../../api/client';
import { post } from '../../api/portal';
import { dateTime } from '../../lib/format';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { SupportTicketDetail } from '../../api/portalTypes';

/** One ticket: the conversation, reply, withdraw (while it is still new) and reopen (once resolved). */
export default function TicketDetailScreen({ route }: { route: any }) {
  const id: string = route.params.id;
  const { data: d, error, loading, reload } = useApi<SupportTicketDetail>(`/support/tickets/${id}`, { pollMs: 20_000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function act(path: string, body: unknown, done: string) {
    setBusy(true); setErr(null); setOk(null);
    try { await post(`/support/tickets/${id}/${path}`, body); setText(''); await reload(); setOk(done); }
    catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const confirmWithdraw = () => Alert.alert(t('ticket.withdraw'), t('ticket.withdrawConfirm'), [
    { text: t('common.cancel'), style: 'cancel' }, { text: t('ticket.withdraw'), style: 'destructive', onPress: () => act('withdraw', {}, t('ticket.withdrawn')) }]);

  const head = <ScreenHeader title={d?.title || t('ticket.title')} leading="back" />;
  if (error && !d) return <Screen header={head} padded><ErrorView error={error} onRetry={reload} /></Screen>;
  if (loading && !d) return <Screen header={head} padded scrollable><LoadingCards count={2} height={120} /></Screen>;
  if (!d) return null;
  const finished = ['CLOSED', 'CANCELLED'].includes(d.status);

  return (
    <Screen header={head} scrollable padded keyboardAvoiding refreshing={loading} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <TicketStatus status={d.status} />
        <Text variant="caption" color="muted">{t(`ticket.cat.${d.category}`)} · {t('ticket.opened', { when: dateTime(d.created_at) })}</Text>
      </View>
      {d.status === 'WAITING_CUSTOMER' ? <Banner tone="warning" title={t('ticket.waiting')} description={t('ticket.waitingText')} /> : null}
      {d.resolution ? <Banner tone="success" title={t('ticket.outcome')} description={d.resolution} /> : null}
      {err ? <Banner tone="danger" title={errorText(err)} /> : null}
      {ok ? <Banner tone="success" title={ok} onDismiss={() => setOk(null)} /> : null}

      <View style={{ gap: 8 }}>
        {d.events.map((e) => e.kind === 'STATUS' ? (
          <Text key={e.id} variant="caption" color="subtle" style={{ paddingLeft: 6 }}>{e.actor_name} — {t('ticket.statusChanged')} · {dateTime(e.created_at)}</Text>
        ) : (
          <Card key={e.id} variant="sunken">
            <Text variant="caption" color="muted"><Text variant="captionStrong">{e.actor_name}</Text> · {dateTime(e.created_at)}</Text>
            <Text variant="body" selectable style={{ marginTop: 2 }}>{e.body}</Text>
          </Card>
        ))}
      </View>

      {!finished ? (
        <View style={{ gap: 10 }}>
          <Field value={text} onChangeText={setText} multiline maxLength={5000} placeholder={t('ticket.replyPh')} accessibilityLabel={t('ticket.reply')} inputStyle={{ minHeight: 90 }} />
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'space-between' }}>
            {d.status === 'OPEN' ? <Button variant="outline" tone="danger" title={t('ticket.withdraw')} disabled={busy} onPress={confirmWithdraw} /> : <View />}
            <Button title={t('ticket.send')} loading={busy} disabled={busy || !text.trim()} onPress={() => act('reply', { body: text.trim() }, t('ticket.sent'))} />
          </View>
        </View>
      ) : null}
      {d.status === 'RESOLVED' ? <Button variant="outline" title={t('ticket.reopen')} disabled={busy || text.trim().length < 5} onPress={() => act('reopen', { body: text.trim() }, t('ticket.reopened'))} fullWidth /> : null}
      {finished ? <Text variant="caption" color="muted">{t('ticket.finished')}</Text> : null}
    </Screen>
  );
}
