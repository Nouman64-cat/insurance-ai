import React, { useCallback } from 'react';
import { Linking, Platform, Share, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../../theme/ThemeContext';
import { spacing, radii } from '../../theme/tokens';
import Sheet from './Sheet';
import Text from './Text';
import Button from './Button';
import Pressable from './Pressable';

export interface LinkShareSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  url: string;
  /** Fired after the link is copied or handed to the OS share sheet, so the
   * screen can toast — this component has no notification context of its own. */
  onCopied?: () => void;
}

/**
 * Shows a generated link as highlighted, tappable text the agent can open
 * directly — rather than only firing the OS share sheet, whose recipients
 * often fail to auto-linkify a raw http:// LAN URL buried in plain text.
 * Copy and Share stay available underneath for handing it to the customer.
 */
export default function LinkShareSheet({ visible, onClose, title, subtitle, url, onCopied }: LinkShareSheetProps) {
  const { colors } = useTheme();

  const openLink = useCallback(() => {
    Linking.openURL(url).catch(() => {});
  }, [url]);

  const copyLink = useCallback(async () => {
    await Clipboard.setStringAsync(url);
    onCopied?.();
  }, [url, onCopied]);

  const shareLink = useCallback(async () => {
    await Clipboard.setStringAsync(url);
    try {
      await Share.share(
        Platform.OS === 'ios' ? { message: title, url } : { message: `${title}\n\n${url}` }
      );
    } catch {
      // User dismissed the share sheet — nothing to report.
    }
  }, [title, url]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <Button title="Copy" variant="soft" icon="copy-outline" onPress={copyLink} style={styles.flex} />
          <Button title="Share" icon="share-outline" onPress={shareLink} style={styles.flex} />
        </>
      }
    >
      <Pressable
        onPress={openLink}
        pressedScale={0.98}
        accessibilityRole="link"
        accessibilityLabel={`Open ${url}`}
        style={[styles.linkBox, { backgroundColor: colors.tone.brand.soft, borderColor: colors.tone.brand.softBorder }]}
      >
        <Ionicons name="link-outline" size={16} color={colors.tone.brand.on} />
        <Text variant="calloutStrong" numberOfLines={3} style={[styles.linkText, { color: colors.tone.brand.on }]}>
          {url}
        </Text>
        <Ionicons name="open-outline" size={16} color={colors.tone.brand.on} />
      </Pressable>
      <Text variant="caption" color="muted" style={styles.hint}>
        Tap the link to open it, or use Share to send it to the customer.
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  linkText: {
    flex: 1,
    textDecorationLine: 'underline',
  },
  hint: {
    marginTop: spacing.sm,
  },
});
