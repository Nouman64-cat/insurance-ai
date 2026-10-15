import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { Banner, Button, Field, Sheet, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { ErrorView, KeyValue, LoadingCards, Panel } from '../../components/common';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../context/AuthContext';
import http, { ApiError } from '../../api/client';
import { patch } from '../../api/portal';
import { errorText, passwordProblems } from '../../i18n/errorText';
import { passwordChecks } from '../../lib/password';
import { date } from '../../lib/format';
import { t } from '../../i18n/t';
import type { Profile } from '../../api/portalTypes';

function EditContact({ p, onClose, onSaved }: { p: Profile; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ email: p.email || '', phone: p.phone || '', address: p.address || '' });
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const changed = (['email', 'phone', 'address'] as const).filter((k) => f[k].trim() !== (p[k] || ''));
  async function save() {
    setBusy(true); setError(null);
    try {
      const body: Record<string, string> = { current_password: pw };
      changed.forEach((k) => { body[k] = f[k].trim(); });
      await patch('/profile/contact', body);
      Alert.alert(t('profile.contactSaved')); onSaved(); onClose();
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  }
  return (
    <Sheet visible onClose={busy ? () => undefined : onClose} title={t('profile.editContact')} maxHeightRatio={0.92}
      footer={<View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title={t('common.cancel')} variant="outline" onPress={onClose} disabled={busy} style={{ flex: 1 }} />
        <Button title={t('common.save')} onPress={save} loading={busy} disabled={busy || changed.length === 0 || !pw} style={{ flex: 1 }} />
      </View>}>
      <View style={{ gap: 14 }}>
        {error ? <Banner tone="danger" title={errorText(error)} /> : null}
        <Field label={t('profile.email')} value={f.email} onChangeText={(v) => setF({ ...f, email: v })} keyboardType="email-address" autoCapitalize="none" maxLength={255} autoComplete="email" />
        <Field label={t('profile.phone')} value={f.phone} onChangeText={(v) => setF({ ...f, phone: v })} keyboardType="phone-pad" maxLength={30} autoComplete="tel" />
        <Field label={t('profile.address')} value={f.address} onChangeText={(v) => setF({ ...f, address: v })} multiline maxLength={500} inputStyle={{ minHeight: 70 }} />
        <Field label={t('profile.confirmPassword')} helperText={t('profile.confirmPasswordHint')} isPassword value={pw} onChangeText={setPw} autoComplete="current-password" />
      </View>
    </Sheet>
  );
}

function ChangePassword({ username }: { username: string }) {
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const checks = passwordChecks(next, username);
  const ok = checks.every((c) => c.ok) && next === again && next !== cur && !!cur;
  const problems = passwordProblems(error);
  async function submit() {
    if (!ok) return;
    setBusy(true); setError(null); setDone(false);
    try { await http.post('/auth/password/change', { current_password: cur, new_password: next }); setDone(true); setCur(''); setNext(''); setAgain(''); }
    catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  }
  return (
    <View style={{ gap: 12 }}>
      {error ? <Banner tone="danger" title={problems.length ? t('first.weak') : errorText(error)} description={problems.join('\n') || undefined} /> : null}
      {done ? <Banner tone="success" title={t('profile.passwordChanged')} /> : null}
      <Field label={t('profile.currentPassword')} isPassword value={cur} onChangeText={setCur} autoComplete="current-password" />
      <Field label={t('first.new')} isPassword value={next} onChangeText={setNext} autoComplete="new-password" />
      <View style={{ gap: 3 }}>{checks.map((c) => <Text key={c.key} variant="caption" color={c.ok ? 'success' : 'muted'}>{c.ok ? '✓' : '○'}  {c.label}</Text>)}</View>
      <Field label={t('first.confirm')} isPassword value={again} onChangeText={setAgain} autoComplete="new-password" error={again && next !== again ? t('first.mismatch') : undefined} />
      <Button title={t('profile.changePassword')} onPress={submit} loading={busy} disabled={!ok || busy} />
      <Text variant="caption" color="subtle">{t('profile.signOutOthers')}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { signOut } = useAuth();
  const { data: p, error, loading, reload } = useApi<Profile>('/profile');
  const [editing, setEditing] = useState(false);
  const head = <ScreenHeader title={t('profile.title')} subtitle={t('profile.subtitle')} leading="back" />;
  if (error && !p) return <Screen header={head} padded><ErrorView error={error} onRetry={reload} /></Screen>;
  if (loading || !p) return <Screen header={head} padded scrollable><LoadingCards count={3} height={140} /></Screen>;
  return (
    <Screen header={head} scrollable padded keyboardAvoiding refreshing={loading} onRefresh={reload} contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <Panel title={t('profile.personal')}>
        <KeyValue label={t('profile.name')}>{p.name}</KeyValue>
        <KeyValue label={t('profile.policyholderId')}>{p.policyholder_id || p.username}</KeyValue>
        <KeyValue label={t('profile.cnic')}>{p.cnic_masked}</KeyValue>
        <KeyValue label={t('profile.dob')} last>{date(p.dob)}</KeyValue>
        <Text variant="caption" color="subtle" style={{ marginTop: 8 }}>{t('profile.identityNote')}</Text>
      </Panel>
      <Panel title={t('profile.contact')} action={<Button size="sm" variant="ghost" title={t('common.edit')} onPress={() => setEditing(true)} />}>
        <KeyValue label={t('profile.email')}>{p.email}</KeyValue>
        <KeyValue label={t('profile.phone')}>{p.phone}</KeyValue>
        <KeyValue label={t('profile.address')}>{p.address}</KeyValue>
        <KeyValue label={t('profile.city')} last>{[p.city, p.province].filter(Boolean).join(', ')}</KeyValue>
      </Panel>
      <Panel title={t('profile.security')}><ChangePassword username={p.username} /></Panel>
      <Button title={t('account.signOut')} variant="outline" onPress={signOut} fullWidth />
      {editing ? <EditContact p={p} onClose={() => setEditing(false)} onSaved={reload} /> : null}
    </Screen>
  );
}
