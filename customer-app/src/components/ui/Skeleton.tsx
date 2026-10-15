import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, ViewStyle, StyleProp, DimensionValue } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing } from '../../theme/tokens';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Pulsing placeholder. Showing the shape of the content that is coming reads as
 * faster than a spinner, and avoids the layout jump when data lands.
 */
export function Skeleton({ width = '100%', height = 14, radius = radii.xs, style }: SkeletonProps) {
  const { colors } = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    // Without this the animation keeps ticking after the list swaps in real rows.
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: colors.surfaceSunken,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
        },
        style,
      ]}
    />
  );
}

/** A card-shaped skeleton matching the metrics of a real list row. */
export function SkeletonCard() {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.row}>
        <Skeleton width={44} height={44} radius={22} />
        <View style={styles.rowText}>
          <Skeleton width="62%" height={15} />
          <Skeleton width="38%" height={12} />
        </View>
      </View>
      <Skeleton width="85%" height={12} />
      <View style={styles.row}>
        <Skeleton width={72} height={22} radius={radii.pill} />
        <Skeleton width={96} height={22} radius={radii.pill} />
      </View>
    </View>
  );
}

/** Renders `count` skeleton cards — the standard list loading state. */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  list: {
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  rowText: {
    flex: 1,
    gap: spacing.sm,
  },
});

export default Skeleton;
