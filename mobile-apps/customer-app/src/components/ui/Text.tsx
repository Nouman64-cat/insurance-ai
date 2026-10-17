import React from 'react';
import { Text as RNText, TextProps as RNTextProps, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import { typography, TypographyKey } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';

export interface TextProps extends RNTextProps {
  /** Typographic role. Drives size, weight, line height and tracking together. */
  variant?: TypographyKey;
  /** Semantic colour role, resolved against the active theme. */
  color?: 'default' | 'muted' | 'subtle' | 'inverse' | ToneName;
  align?: 'auto' | 'left' | 'right' | 'center';
  /** Renders in caps with the tracking `overline` expects. */
  uppercase?: boolean;
  children?: React.ReactNode;
}

/**
 * The only Text component screens should use. Centralising the type scale here
 * is what keeps 17 screens from each inventing their own "14px semibold slate".
 */
export default function Text({
  variant = 'body',
  color = 'default',
  align,
  uppercase,
  style,
  ...props
}: TextProps) {
  const { colors } = useTheme();

  const resolveColor = () => {
    switch (color) {
      case 'default': return colors.text;
      case 'muted': return colors.textMuted;
      case 'subtle': return colors.textSubtle;
      case 'inverse': return colors.textInverse;
      default: return colors.tone[color].on;
    }
  };

  return (
    <RNText
      style={[
        styles.base,
        typography[variant],
        { color: resolveColor() },
        align ? { textAlign: align } : null,
        uppercase ? styles.uppercase : null,
        style,
      ]}
      {...props}
    />
  );
}

const styles = StyleSheet.create({
  // React Native's layout default is flexShrink: 0 (unlike CSS), so text beside another element in a row never wraps: a long
  // receipt number or address is pushed off the edge of the screen. Letting text shrink makes it wrap inside whatever room it has.
  // Callers can still override it through `style`.
  base: {
    flexShrink: 1,
  },
  uppercase: {
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
});
