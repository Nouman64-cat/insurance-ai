import React from 'react';
import { Image, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

const SOURCES = {
  full: require('../../assets/logo-full.png'),               // shield + GETINSUREDAI + "powered by Rizviz"
  horizontal: require('../../assets/logo-horizontal.png'),   // shield + GETINSUREDAI
  mark: require('../../assets/logo-mark.png'),               // the shield alone
} as const;

// Pixel size of each file, so the logo is always drawn in its own proportions.
const RATIO = { full: 1331 / 343, horizontal: 1330 / 343, mark: 314 / 343 } as const;

export type LogoVariant = keyof typeof SOURCES;

/**
 * The GetInsuredAI logo. The wordmark is navy, so in dark mode it sits on a white rounded plate (like the chat bot does) to stay
 * readable; the artwork is transparent and needs no plate on a light surface.
 */
export default function Logo({ variant = 'full', width = 240 }: { variant?: LogoVariant; width?: number }) {
  const { isDark } = useTheme();
  const height = width / RATIO[variant];
  const image = (
    <Image source={SOURCES[variant]} style={{ width, height }} resizeMode="contain" accessible accessibilityRole="image" accessibilityLabel="GetInsuredAI" />
  );
  if (!isDark) return image;
  return <View style={{ backgroundColor: '#ffffff', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 }}>{image}</View>;
}
