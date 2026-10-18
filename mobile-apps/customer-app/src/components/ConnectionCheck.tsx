import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import axios from 'axios';
import { Banner, Button, Field, Pressable, Sheet, Text } from './ui';
import { defaultApiUrl, getApiUrl, hasServerOverride, loadServerOverride, normalizeServerUrl, setServerOverride } from '../lib/server';

interface Result { ok: boolean; title: string; detail?: string }

/**
 * Development helper on the sign-in screens: shows which server address the app is using, tests it for real, and lets the address
 * be changed for local development. Not shown in release builds.
 */
export default function ConnectionCheck() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(getApiUrl());
  const [input, setInput] = useState(getApiUrl());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => { loadServerOverride().then(() => { setCurrent(getApiUrl()); setInput(getApiUrl()); }); }, []);
  if (!__DEV__) return null;

  async function test(target: string) {
    setBusy(true); setResult(null);
    const started = Date.now();
    try {
      const r = await axios.get(`${target}/customer-management/v1/walk-in/config`, { timeout: 8000, validateStatus: () => true });
      const ms = Date.now() - started;
      if (r.status === 200) setResult({ ok: true, title: `Connected to the server (${ms} ms)` });
      else setResult({ ok: false, title: `The server answered, but with HTTP ${r.status}`, detail: 'The address is reachable. Check the backend service and gateway logs.' });
    } catch (e: any) {
      setResult({
        ok: false, title: `Cannot reach ${target}`,
        detail: `${e?.code ?? 'ERROR'}: ${e?.message ?? 'no details'}\n\nCheck your internet connection and that the backend is available. For a local development server, check the address and that your phone can reach it.`,
      });
    } finally { setBusy(false); }
  }

  async function save() {
    const url = normalizeServerUrl(input);
    if (!url) { setResult({ ok: false, title: 'That is not a valid address', detail: 'Use https://api.getinsuredai.com or a local server IP.' }); return; }
    await setServerOverride(url);
    setCurrent(url); setInput(url);
    await test(url);
  }

  async function reset() {
    await setServerOverride(null);
    setCurrent(getApiUrl()); setInput(getApiUrl());
    await test(getApiUrl());
  }

  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Check server connection" style={{ alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 12 }}>
        <Text variant="caption" color="muted" align="center">Server: {current}{hasServerOverride() ? ' (set by hand)' : ''}</Text>
        <Text variant="captionStrong" color="brand" align="center">Check connection</Text>
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title="Server connection" subtitle="Development builds only" maxHeightRatio={0.9}
        footer={<Button title="Done" variant="outline" onPress={() => setOpen(false)} fullWidth />}>
        <View style={{ gap: 14 }}>
          <View>
            <Text variant="caption" color="subtle">In use</Text>
            <Text variant="bodyStrong" selectable>{current}</Text>
            <Text variant="caption" color="subtle" style={{ marginTop: 6 }}>Configured default server</Text>
            <Text variant="callout" selectable>{defaultApiUrl}</Text>
          </View>
          {result ? <Banner tone={result.ok ? 'success' : 'danger'} title={result.title} description={result.detail} /> : null}
          <Button title="Test connection" onPress={() => test(current)} loading={busy} disabled={busy} fullWidth />
          <Field label="Use a different address" value={input} onChangeText={setInput} autoCapitalize="none" autoCorrect={false} keyboardType="url"
            placeholder="https://api.getinsuredai.com" helperText="Use a full server URL. Bare local IP addresses use port 8010." />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Save and test" onPress={save} disabled={busy} style={{ flex: 1 }} />
            <Button title="Use default" variant="outline" onPress={reset} disabled={busy || !hasServerOverride()} style={{ flex: 1 }} />
          </View>
        </View>
      </Sheet>
    </>
  );
}
