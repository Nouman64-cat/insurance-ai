import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { ToneName } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { useNotifications } from '../notifications/NotificationContext';
import { fetchPolicies, PolicyItem } from '../api/policies';
import {
  Screen,
  ScreenHeader,
  Text,
  Card,
  Badge,
  Banner,
  Avatar,
  EmptyState,
  SkeletonList,
  Divider,
  Pressable,
} from '../components/ui';

const STATUS_TONE: Record<string, ToneName> = {
  ACTIVE: 'success',
  ISSUED: 'success',
  APPROVED: 'brand',
  PENDING_PAYMENT: 'warning',
  PENDING: 'warning',
  LAPSED: 'danger',
  CANCELLED: 'danger',
};

export interface RestrictedAction {
  label: string;
  /** Used in the explanation toast, e.g. "Binding a policy". */
  gerund: string;
  icon: keyof typeof Ionicons.glyphMap;
}

export interface PolicyStageScreenProps {
  stage: 'PRE_ISSUANCE' | 'POST_ISSUANCE';
  title: string;
  subtitle: string;
  /** Explains what an agent may not do at this stage. */
  restrictionNote: string;
  actions: RestrictedAction[];
  emptyTitle: string;
  emptyDescription: string;
}

/**
 * Shared implementation behind the pre- and post-issuance screens. The two
 * differ only in which policies they show, which fields they surface, and which
 * actions are gated — so they share one component rather than one copy each.
 */
export default function PolicyStageScreen({
  stage,
  title,
  subtitle,
  restrictionNote,
  actions,
  emptyTitle,
  emptyDescription,
}: PolicyStageScreenProps) {
  const { colors } = useTheme();
  const { gutter, isCompact, columns } = useResponsive();
  const { toast } = useNotifications();

  const [policies, setPolicies] = useState<PolicyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setRefreshing(true);
      try {
        const data = await fetchPolicies();
        setPolicies(data.filter((p) => p.stage === stage));
        setError(null);
      } catch (err: any) {
        setError(err?.message ?? 'Could not load policies.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [stage]
  );

  useEffect(() => {
    load({ silent: true });
  }, [load]);

  const explainRestriction = (action: RestrictedAction) =>
    toast('Manager authorisation required', {
      body: `${action.gerund} is restricted to managers and underwriters.`,
      tone: 'warning',
      icon: 'lock-closed',
    });

  const isPre = stage === 'PRE_ISSUANCE';
  const gridColumns = isCompact ? 1 : columns(340);

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader
          title={title}
          subtitle={loading ? 'Loading…' : `${policies.length} ${policies.length === 1 ? 'policy' : 'policies'} · ${subtitle}`}
          leading="back"
        />
      }
    >
      <View style={{ paddingHorizontal: gutter }}>
        <Banner
          tone="warning"
          title="Read-only view"
          description={restrictionNote}
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
          key={`policies-${gridColumns}`}
          data={policies}
          keyExtractor={(item) => item.id}
          numColumns={gridColumns}
          columnWrapperStyle={gridColumns > 1 ? styles.column : undefined}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: gutter },
            policies.length === 0 ? styles.listEmpty : null,
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
              icon={isPre ? 'clipboard-outline' : 'ribbon-outline'}
              title={emptyTitle}
              description={emptyDescription}
            />
          }
          renderItem={({ item }) => {
            const tone = STATUS_TONE[(item.status ?? '').toUpperCase()] ?? 'neutral';
            return (
              <Card padding="lg" style={gridColumns > 1 ? styles.card : undefined}>
                <View style={styles.cardHeader}>
                  <Avatar name={item.customer_name} tone={tone} size={42} shape="rounded" />
                  <View style={styles.cardIdentity}>
                    <Text variant="title3" numberOfLines={1}>
                      {isPre ? item.customer_name : item.policy_number ?? item.customer_name}
                    </Text>
                    <Text variant="caption" color="muted" numberOfLines={1}>
                      {isPre ? item.product_name : item.customer_name}
                    </Text>
                  </View>
                  <Badge label={item.status.replace(/_/g, ' ')} tone={tone} variant="soft" dot />
                </View>

                <Divider spacingY="md" />

                {isPre ? (
                  <View style={styles.details}>
                    <Detail label="Coverage" value={`PKR ${item.coverage_amount.toLocaleString()}`} />
                    <Detail
                      label="Annual premium"
                      value={`PKR ${(item.premium_amount ?? 0).toLocaleString()}`}
                    />
                  </View>
                ) : (
                  <View style={styles.details}>
                    <Detail label="Product" value={item.product_name} />
                    <Detail label="Effective" value={item.effective_date ?? '—'} />
                    <Detail label="Expires" value={item.expiry_date ?? '—'} />
                  </View>
                )}

                <View style={styles.actions}>
                  {actions.map((action) => (
                    <Pressable
                      key={action.label}
                      onPress={() => explainRestriction(action)}
                      pressedScale={0.97}
                      accessibilityRole="button"
                      accessibilityLabel={`${action.label} — restricted`}
                      style={[
                        styles.action,
                        { backgroundColor: colors.surfaceSunken, borderColor: colors.border },
                      ]}
                    >
                      <Ionicons name="lock-closed-outline" size={14} color={colors.textSubtle} />
                      <Text variant="captionStrong" color="subtle" numberOfLines={1}>
                        {action.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Card>
            );
          }}
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
    alignItems: 'center',
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
    minWidth: 110,
    gap: spacing.xxs,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
  },
});
