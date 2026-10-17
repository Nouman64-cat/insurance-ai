import React, { useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Field, Text } from '../../components/ui';
import { firstChange } from '../../api/auth';
import { ApiError } from '../../api/client';
import { errorText, passwordProblems } from '../../i18n/errorText';
import { passwordChecks } from '../../lib/password';
import { useAuth } from '../../context/AuthContext';
import AuthLayout from './AuthLayout';

/** Forced on a first sign-in: the temporary password is only accepted for this one call. */
export default function FirstLoginScreen() {
  const { adopt, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const checks = passwordChecks(next);
  const ok = checks.every((c) => c.ok) && next === confirm && next !== current && current.length > 0;

  const submit = async () => {
    if (!ok) return;
    setBusy(true); setError(null);
    try { adopt(await firstChange(current, next)); }
    catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  };

  const problems = passwordProblems(error);
  return (
    <AuthLayout title="Set your own password" subtitle="You signed in with a temporary password. Choose a new one to continue.">
      {error ? <Banner tone="danger" title={problems.length ? 'Choose a stronger password' : errorText(error)} description={problems.join('\n') || undefined} /> : null}
      <Field label="Temporary password" helperText="The password your insurer gave you." isPassword value={current} onChangeText={setCurrent} />
      <Field label="New password" isPassword value={next} onChangeText={setNext} autoComplete="new-password" />
      <View style={{ gap: 4 }}>
        {checks.map((c) => <Text key={c.key} variant="caption" color={c.ok ? 'success' : 'muted'}>{c.ok ? '✓' : '○'}  {c.label}</Text>)}
      </View>
      <Field label="Confirm new password" isPassword value={confirm} onChangeText={setConfirm} autoComplete="new-password"
        error={confirm && next !== confirm ? 'The passwords do not match.' : undefined} />
      <Button title="Save and continue" onPress={submit} loading={busy} disabled={!ok || busy} fullWidth />
      <Button title="Sign out instead" variant="ghost" onPress={signOut} fullWidth />
    </AuthLayout>
  );
}
