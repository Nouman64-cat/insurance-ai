import React from 'react';
import { View } from 'react-native';
import { Text } from '../../components/ui';
import Screen from '../../components/ui/Screen';
import Logo from '../../components/Logo';
import { useResponsive } from '../../hooks/useResponsive';

/** Shared frame for the signed-out screens: the logo, then a title and subtitle, then the form. */
export default function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const { contentWidth } = useResponsive();
  return (
    <Screen scrollable padded keyboardAvoiding contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 24, gap: 16 }}>
      <View style={{ alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Logo variant="full" width={Math.min(300, contentWidth)} />
        <Text variant="title1" align="center">{title}</Text>
        {subtitle ? <Text variant="callout" color="muted" align="center">{subtitle}</Text> : null}
      </View>
      {children}
    </Screen>
  );
}
