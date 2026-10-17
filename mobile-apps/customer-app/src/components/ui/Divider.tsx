import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import { spacing } from '../../theme/tokens';
import Text from './Text';

export interface DividerProps {
  /** Renders the rule with a centred caption — good for "OR" separators. */
  label?: string;
  /** `subtle` for inside a card, `default` between cards. */
  weight?: 'subtle' | 'default';
  spacingY?: keyof typeof spacing;
  style?: StyleProp<ViewStyle>;
}

export default function Divider({ label, weight = 'subtle', spacingY = 'lg', style }: DividerProps) {
  const { colors } = useTheme();
  const lineColor = weight === 'subtle' ? colors.borderSubtle : colors.border;

  if (label) {
    return (
      <View style={[styles.labelled, { marginVertical: spacing[spacingY] }, style]}>
        <View style={[styles.line, { backgroundColor: lineColor }]} />
        <Text variant="micro" color="subtle" uppercase>
          {label}
        </Text>
        <View style={[styles.line, { backgroundColor: lineColor }]} />
      </View>
    );
  }

  return (
    <View
      style={[{ height: StyleSheet.hairlineWidth, backgroundColor: lineColor, marginVertical: spacing[spacingY] }, style]}
    />
  );
}

const styles = StyleSheet.create({
  labelled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  line: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
});
