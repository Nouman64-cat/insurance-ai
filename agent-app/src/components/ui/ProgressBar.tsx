import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, duration } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Text from './Text';

export interface ProgressBarProps {
  /** 0–1. Values outside the range are clamped. */
  value: number;
  tone?: ToneName;
  label?: string;
  /** Renders the percentage on the right of the label row. */
  showValue?: boolean;
  height?: number;
  style?: StyleProp<ViewStyle>;
}

export default function ProgressBar({
  value,
  tone = 'brand',
  label,
  showValue = false,
  height = 8,
  style,
}: ProgressBarProps) {
  const { colors } = useTheme();
  const t = colors.tone[tone];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  const width = useRef(new Animated.Value(clamped)).current;

  useEffect(() => {
    Animated.timing(width, {
      toValue: clamped,
      duration: duration.normal,
      // Width cannot be driven natively, so this animates on the JS thread.
      useNativeDriver: false,
    }).start();
  }, [clamped, width]);

  const percent = Math.round(clamped * 100);

  return (
    <View style={style}>
      {label || showValue ? (
        <View style={styles.labelRow}>
          {label ? (
            <Text variant="caption" color="muted" numberOfLines={1} style={styles.label}>
              {label}
            </Text>
          ) : null}
          {showValue ? (
            <Text variant="captionStrong" style={{ color: t.on }}>
              {percent}%
            </Text>
          ) : null}
        </View>
      ) : null}

      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
        accessibilityLabel={label}
        style={[styles.track, { height, borderRadius: height / 2, backgroundColor: colors.surfaceSunken }]}
      >
        <Animated.View
          style={{
            height: '100%',
            borderRadius: height / 2,
            backgroundColor: t.solid,
            width: width.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  label: {
    flex: 1,
  },
  track: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: radii.pill,
  },
});
