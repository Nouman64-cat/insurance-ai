import React from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { spacing } from '../theme/tokens';
import { ToneName } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { SECP_DEFAULT_RULES, CommissionRule } from '../api/commissions';
import { Screen, ScreenHeader, Text, Card, Badge, Banner, Divider } from '../components/ui';

const SEGMENT_TONE: Record<CommissionRule['segment'], ToneName> = {
  individual: 'brand',
  group: 'accent',
  family: 'info',
};

const PREMIUM_LABEL: Record<CommissionRule['premiumType'], string> = {
  FIRST_YEAR: 'First year',
  RENEWAL: 'Renewal',
  SINGLE_PREMIUM: 'Single premium',
};

/** Read-only reference: the statutory SECP commission rate matrix — same
 * source of truth as the web portal's "SECP Rate Card Matrix". */
export default function SECPRateCardScreen() {
  const { gutter } = useResponsive();

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={<ScreenHeader title="SECP Commission Types" subtitle="Statutory commission matrix" leading="back" />}
    >
      <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: gutter }]} showsVerticalScrollIndicator={false}>
        <Banner
          tone="info"
          title="SECP Insurance Rules 2017"
          description="Statutory reference rates. Actual payable commission is subject to cash-realization gating (Rule 58)."
          icon="document-text-outline"
          style={styles.banner}
        />

        {SECP_DEFAULT_RULES.map((rule) => (
          <Card key={rule.id} padding="lg" style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.cardIdentity}>
                <Text variant="title3" numberOfLines={2}>
                  {rule.description}
                </Text>
                <Text variant="caption" color="muted">
                  {PREMIUM_LABEL[rule.premiumType]} · Policy year {rule.policyYear}
                </Text>
              </View>
              <Badge label={rule.segment} tone={SEGMENT_TONE[rule.segment]} variant="soft" />
            </View>

            <Divider spacingY="md" />

            <View style={styles.rateRow}>
              <Text variant="overline" color="subtle" uppercase>
                Rate
              </Text>
              <Text style={styles.rateValue}>{rule.ratePct}%</Text>
            </View>

            <Text variant="caption" color="subtle" style={styles.ref}>
              {rule.secpRef}
            </Text>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
  },
  banner: {
    marginBottom: spacing.sm,
  },
  card: {
    gap: 0,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  cardIdentity: {
    flex: 1,
    gap: spacing.xxs,
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  rateValue: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
  },
  ref: {
    marginTop: spacing.sm,
  },
});
