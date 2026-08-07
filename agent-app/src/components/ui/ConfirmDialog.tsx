import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Sheet from './Sheet';
import Text from './Text';
import Button from './Button';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ToneName;
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Themed replacement for `Alert.alert`. The native alert cannot be styled, so
 * it breaks the app's visual language and ignores dark mode entirely.
 */
export default function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'brand',
  icon,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { colors } = useTheme();
  const t = colors.tone[tone];

  return (
    <Sheet
      visible={visible}
      onClose={onCancel}
      // Confirmations are centred cards on every screen size, matching what
      // both platforms do natively.
      variant="dialog"
      // Scrollable so a long message never clips the confirm/cancel row.
      scrollable
      // A destructive confirm must be an explicit choice, so a stray tap on the
      // scrim should not dismiss it.
      dismissOnBackdropPress={tone !== 'danger'}
      footer={
        <>
          <Button
            title={cancelLabel}
            onPress={onCancel}
            variant="outline"
            tone="neutral"
            disabled={loading}
            style={styles.action}
          />
          <Button
            title={confirmLabel}
            onPress={onConfirm}
            variant="solid"
            tone={tone}
            loading={loading}
            style={styles.action}
          />
        </>
      }
    >
      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: t.soft, borderColor: t.softBorder }]}>
          <Ionicons
            name={icon ?? (tone === 'danger' ? 'trash-outline' : 'help-circle-outline')}
            size={26}
            color={t.on}
          />
        </View>
        <Text variant="title2" align="center">
          {title}
        </Text>
        {message ? (
          <Text variant="callout" color="muted" align="center" style={styles.message}>
            {message}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radii.xl,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  message: {
    marginTop: spacing.sm,
    maxWidth: 320,
  },
  action: {
    flex: 1,
  },
});
