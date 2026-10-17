import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { Text, Pressable } from './ui';

interface CheckboxCardProps {
  title: string;
  subtitle?: string;
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A checkbox with room to explain what ticking it means. Used throughout the
 * underwriting forms, where a bare label would leave the agent guessing.
 */
export default function CheckboxCard({
  title,
  subtitle,
  checked,
  onPress,
  disabled,
  style,
}: CheckboxCardProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      pressedScale={0.99}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      style={[
        styles.container,
        {
          backgroundColor: checked ? colors.tone.brand.soft : colors.surface,
          borderColor: checked ? colors.tone.brand.softBorder : colors.border,
        },
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      <View
        style={[
          styles.box,
          {
            backgroundColor: checked ? colors.tone.brand.solid : 'transparent',
            borderColor: checked ? colors.tone.brand.solid : colors.borderStrong,
          },
        ]}
      >
        {checked ? <Ionicons name="checkmark" size={15} color={colors.tone.brand.onSolid} /> : null}
      </View>

      <View style={styles.text}>
        <Text variant="calloutStrong" style={checked ? { color: colors.tone.brand.on } : undefined}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="muted" style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
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
    marginBottom: spacing.md,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: radii.xs,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    // Aligns the box with the first line of the title rather than the block.
    marginTop: 1,
  },
  text: {
    flex: 1,
  },
  subtitle: {
    marginTop: spacing.xxs,
  },
  disabled: {
    opacity: 0.5,
  },
});
