import React from 'react';
import { View, ScrollView, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { hitTarget, radii, spacing } from '../../theme/tokens';
import Pressable from './Pressable';
import Text from './Text';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Rendered as a trailing count pill — useful for filter tallies. */
  count?: number;
}

export interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * `track` is the iOS-style pill group for 2–3 mutually exclusive views.
   * `chips` is a horizontally scrolling filter row for longer sets.
   */
  variant?: 'track' | 'chips';
  style?: StyleProp<ViewStyle>;
  /** Horizontal padding applied to the chips scroll content. */
  contentPadding?: number;
}

export default function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  variant = 'track',
  style,
  contentPadding = 0,
}: SegmentedControlProps<T>) {
  const { colors, shadow } = useTheme();

  if (variant === 'chips') {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // A ScrollView defaults to flexGrow: 1, which inside a column makes it stretch to fill spare height and turns the chips
        // into tall blobs. The row must be exactly as tall as its chips.
        style={styles.chipScroll}
        accessibilityRole="tablist"
        contentContainerStyle={[
          styles.chipRow,
          { paddingHorizontal: contentPadding },
          style as ViewStyle,
        ]}
      >
        {segments.map((seg) => {
          const active = seg.value === value;
          return (
            <Pressable
              key={seg.value}
              onPress={() => onChange(seg.value)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={seg.label}
              pressedScale={0.95}
              style={[
                styles.chip,
                {
                  backgroundColor: active ? colors.tone.brand.solid : colors.surface,
                  borderColor: active ? colors.tone.brand.solid : colors.border,
                },
              ]}
            >
              {seg.icon ? (
                <Ionicons
                  name={seg.icon}
                  size={14}
                  color={active ? colors.tone.brand.onSolid : colors.textMuted}
                />
              ) : null}
              <Text
                variant="calloutStrong"
                numberOfLines={1}
                style={{ color: active ? colors.tone.brand.onSolid : colors.text }}
              >
                {seg.label}
              </Text>
              {typeof seg.count === 'number' ? (
                <View
                  style={[
                    styles.count,
                    {
                      backgroundColor: active
                        ? 'rgba(255,255,255,0.24)'
                        : colors.surfaceSunken,
                    },
                  ]}
                >
                  <Text
                    variant="captionStrong"
                    style={{ color: active ? colors.tone.brand.onSolid : colors.textMuted }}
                  >
                    {seg.count}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }

  return (
    <View style={[styles.track, { backgroundColor: colors.surfaceSunken }, style]}>
      {segments.map((seg) => {
        const active = seg.value === value;
        return (
          <Pressable
            key={seg.value}
            onPress={() => onChange(seg.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={seg.label}
            pressedScale={0.97}
            style={[
              styles.trackItem,
              active ? [{ backgroundColor: colors.surface }, shadow(1)] : null,
            ]}
          >
            {seg.icon ? (
              <Ionicons
                name={seg.icon}
                size={16}
                color={active ? colors.tone.brand.on : colors.textMuted}
              />
            ) : null}
            <Text
              variant="captionStrong"
              numberOfLines={1}
              style={{ color: active ? colors.tone.brand.on : colors.textMuted }}
            >
              {seg.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: radii.md,
    padding: 3,
    gap: 3,
  },
  trackItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  chipScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: hitTarget.min - 4, // 40pt chip inside a 44pt touch row
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  count: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
