import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { spacing } from '../theme/tokens';
import { ToneName } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { fetchMyCommissionLedger, CommissionEntry } from '../api/commissions';
import {
  Screen,
  ScreenHeader,
  Text,
  Card,
  Badge,
  Banner,
  StatTile,
  EmptyState,
  SkeletonList,
  Divider,
} from '../components/ui';

const STATUS_TONE: Record<string, ToneName> = {
  ACCRUED: 'warning',
  PAYABLE: 'brand',
  DISBURSED: 'success',
};

/** Read-only view of the agent's own commission ledger — SECP Rule 58 gating,
 * gross/net figures, and disbursement status. No disburse/clawback actions;
 * those are a back-office function. */
export default function CommissionScreen() {
  const { colors } = useTheme();
  const { gutter, isCompact, columns } = useResponsive();

  const [entries, setEntries] = useState<CommissionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setRefreshing(true);
    try {
      const data = await fetchMyCommissionLedger();
      setEntries(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load commissions.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load({ silent: true });
  }, [load]);

  const stats = useMemo(() => {
    const gross = entries.reduce((sum, e) => sum + e.grossCommission, 0);
    const net = entries.reduce((sum, e) => sum + e.netCommission, 0);
    const disbursed = entries.filter((e) => e.status === 'DISBURSED').reduce((sum, e) => sum + e.netCommission, 0);
    return { gross, net, disbursed };
  }, [entries]);

  const gridColumns = isCompact ? 1 : columns(340);
  const money = (n: number) => `PKR ${n.toLocaleString()}`;

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader
          title="Commission"
          subtitle={loading ? 'Loading…' : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
          leading="back"
        />
      }
    >
      <View style={{ paddingHorizontal: gutter }}>
        <Banner
          tone="info"
          title="Read-only"
          description="Disbursement and clawbacks are handled by finance. Figures are estimates pending confirmed cash realization."
          icon="lock-closed"
          style={styles.banner}
        />

        {error && !loading ? (
          <Banner
            tone="danger"
            title="Could not refresh"
            description={error}
            actionLabel="Retry"
            onAction={() => load()}
            style={styles.banner}
          />
        ) : null}

        {!loading ? (
          <View style={styles.stats}>
            <StatTile label="Gross commission" value={money(stats.gross)} icon="cash-outline" tone="brand" style={styles.stat} />
            <StatTile label="Net (after WHT)" value={money(stats.net)} icon="wallet-outline" tone="accent" style={styles.stat} />
            <StatTile label="Disbursed" value={money(stats.disbursed)} icon="checkmark-done-outline" tone="success" style={styles.stat} />
          </View>
        ) : null}
      </View>

      {loading ? (
        <View style={{ paddingHorizontal: gutter }}>
          <SkeletonList count={3} />
        </View>
      ) : (
        <FlatList
          key={`comm-${gridColumns}`}
          data={entries}
          keyExtractor={(item) => item.id}
          numColumns={gridColumns}
          columnWrapperStyle={gridColumns > 1 ? styles.column : undefined}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: gutter },
            entries.length === 0 ? styles.listEmpty : null,
          ]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load()}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="cash-outline"
              title="No commission entries yet"
              description="Entries appear here once a proposal you brought in becomes a policy."
            />
          }
          renderItem={({ item }) => (
            <Card padding="lg" style={gridColumns > 1 ? styles.card : undefined}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIdentity}>
                  <Text variant="title3" numberOfLines={1}>
                    {item.customerName}
                  </Text>
                  <Text variant="caption" color="muted" numberOfLines={1}>
                    {item.policyNumber ?? item.policyId} · {item.productName}
                  </Text>
                </View>
                <Badge label={item.status} tone={STATUS_TONE[item.status]} variant="soft" dot />
              </View>

              <Divider spacingY="md" />

              <View style={styles.details}>
                <Detail label="Collected premium" value={money(item.collectedPremium)} />
                <Detail label="Rate" value={`${item.ratePct}%`} />
                <Detail label="Gross commission" value={money(item.grossCommission)} />
                <Detail label="WHT (10%)" value={`− ${money(item.whtTax)}`} />
                <Detail label="Net commission" value={money(item.netCommission)} />
              </View>

              <Text variant="caption" color="subtle" style={styles.gating}>
                {item.gatingReason}
              </Text>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text variant="micro" color="subtle" uppercase>
        {label}
      </Text>
      <Text variant="bodyStrong" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  stat: {
    flexGrow: 1,
    minWidth: 150,
  },
  listContent: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
  },
  listEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  column: {
    gap: spacing.md,
  },
  card: {
    flex: 1,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  cardIdentity: {
    flex: 1,
  },
  details: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
  },
  detail: {
    flexGrow: 1,
    minWidth: 130,
    gap: spacing.xxs,
  },
  gating: {
    marginTop: spacing.md,
  },
});
