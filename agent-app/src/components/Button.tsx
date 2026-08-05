import React from 'react';
import { ViewStyle, TextStyle, StyleProp } from 'react-native';
import UIButton from './ui/Button';

interface LegacyButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  type?: 'primary' | 'secondary' | 'danger';
}

/**
 * Compatibility shim over the design-system Button, so screens that have not
 * migrated to `components/ui` still render themed, dark-mode-correct buttons.
 * New code should import `Button` from `components/ui` directly.
 */
export default function Button({ type = 'primary', ...props }: LegacyButtonProps) {
  const { variant, tone } = (
    {
      primary: { variant: 'solid', tone: 'brand' },
      secondary: { variant: 'soft', tone: 'brand' },
      danger: { variant: 'solid', tone: 'danger' },
    } as const
  )[type];

  // The legacy button always stretched to its container, and callers rely on it.
  return <UIButton variant={variant} tone={tone} fullWidth {...props} />;
}
