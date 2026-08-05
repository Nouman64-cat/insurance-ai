import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { radii, spacing } from '../theme/tokens';
import { NOTIFICATION_PRESETS, formatRelativeTime } from './types';
import { useNotifications } from './NotificationContext';
import Sheet from '../components/ui/Sheet';
import Text from '../components/ui/Text';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';

/**
 * The interrupting popup for events that warrant stopping what you are doing —
 * currently a lead landing on your book. Mount once alongside `ToastHost`.
 *
 * Ordinary events use a toast instead; reserving the popup for high-signal
 * events is what stops it becoming noise the user learns to dismiss blindly.
 */
export default function NotificationPopup() {
  const { popup, dismissPopup, markRead } = useNotifications();
  const { colors } = useTheme();
  const navigation = useNavigation<any>();

  if (!popup) return null;

  const preset = NOTIFICATION_PRESETS[popup.kind] ?? NOTIFICATION_PRESETS.generic;
  const tone = colors.tone[preset.tone];

  const close = () => {
    markRead(popup.id);
    dismissPopup();
  };

  const openTarget = () => {
    markRead(popup.id);
    dismissPopup();
    if (popup.target) {
      navigation.navigate(popup.target.screen as never, popup.target.params as never);
    }
  };

  return (
    <Sheet
      visible
      onClose={close}
      scrollable={false}
      footer={
        <>
          <Button
            title="Dismiss"
            onPress={close}
            variant="outline"
            tone="neutral"
            style={styles.action}
          />
          {popup.target ? (
            <Button
              title="View"
              onPress={openTarget}
              variant="solid"
              tone={preset.tone}
              icon="arrow-forward"
              iconPosition="right"
              style={styles.action}
            />
          ) : null}
        </>
      }
    >
      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: tone.soft, borderColor: tone.softBorder }]}>
          <Ionicons name={preset.icon} size={30} color={tone.on} />
        </View>

        <Badge
          label={formatRelativeTime(popup.createdAt)}
          tone={preset.tone}
          variant="soft"
          style={styles.time}
        />

        <Text variant="title2" align="center">
          {popup.title}
        </Text>

        {popup.body ? (
          <Text variant="callout" color="muted" align="center" style={styles.message}>
            {popup.body}
          </Text>
        ) : null}

        {popup.actorName ? (
          <View style={[styles.actor, { backgroundColor: colors.surfaceSunken }]}>
            <Ionicons name="person-circle-outline" size={16} color={colors.textMuted} />
            <Text variant="caption" color="muted">
              Added by {popup.actorName}
            </Text>
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    alignItems: 'center',
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  iconWrap: {
    width: 68,
    height: 68,
    borderRadius: radii.xxl,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  time: {
    marginBottom: spacing.md,
  },
  message: {
    marginTop: spacing.sm,
    maxWidth: 340,
  },
  actor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
  },
  action: {
    flex: 1,
  },
});
