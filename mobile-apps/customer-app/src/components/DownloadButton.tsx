import React, { useState } from 'react';
import { Alert } from 'react-native';
import { Button, Text } from './ui';
import { downloadDocument } from '../lib/files';
import { errorText } from '../i18n/errorText';
import { t } from '../i18n/t';

/** Fetches a document through the authenticated route and opens the share sheet. `handle` is the id the backend issued. */
export default function DownloadButton({ handle, fallbackName, label, available = true }: { handle: string; fallbackName: string; label?: string; available?: boolean }) {
  const [busy, setBusy] = useState(false);
  if (!available) return <Text variant="caption" color="subtle">{t('documents.unavailable')}</Text>;
  return (
    <Button size="sm" variant="soft" icon="download-outline" title={label || t('common.download')} loading={busy} disabled={busy}
      onPress={async () => {
        setBusy(true);
        try { await downloadDocument(handle, fallbackName); }
        catch (e) { Alert.alert(t('error.title'), errorText(e)); }
        finally { setBusy(false); }
      }} />
  );
}
