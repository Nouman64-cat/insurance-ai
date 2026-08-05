import React, { useContext } from 'react';
import { StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
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
  /** Extra clearance on top of the automatic tab-bar/safe-area offset. */
  extraBottomOffset?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Floating primary action, anchored bottom-right.
 *
 * The offset is measured, not guessed: a hardcoded margin sits *on top of* the
 * bottom tab bar, which is 62pt on Android and 84pt on iOS. Reading the real
 * height from navigation — and falling back to the safe-area inset on screens
 * with no tab bar — is what keeps it clear on every device.
 */
export default function Fab({
  icon,
  onPress,
  label,
  tone = 'brand',
  accessibilityLabel,
  extraBottomOffset = 0,
  style,
}: FabProps) {
  const { colors, shadow } = useTheme();
  const insets = useSafeAreaInsets();
  const t = colors.tone[tone];

  // Context rather than `useBottomTabBarHeight()`: the hook throws outside a
  // tab navigator, and this component is also used on plain stack screens.
  const tabBarHeight = useContext(BottomTabBarHeightContext);

  // The tab bar already includes the safe-area inset, so the two must not be
  // added together — that would double-count the home indicator.
  const bottom = (tabBarHeight ?? insets.bottom) + spacing.lg + extraBottomOffset;

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
