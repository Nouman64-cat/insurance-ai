import React from 'react';
import { View, StyleSheet, Image } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import {
  Screen,
  ScreenHeader,
  Card,
  Text,
  ListRow,
  Divider,
  SectionHeader,
} from '../components/ui';

const LOGO = require('../assets/rizvi.png');

const CAPABILITIES: { icon: 'people-outline' | 'sparkles-outline' | 'shield-checkmark-outline' | 'sync-outline'; title: string; description: string }[] = [
  {
    icon: 'people-outline',
    title: 'Lead capture',
    description: 'Individual, family and corporate leads, captured quickly or in full.',
  },
  {
    icon: 'sync-outline',
    title: 'Live portal sync',
    description: 'Every lead you add appears in the web portal, and vice versa.',
  },
  {
    icon: 'shield-checkmark-outline',
    title: 'Underwriting',
    description: 'E-applications, confidential reports and risk assessment in one flow.',
  },
  {
    icon: 'sparkles-outline',
    title: 'AI copilot',
    description: 'Ask questions and drive the workflow in plain language.',
  },
];

export default function AboutScreen() {
  const { colors } = useTheme();

  return (
    <Screen header={<ScreenHeader title="About" leading="menu" />}>
      <Card padding="xl" style={styles.hero}>
        <View style={[styles.logoPlate, { backgroundColor: colors.surfaceSunken }]}>
          <Image source={LOGO} style={styles.logo} resizeMode="contain" accessibilityLabel="Rizvi" />
        </View>
        <Text variant="title2" align="center" style={styles.title}>
          Rizvi Agent Portal
        </Text>
        <Text variant="callout" color="muted" align="center" style={styles.blurb}>
          The field companion for Rizvi insurance agents — from the first phone call through
          underwriting to policy issuance, on the same data the web portal uses.
        </Text>
      </Card>

      <SectionHeader title="What it does" icon="apps-outline" />
      <Card padding="md" style={styles.section}>
        {CAPABILITIES.map((item, index) => (
          <React.Fragment key={item.title}>
            {index > 0 ? <Divider spacingY="none" /> : null}
            <ListRow
              title={item.title}
              subtitle={item.description}
              icon={item.icon}
              tone="brand"
              showChevron={false}
            />
          </React.Fragment>
        ))}
      </Card>

      <SectionHeader title="Build" icon="code-slash-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow title="Version" value="1.0.0" icon="pricetag-outline" tone="neutral" />
        <Divider spacingY="none" />
        <ListRow title="Build" value="2026.08.05" icon="calendar-outline" tone="neutral" />
        <Divider spacingY="none" />
        <ListRow title="Platform" value="Expo · React Native" icon="phone-portrait-outline" tone="neutral" />
      </Card>

      <Text variant="caption" color="subtle" align="center" style={styles.footer}>
        © {new Date().getFullYear()} Rizvi Insurance. All rights reserved.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: spacing.lg,
    marginBottom: spacing.xxl,
    alignItems: 'center',
  },
  logoPlate: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderRadius: radii.lg,
    marginBottom: spacing.xl,
  },
  logo: {
    width: 156,
    height: 56,
  },
  title: {
    marginBottom: spacing.sm,
  },
  blurb: {
    maxWidth: 340,
  },
  section: {
    marginBottom: spacing.xxl,
  },
  footer: {
    marginTop: spacing.sm,
    marginBottom: spacing.xxl,
  },
});
