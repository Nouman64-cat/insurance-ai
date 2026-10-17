import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, hitTarget } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Text from './Text';
import Pressable from './Pressable';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: ToneName;
  /** Right-hand read-only value, e.g. the current setting. */
  value?: string;
  onPress?: () => void;
  /** Shows a chevron. Defaults to true whenever `onPress` is given. */
  showChevron?: boolean;
  /** Renders a Switch on the right instead of a chevron. */
  toggle?: { value: boolean; onValueChange: (v: boolean) => void };
  /** Arbitrary trailing content; wins over `value`, `toggle` and the chevron. */
  right?: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Settings-style row. The building block for every menu and detail list. */
export default function ListRow({
  title,
  subtitle,
  icon,
  tone = 'neutral',
  value,
  onPress,
  showChevron,
  toggle,
  right,
  destructive,
  disabled,
  style,
}: ListRowProps) {
  const { colors } = useTheme();
  const t = colors.tone[destructive ? 'danger' : tone];
  const chevron = showChevron ?? (!!onPress && !toggle && !right);

  const content = (
    <>
      {icon ? (
        <View style={[styles.iconWrap, { backgroundColor: t.soft, borderColor: t.softBorder }]}>
          <Ionicons name={icon} size={18} color={t.on} />
        </View>
      ) : null}

      <View style={styles.text}>
        <Text
          variant="bodyStrong"
          numberOfLines={1}
          style={destructive ? { color: colors.tone.danger.on } : undefined}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="muted" numberOfLines={2} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {right ??
        (toggle ? (
          <Switch
            value={toggle.value}
            onValueChange={toggle.onValueChange}
            disabled={disabled}
            trackColor={{ false: colors.surfaceSunken, true: colors.tone.brand.solid }}
            thumbColor={colors.surface}
            // iOS renders a light border around the off state that clashes on dark.
            ios_backgroundColor={colors.surfaceSunken}
            accessibilityLabel={title}
          />
        ) : value ? (
          <Text variant="callout" color="muted" numberOfLines={1} style={styles.value}>
            {value}
          </Text>
        ) : null)}

      {chevron ? <Ionicons name="chevron-forward" size={18} color={colors.textSubtle} /> : null}
    </>
  );

  const rowStyle: StyleProp<ViewStyle> = [styles.row, disabled ? styles.disabled : null, style];

  if (!onPress) {
    return <View style={rowStyle}>{content}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ disabled: !!disabled }}
      pressedScale={0.99}
      style={rowStyle}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: hitTarget.comfortable,
    paddingVertical: spacing.md,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
  },
  subtitle: {
    marginTop: spacing.xxs,
  },
  value: {
    maxWidth: 140,
  },
  disabled: {
    opacity: 0.5,
  },
});
