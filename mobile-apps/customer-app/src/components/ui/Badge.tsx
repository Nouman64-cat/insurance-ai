import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, typography } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Text from './Text';

export interface BadgeProps {
  label: string;
  tone?: ToneName;
  /** `soft` for status pills, `solid` for counts that must not be missed. */
  variant?: 'soft' | 'solid' | 'outline';
  size?: 'sm' | 'md';
  icon?: keyof typeof Ionicons.glyphMap;
  /** Renders a filled circle in the tone colour — good for live status. */
  dot?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function Badge({
  label,
  tone = 'neutral',
  variant = 'soft',
  size = 'sm',
  icon,
  dot,
  style,
}: BadgeProps) {
  const { colors } = useTheme();
  const t = colors.tone[tone];

  const background = variant === 'solid' ? t.solid : variant === 'soft' ? t.soft : 'transparent';
  const foreground = variant === 'solid' ? t.onSolid : t.on;
  const borderColor = variant === 'outline' ? t.softBorder : variant === 'soft' ? t.softBorder : 'transparent';

  const isSmall = size === 'sm';
  const iconSize = isSmall ? 11 : 13;

  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: background,
          borderColor,
          borderWidth: variant === 'solid' ? 0 : 1,
          paddingHorizontal: isSmall ? spacing.sm : spacing.md,
          paddingVertical: isSmall ? 3 : 5,
        },
        style,
      ]}
    >
      {dot && <View style={[styles.dot, { backgroundColor: foreground }]} />}
      {icon && <Ionicons name={icon} size={iconSize} color={foreground} />}
      <Text
        style={[isSmall ? typography.micro : typography.captionStrong, { color: foreground }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    borderRadius: radii.pill,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
