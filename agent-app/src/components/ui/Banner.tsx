import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Text from './Text';
import Pressable from './Pressable';

export interface BannerProps {
  title: string;
  description?: string;
  tone?: ToneName;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Inline text action, e.g. "Retry" or "Complete now". */
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

const DEFAULT_ICON: Record<ToneName, keyof typeof Ionicons.glyphMap> = {
  brand: 'information-circle',
  info: 'information-circle',
  success: 'checkmark-circle',
  warning: 'warning',
  danger: 'alert-circle',
  neutral: 'information-circle',
  accent: 'sparkles',
};

/** Inline, non-blocking message pinned within page content. */
export default function Banner({
  title,
  description,
  tone = 'info',
  icon,
  actionLabel,
  onAction,
  onDismiss,
  style,
}: BannerProps) {
  const { colors } = useTheme();
  const t = colors.tone[tone];

  return (
    <View
      accessibilityRole="alert"
      style={[styles.container, { backgroundColor: t.soft, borderColor: t.softBorder }, style]}
    >
      <Ionicons name={icon ?? DEFAULT_ICON[tone]} size={20} color={t.solid} style={styles.icon} />

      <View style={styles.body}>
        <Text variant="calloutStrong" style={{ color: t.on }}>
          {title}
        </Text>
        {description ? (
          <Text variant="caption" style={[styles.description, { color: t.on, opacity: 0.85 }]}>
            {description}
          </Text>
        ) : null}
        {actionLabel && onAction ? (
          <Pressable onPress={onAction} style={styles.action} accessibilityRole="button" accessibilityLabel={actionLabel}>
            <Text variant="captionStrong" style={{ color: t.solid }}>
              {actionLabel}
            </Text>
            <Ionicons name="arrow-forward" size={13} color={t.solid} />
          </Pressable>
        ) : null}
      </View>

      {onDismiss ? (
        <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss" pressedScale={0.9}>
          <Ionicons name="close" size={18} color={t.on} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  icon: {
    // Nudges the glyph onto the title's optical baseline.
    marginTop: 1,
  },
  body: {
    flex: 1,
  },
  description: {
    marginTop: spacing.xxs,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
});
