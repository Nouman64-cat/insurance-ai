import React, { useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Field, Text, Pressable } from '../../components/ui';
import { login } from '../../api/auth';
import { ApiError } from '../../api/client';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import { useAuth } from '../../context/AuthContext';
import AuthLayout from './AuthLayout';

/** Policyholder sign-in. Credentials are issued by the insurer; there is no self-registration (same as the web portal). */
export default function LoginScreen({ navigation }: { navigation: any }) {
  const { adopt, expired } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tenant, setTenant] = useState('');
  const [needsTenant, setNeedsTenant] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      adopt(await login(username, password, tenant));
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'TENANT_CODE_REQUIRED') setNeedsTenant(true);
      setError(err); setPassword('');
    } finally { setBusy(false); }
  };

  return (
    <AuthLayout title="Welcome back" subtitle={t('login.subtitle')}>
      {expired && !error ? <Banner tone="warning" title="Your session ended. Please sign in again." /> : null}
      {error ? <Banner tone="danger" title={errorText(error)} /> : null}
      <Field label="Username" helperText="Your policyholder ID, as sent to you by your insurer." value={username} onChangeText={setUsername}
        autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" maxLength={255} />
      <Field label="Password" isPassword value={password} onChangeText={setPassword} autoComplete="current-password" textContentType="password" />
      {needsTenant ? (
        <Field label="Company code" helperText="Needed only if your username is used by more than one company." value={tenant}
          onChangeText={setTenant} autoCapitalize="characters" autoCorrect={false} maxLength={50} />
      ) : (
        <Pressable onPress={() => setNeedsTenant(true)} accessibilityRole="button"><Text variant="calloutStrong" color="brand">Have a company code?</Text></Pressable>
      )}
      <Button title="Sign in" onPress={submit} loading={busy} disabled={busy || !username.trim() || !password} fullWidth />
      <Text variant="caption" color="muted">Sign-in details are issued by your insurer when your policy is issued. Forgot your password? Contact your insurer: they can issue new temporary sign-in details.</Text>
      <View style={{ gap: 6, alignItems: 'center', marginTop: 8 }}>
        <Text variant="bodyStrong">New here? Not a policyholder yet?</Text>
        <Text variant="caption" color="muted" align="center">Create a guest account with your email to explore plans, send an application and track it.</Text>
        <Button title="Sign up / continue as a new customer" variant="outline" onPress={() => navigation.navigate('WalkInStart')} fullWidth />
      </View>
    </AuthLayout>
  );
}
