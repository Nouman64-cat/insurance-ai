import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import Text from './Text';

export interface AvatarProps {
  /** Initials are derived from this. Falls back to the icon when absent. */
  name?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  size?: number;
  tone?: ToneName;
  /** Squircle reads as an entity/company; circle reads as a person. */
  shape?: 'circle' | 'rounded';
  style?: StyleProp<ViewStyle>;
}

/** Takes the first letter of the first and last word — "Ali Raza Khan" → "AK". */
const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
};

export default function Avatar({
  name,
  icon,
  size = 44,
  tone = 'brand',
  shape = 'circle',
  style,
}: AvatarProps) {
  const { colors } = useTheme();
  const t = colors.tone[tone];
  const label = name?.trim() ? initialsOf(name) : null;

  return (
    <View
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: shape === 'circle' ? size / 2 : radii.md,
          backgroundColor: t.soft,
          borderColor: t.softBorder,
        },
        style,
      ]}
    >
      {label ? (
        <Text
          // Scaled off the container so initials stay optically centred at any size.
          style={{ fontSize: size * 0.38, fontWeight: '700', color: t.on }}
        >
          {label}
        </Text>
      ) : (
        <Ionicons name={icon ?? 'person'} size={size * 0.46} color={t.on} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
