import React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, SpacingKey, RadiusKey } from '../../theme/tokens';
import Pressable from './Pressable';

export interface CardProps {
  children?: React.ReactNode;
  /** Depth in the elevation scale. 0 pairs with `bordered` for a flat card. */
  level?: 0 | 1 | 2 | 3 | 4;
  padding?: SpacingKey;
  radius?: RadiusKey;
  /** Sunken cards read as nested — use inside another card. */
  variant?: 'surface' | 'sunken' | 'elevated' | 'outline';
  bordered?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

/** The standard content container. Every list row and panel is built on this. */
export default function Card({
  children,
  level = 1,
  padding = 'lg',
  radius = 'lg',
  variant = 'surface',
  bordered = true,
  onPress,
  style,
  accessibilityLabel,
}: CardProps) {
  const { colors, shadow } = useTheme();

  const background = {
    surface: colors.surface,
    sunken: colors.surfaceSunken,
    elevated: colors.surfaceElevated,
    outline: 'transparent',
  }[variant];

  const base: StyleProp<ViewStyle> = [
    {
      backgroundColor: background,
      borderRadius: radii[radius],
      padding: spacing[padding],
    },
    bordered ? { borderWidth: 1, borderColor: colors.border } : null,
    // A transparent card casting a shadow renders as a floating grey smudge.
    variant === 'outline' ? null : shadow(level),
    style,
  ];

  if (onPress) {
    return (
      <Pressable
        style={base}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {children}
      </Pressable>
    );
  }

  return <View style={base}>{children}</View>;
}
