import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../theme/ThemeContext';
import { spacing } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import { useResponsive } from '../../hooks/useResponsive';
import { fetchPostUnderwritingCases, PreUnderwritingCase, PolicyReadiness } from '../../api/preUnderwriting';
import { Text, Card, Badge, Banner, EmptyState, SkeletonList, Divider } from '../../components/ui';

type ReadyItem = PreUnderwritingCase & { readiness: PolicyReadiness | null };

const STEP_TONE: Record<string, ToneName> = {
  CLEARED: 'success',
  PASSED: 'success',
  PAID: 'success',
  ACCEPTED: 'success',
  NOT_REQUIRED: 'success',
  PENDING: 'warning',
  OUTSTANDING: 'warning',
  FLAGGED: 'danger',
};

const stepTone = (status?: string): ToneName => STEP_TONE[(status ?? '').toUpperCase()] ?? 'neutral';

const STEPS: Array<{ key: keyof PolicyReadiness['steps']; label: string }> = [
  { key: 'revised_terms', label: 'Revised terms' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'premium', label: 'Premium' },
  { key: 'compliance', label: 'Compliance' },
];

/**
 * Post-Underwriting stage — Stage A pre-issuance verification (revised
 * terms, outstanding requirements, premium collection, compliance re-check)
 * for cases that have cleared the 6 pre-underwriting gates. Read-only: this
 * is an underwriting-ops handoff, not something an agent actions.
 */
export default function PostUnderwritingBody({ onSubtitle }: { onSubtitle?: (s: string) => void }) {
  const { colors } = useTheme();
  const { gutter, isCompact, columns } = useResponsive();

  const [items, setItems] = useState<ReadyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setRefreshing(true);
    try {
      const data = await fetchPostUnderwritingCases();
      setItems(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load readiness.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load({ silent: true });
  }, [load]);

  // Readiness can change while the agent stays on this exact screen (e.g.
  // underwriting clears a requirement) — poll while focused, same as
  // Pre-Underwriting, rather than only refreshing on in-app navigation.
  useFocusEffect(
    useCallback(() => {
      load({ silent: true });
      const timer = setInterval(() => load({ silent: true }), 15_000);
      return () => clearInterval(timer);
    }, [load])
  );

  useEffect(() => {
    onSubtitle?.(loading ? 'Loading…' : `${items.length} awaiting verification`);
  }, [loading, items.length, onSubtitle]);

  const gridColumns = isCompact ? 1 : columns(360);

  return (
    <>
      <View style={{ paddingHorizontal: gutter }}>
        <Banner
          tone="warning"
          title="Read-only view"
          description="Pre-issuance verification — counter-offers, requirements, and compliance sign-off — is handled by underwriting ops."
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
      </View>

      {loading ? (
        <View style={{ paddingHorizontal: gutter }}>
          <SkeletonList count={3} />
        </View>
      ) : (
        <FlatList
          key={`postuw-${gridColumns}`}
          data={items}
          keyExtractor={(item) => item.id}
          numColumns={gridColumns}
          columnWrapperStyle={gridColumns > 1 ? styles.column : undefined}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: gutter },
            items.length === 0 ? styles.listEmpty : null,
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
              icon="ribbon-outline"
              title="Nothing awaiting verification"
              description="Cases appear here once all 6 pre-underwriting gates clear and the risk engine has assessed the policy — check the Risk Engine tab for anything still waiting on that."
            />
          }
          renderItem={({ item }) => (
            <Card padding="lg" style={gridColumns > 1 ? styles.card : undefined}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIdentity}>
                  <Text variant="title3" numberOfLines={1}>
                    {item.customer_name}
                  </Text>
                  <Text variant="caption" color="muted" numberOfLines={1}>
                    {item.case_number}
                  </Text>
                </View>
                <Badge
                  label={item.readiness?.status?.replace(/_/g, ' ') ?? 'Pending'}
                  tone={stepTone(item.readiness?.status)}
                  variant="soft"
                  dot
                />
              </View>

              <Divider spacingY="md" />

              <View style={styles.steps}>
                {STEPS.map((s) => {
                  const step = item.readiness?.steps?.[s.key];
                  return (
                    <View key={s.key} style={styles.stepRow}>
                      <Text variant="caption" color="muted" style={styles.stepLabel}>
                        {s.label}
                      </Text>
                      <Badge
                        label={step?.status?.replace(/_/g, ' ') ?? '—'}
                        tone={stepTone(step?.status)}
                        variant="soft"
                      />
                    </View>
                  );
                })}
              </View>
            </Card>
          )}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
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
  steps: {
    gap: spacing.sm,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepLabel: {
    flex: 1,
  },
});
