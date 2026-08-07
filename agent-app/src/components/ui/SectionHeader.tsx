import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { spacing } from '../../theme/tokens';
import Text from './Text';
import Pressable from './Pressable';

export interface SectionHeaderProps {
  title: string;
  /** Count rendered next to the title — "Leads · 12". */
  count?: number;
  /** Trailing text action, e.g. "See all". */
  actionLabel?: string;
  onAction?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  onIconPress?: () => void;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Groups content within a scrolling screen. */
export default function SectionHeader({
  title,
  count,
  actionLabel,
  onAction,
  icon,
  onIconPress,
  rightIcon,
  onRightIconPress,
  style,
}: SectionHeaderProps) {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, style]}>
      <View style={styles.left}>
        {icon ? (
          onIconPress ? (
            <Pressable onPress={onIconPress} accessibilityRole="button" pressedScale={0.9}>
              <Ionicons name={icon} size={20} color={colors.primary} />
            </Pressable>
          ) : (
            <Ionicons name={icon} size={16} color={colors.textMuted} />
          )
        ) : null}
        <Text variant="title3" numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {typeof count === 'number' ? (
          <View style={[styles.count, { backgroundColor: colors.surfaceSunken }]}>
            <Text variant="micro" color="muted">
              {count}
            </Text>
          </View>
        ) : null}
      </View>

      {rightIcon && onRightIconPress ? (
        <Pressable
          onPress={onRightIconPress}
          accessibilityRole="button"
          accessibilityLabel={title}
          pressedScale={0.88}
          style={styles.action}
        >
          <Ionicons name={rightIcon} size={22} color={colors.primary} />
        </Pressable>
      ) : actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={styles.action}
        >
          <Text variant="captionStrong" style={{ color: colors.primary }}>
            {actionLabel}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={colors.primary} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
  },
  count: {
    minWidth: 22,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: 'center',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.xs,
  },
});
