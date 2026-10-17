import React from 'react';
import { ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import StatTile from './ui/StatTile';
import { ToneName } from '../theme/palette';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  accent?: 'blue' | 'emerald' | 'amber' | 'slate';
  iconName?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Maps the legacy colour names onto semantic tones. */
const ACCENT_TONE: Record<NonNullable<MetricCardProps['accent']>, ToneName> = {
  blue: 'brand',
  emerald: 'success',
  amber: 'warning',
  slate: 'neutral',
};

/**
 * Compatibility shim over the design-system StatTile. New code should import
 * `StatTile` from `components/ui` directly.
 */
export default function MetricCard({
  title,
  value,
  subtitle,
  accent = 'blue',
  iconName,
  loading,
  onPress,
  style,
}: MetricCardProps) {
  return (
    <StatTile
      label={title}
      value={value}
      caption={subtitle}
      icon={iconName}
      tone={ACCENT_TONE[accent]}
      loading={loading}
      onPress={onPress}
      style={style}
    />
  );
}
