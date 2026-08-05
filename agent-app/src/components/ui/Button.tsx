import React from 'react';
import { ActivityIndicator, StyleSheet, ViewStyle, TextStyle, StyleProp, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, typography, hitTarget } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Pressable from './Pressable';
import Text from './Text';

export type ButtonVariant = 'solid' | 'soft' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  tone?: ToneName;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  iconPosition?: 'left' | 'right';
  /** Stretches to fill the parent — the default for form submit buttons. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityHint?: string;
}

const SIZES: Record<ButtonSize, { height: number; padH: number; font: keyof typeof typography; icon: number }> = {
  sm: { height: 36, padH: spacing.md, font: 'calloutStrong', icon: 15 },
  md: { height: hitTarget.comfortable, padH: spacing.xl, font: 'bodyStrong', icon: 18 },
  lg: { height: 54, padH: spacing.xxl, font: 'title3', icon: 20 },
};

export default function Button({
  title,
  onPress,
  variant = 'solid',
  tone = 'brand',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  iconPosition = 'left',
  fullWidth = false,
  style,
  textStyle,
  accessibilityHint,
}: ButtonProps) {
  const { colors, shadow } = useTheme();
  const t = colors.tone[tone];
  const dims = SIZES[size];
  const isInactive = disabled || loading;

  const { background, foreground, borderColor } = {
    solid: { background: t.solid, foreground: t.onSolid, borderColor: 'transparent' },
    soft: { background: t.soft, foreground: t.on, borderColor: t.softBorder },
    outline: { background: 'transparent', foreground: t.on, borderColor: colors.borderStrong },
    ghost: { background: 'transparent', foreground: t.on, borderColor: 'transparent' },
  }[variant];

  const iconNode = icon ? <Ionicons name={icon} size={dims.icon} color={foreground} /> : null;

  return (
    <Pressable
      onPress={onPress}
      disabled={isInactive}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInactive, busy: loading }}
      style={[
        styles.base,
        {
          minHeight: dims.height,
          paddingHorizontal: dims.padH,
          backgroundColor: background,
          borderColor,
          borderWidth: variant === 'outline' || variant === 'soft' ? 1 : 0,
        },
        fullWidth ? styles.fullWidth : styles.hugContent,
        // Only a raised, filled button should cast a shadow.
        variant === 'solid' && !isInactive ? shadow(1) : null,
        isInactive ? styles.inactive : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : (
        <View style={styles.content}>
          {iconPosition === 'left' ? iconNode : null}
          <Text
            variant={dims.font}
            numberOfLines={1}
            style={[{ color: foreground }, textStyle]}
          >
            {title}
          </Text>
          {iconPosition === 'right' ? iconNode : null}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  hugContent: {
    alignSelf: 'flex-start',
  },
  inactive: {
    opacity: 0.45,
  },
});
