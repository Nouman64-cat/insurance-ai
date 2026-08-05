import React from 'react';
import { StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Pressable from './Pressable';
import Text from './Text';

export interface FabProps {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  /** Omit for a circular icon-only FAB; supply for the extended pill form. */
  label?: string;
  tone?: ToneName;
  accessibilityLabel?: string;
  /** Adds clearance for a bottom tab bar sitting under the FAB. */
  aboveTabBar?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Floating primary action, anchored bottom-right above the safe area. */
export default function Fab({
  icon,
  onPress,
  label,
  tone = 'brand',
  accessibilityLabel,
  aboveTabBar = true,
  style,
}: FabProps) {
  const { colors, shadow } = useTheme();
  const insets = useSafeAreaInsets();
  const t = colors.tone[tone];

  // The tab bar already sits inside the safe area, so only its own height needs
  // clearing on top of the standard margin.
  const bottom = (aboveTabBar ? spacing.xl : spacing.xl + insets.bottom) + spacing.xs;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label ?? 'Primary action'}
      pressedScale={0.94}
      style={[
        styles.fab,
        label ? styles.extended : styles.circular,
        { backgroundColor: t.solid, bottom },
        shadow(3),
        style,
      ]}
    >
      <Ionicons name={icon} size={label ? 20 : 26} color={t.onSolid} />
      {label ? (
        <Text variant="bodyStrong" style={{ color: t.onSolid }} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circular: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  extended: {
    height: 52,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.xxl,
    gap: spacing.sm,
  },
});
