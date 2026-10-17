import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Field, Text, Pressable } from '../../components/ui';
import { walkInConfig, walkInRequestOtp, walkInVerify } from '../../api/auth';
import { ApiError } from '../../api/client';
import { errorText } from '../../i18n/errorText';
import { useAuth } from '../../context/AuthContext';
import AuthLayout from './AuthLayout';

/** Walk-in sign-up: verify an email with a one-time code (or just the email in demo mode), then continue as a prospect. */
export default function WalkInStartScreen({ navigation }: { navigation: any }) {
  const { adopt } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [demo, setDemo] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => { walkInConfig().then((c) => setDemo(!!c.demo)).catch(() => undefined); }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const sendCode = async () => {
    setBusy(true); setError(null);
    try {
      const r = await walkInRequestOtp(email);
      if (r.demo) { adopt(await walkInVerify(email)); return; }     // demo: no code is sent or asked for
      setDevMode(!!r.dev_mode); setStep('code'); setCode(''); setCooldown(30);
    } catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    setBusy(true); setError(null);
    try { adopt(await walkInVerify(email, code)); }
    catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  };

  return (
    <AuthLayout title="Explore insurance with us" subtitle="Verify your email to choose a plan and request a call from an advisor.">
      {error ? <Banner tone="danger" title={errorText(error)} /> : null}
      {step === 'email' ? (
        <>
          <Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
            autoComplete="email" maxLength={255}
            helperText={demo ? 'Demo mode: just enter your email. No verification code is needed.' : 'We will send a one-time code to this address.'} />
          <Button title={demo ? 'Continue' : 'Send verification code'} onPress={sendCode} loading={busy} disabled={busy || !email.trim()} fullWidth />
        </>
      ) : (
        <>
          <Text variant="callout">We sent a 6-digit code to {email.trim()}. It expires in 10 minutes.</Text>
          {devMode ? <Banner tone="warning" title="Email delivery is not available in this test environment. Use the test code provided by your administrator." /> : null}
          <Field label="Verification code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 8))} keyboardType="number-pad"
            autoComplete="one-time-code" textContentType="oneTimeCode" />
          <Button title="Verify and continue" onPress={verify} loading={busy} disabled={busy || code.length < 4} fullWidth />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Pressable onPress={sendCode} disabled={busy || cooldown > 0} accessibilityRole="button">
              <Text variant="calloutStrong" color={cooldown > 0 ? 'muted' : 'brand'}>{cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}</Text>
            </Pressable>
            <Pressable onPress={() => { setStep('email'); setError(null); }} accessibilityRole="button"><Text variant="calloutStrong" color="muted">Use a different email</Text></Pressable>
          </View>
        </>
      )}
      <Text variant="caption" color="muted">This gives you access to plan information and your own request only. It is not a policy account.</Text>
      <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
        <Text variant="caption" color="muted">Already a policyholder?</Text>
        <Pressable onPress={() => navigation.navigate('Login')} accessibilityRole="button"><Text variant="captionStrong" color="brand">Sign in here</Text></Pressable>
      </View>
    </AuthLayout>
  );
}
