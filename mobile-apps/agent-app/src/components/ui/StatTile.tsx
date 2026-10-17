import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Text from './Text';
import Pressable from './Pressable';
import { Skeleton } from './Skeleton';

export interface StatTileProps {
  label: string;
  value: string | number;
  /** Context under the value — "vs last week", "of 40 target". */
  caption?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: ToneName;
  /** Signed change. Direction picks the arrow and the success/danger colour. */
  delta?: number;
  /** Inverts delta colouring for metrics where down is good (e.g. dead leads). */
  invertDelta?: boolean;
  loading?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Compact KPI tile for dashboard grids. */
export default function StatTile({
  label,
  value,
  caption,
  icon,
  tone = 'brand',
  delta,
  invertDelta = false,
  loading = false,
  onPress,
  style,
}: StatTileProps) {
  const { colors, shadow } = useTheme();
  const t = colors.tone[tone];

  const hasDelta = typeof delta === 'number' && delta !== 0;
  const isUp = (delta ?? 0) > 0;
  const deltaIsGood = invertDelta ? !isUp : isUp;
  const deltaTone = colors.tone[deltaIsGood ? 'success' : 'danger'];

  const body = (
    <>
      <View style={styles.header}>
        <Text variant="overline" color="muted" numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        {icon ? (
          <View style={[styles.iconWrap, { backgroundColor: t.soft, borderColor: t.softBorder }]}>
            <Ionicons name={icon} size={15} color={t.on} />
          </View>
        ) : null}
      </View>

      {loading ? (
        <Skeleton width="55%" height={28} style={styles.valueSkeleton} />
      ) : (
        <Text variant="title1" numberOfLines={1} style={[styles.value, { color: t.on }]}>
          {value}
        </Text>
      )}

      <View style={styles.footer}>
        {hasDelta && !loading ? (
          <View style={[styles.delta, { backgroundColor: deltaTone.soft }]}>
            <Ionicons
              name={isUp ? 'trending-up' : 'trending-down'}
              size={11}
              color={deltaTone.on}
            />
            <Text variant="micro" style={{ color: deltaTone.on }}>
              {isUp ? '+' : ''}
              {delta}
            </Text>
          </View>
        ) : null}
        {caption ? (
          <Text variant="micro" color="subtle" numberOfLines={1} style={styles.caption}>
            {caption}
          </Text>
        ) : null}
      </View>
    </>
  );

  const tileStyle: StyleProp<ViewStyle> = [
    styles.tile,
    { backgroundColor: colors.surface, borderColor: colors.border },
    shadow(1),
    style,
  ];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={tileStyle}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View style={tileStyle} accessibilityLabel={`${label}: ${value}`}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minWidth: 0,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  label: {
    flex: 1,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: radii.xs,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    marginBottom: spacing.xs,
  },
  valueSkeleton: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 16,
  },
  delta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
  },
  caption: {
    flex: 1,
  },
});
