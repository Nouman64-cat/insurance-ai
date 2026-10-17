import React, { useEffect, useState } from 'react';
import { Banner, Button, Card, Field, Skeleton, Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import http, { ApiError } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../context/AuthContext';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import type { WalkInProfile } from '../../api/types';

export default function WalkInProfileScreen() {
  const { signOut } = useAuth();
  const me = useApi<WalkInProfile>('/walk-in/me');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (me.data) setName(me.data.display_name); }, [me.data]);

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try { await http.patch('/walk-in/profile', { display_name: name.trim() }); setSaved(true); await me.reload(); }
    catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  };

  return (
    <Screen header={<ScreenHeader title={t('walkin.profile.title')} subtitle={t('walkin.profile.subtitle')} leading="none" />}
      scrollable padded keyboardAvoiding contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <Card>
        {me.loading ? <Skeleton height={90} radius={12} /> : (
          <>
            {error ? <Banner tone="danger" title={errorText(error)} /> : null}
            {saved ? <Banner tone="success" title={t('walkin.profile.saved')} /> : null}
            <Text variant="caption" color="subtle">{t('walkin.apply.email')}</Text>
            <Text variant="bodyStrong" selectable style={{ marginBottom: 12 }}>{me.data?.email}</Text>
            <Field label={t('walkin.profile.name')} value={name} onChangeText={setName} maxLength={120} />
            <Button title={t('common.save')} onPress={save} loading={busy} disabled={busy || name.trim().length < 2 || name.trim() === me.data?.display_name} style={{ marginTop: 12 }} />
          </>
        )}
      </Card>
      <Button title={t('walkin.nav.logout')} variant="outline" onPress={signOut} fullWidth />
    </Screen>
  );
}
