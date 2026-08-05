import React from 'react';
import { StyleSheet, ViewStyle, StyleProp, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, hitTarget } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Pressable from './Pressable';
import Text from './Text';

export interface IconButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  /** Required — an icon alone gives screen readers nothing to announce. */
  accessibilityLabel: string;
  size?: number;
  tone?: ToneName;
  variant?: 'plain' | 'soft' | 'solid' | 'outline';
  disabled?: boolean;
  /** Unread count rendered as a corner badge. Values over 99 show as "99+". */
  badgeCount?: number;
  style?: StyleProp<ViewStyle>;
}

export default function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 22,
  tone = 'neutral',
  variant = 'plain',
  disabled,
  badgeCount,
  style,
}: IconButtonProps) {
  const { colors } = useTheme();
  const t = colors.tone[tone];

  const { background, foreground, borderColor } = {
    plain: { background: 'transparent', foreground: colors.textMuted, borderColor: 'transparent' },
    soft: { background: t.soft, foreground: t.on, borderColor: t.softBorder },
    solid: { background: t.solid, foreground: t.onSolid, borderColor: 'transparent' },
    outline: { background: 'transparent', foreground: t.on, borderColor: colors.border },
  }[variant];

  const box = Math.max(hitTarget.min, size + 18);
  const showBadge = typeof badgeCount === 'number' && badgeCount > 0;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      pressedScale={0.92}
      style={[
        styles.base,
        {
          width: box,
          height: box,
          borderRadius: variant === 'plain' ? box / 2 : radii.md,
          backgroundColor: background,
          borderColor,
          borderWidth: variant === 'outline' || variant === 'soft' ? 1 : 0,
        },
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      <Ionicons name={icon} size={size} color={foreground} />
      {showBadge && (
        <View
          style={[
            styles.badge,
            { backgroundColor: colors.tone.danger.solid, borderColor: colors.surface },
          ]}
        >
          <Text style={[styles.badgeText, { color: colors.tone.danger.onSolid }]} numberOfLines={1}>
            {badgeCount > 99 ? '99+' : badgeCount}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.4,
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    // The ring separates the badge from whatever icon sits beneath it.
    borderWidth: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 13,
  },
});
