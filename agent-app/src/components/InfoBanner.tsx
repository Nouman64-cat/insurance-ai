import React from 'react';
import { ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Banner from './ui/Banner';
import { ToneName } from '../theme/palette';

interface InfoBannerProps {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Legacy hex colour. Mapped onto the nearest semantic tone. */
  color?: string;
  /** Legacy hex background. Ignored — the tone supplies a theme-aware fill. */
  bgColor?: string;
  tone?: ToneName;
  style?: StyleProp<ViewStyle>;
}

/**
 * Maps the hard-coded hex colours the old call sites pass onto semantic tones,
 * so those banners pick up dark mode without every screen being edited.
 */
const HEX_TONE: Record<string, ToneName> = {
  '#ef4444': 'danger',
  '#dc2626': 'danger',
  '#f59e0b': 'warning',
  '#d97706': 'warning',
  '#3b82f6': 'brand',
  '#2563eb': 'brand',
  '#10b981': 'success',
  '#059669': 'success',
};

/**
 * Compatibility shim over the design-system Banner. New code should import
 * `Banner` from `components/ui` directly.
 */
export default function InfoBanner({ title, subtitle, icon, color, tone, style }: InfoBannerProps) {
  const resolved = tone ?? (color ? HEX_TONE[color.toLowerCase()] ?? 'info' : 'info');
  return <Banner title={title} description={subtitle} icon={icon} tone={resolved} style={style} />;
}
