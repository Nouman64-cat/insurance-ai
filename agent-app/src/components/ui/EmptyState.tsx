import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { spacing, radii } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Text from './Text';
import Button from './Button';

export interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  /** Say what to do next, not just that the list is empty. */
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: ToneName;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The standard empty/zero-data placeholder. Also used for error states by
 * passing `tone="danger"` and a retry action.
 */
export default function EmptyState({
  icon = 'file-tray-outline',
  title,
  description,
  actionLabel,
  onAction,
  tone = 'neutral',
  compact = false,
  style,
}: EmptyStateProps) {
  const { colors } = useTheme();
  const t = colors.tone[tone];

  return (
    <View style={[styles.container, compact ? styles.compact : styles.roomy, style]}>
      <View style={[styles.iconWrap, { backgroundColor: t.soft, borderColor: t.softBorder }]}>
        <Ionicons name={icon} size={compact ? 24 : 32} color={t.on} />
      </View>
      <Text variant={compact ? 'title3' : 'title2'} align="center" style={styles.title}>
        {title}
      </Text>
      {description ? (
        <Text variant="callout" color="muted" align="center" style={styles.description}>
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button
          title={actionLabel}
          onPress={onAction}
          variant="soft"
          tone={tone === 'neutral' ? 'brand' : tone}
          size="sm"
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
  },
  roomy: {
    paddingVertical: spacing.giant,
  },
  compact: {
    paddingVertical: spacing.xxl,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: radii.xl,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    marginBottom: spacing.xs,
  },
  description: {
    maxWidth: 320,
  },
  action: {
    marginTop: spacing.xl,
  },
});
