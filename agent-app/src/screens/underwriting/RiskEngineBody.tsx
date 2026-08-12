import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../theme/ThemeContext';
import { spacing, radii } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import { useResponsive } from '../../hooks/useResponsive';
import { useNotifications } from '../../notifications/NotificationContext';
import { fetchAssessments, AssessmentItem } from '../../api/underwriting';
import { fetchAwaitingRiskAssessment, PreUnderwritingCase } from '../../api/preUnderwriting';
import { formatRelativeTime } from '../../notifications/types';
import {
  Text,
  Card,
  Badge,
  Banner,
  ProgressBar,
  EmptyState,
  SkeletonList,
  Divider,
  Pressable,
  SegmentedControl,
} from '../../components/ui';

type Filter = 'ALL' | 'AUTO_APPROVE' | 'HUMAN_REVIEW';

const DECISION_META: Record<string, { tone: ToneName; label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  AUTO_APPROVE: { tone: 'success', label: 'Auto-approve', icon: 'checkmark-circle' },
  HUMAN_REVIEW: { tone: 'warning', label: 'Human review', icon: 'eye' },
  AUTO_DECLINE: { tone: 'danger', label: 'Auto-decline', icon: 'close-circle' },
  REFER: { tone: 'accent', label: 'Referred', icon: 'git-branch' },
};

const decisionMeta = (decision: string) =>
  DECISION_META[(decision ?? '').toUpperCase()] ?? {
    tone: 'neutral' as ToneName,
    label: decision || 'Pending',
    icon: 'help-circle' as keyof typeof Ionicons.glyphMap,
  };

/** Lower composite risk is better, so the tone scale runs the opposite way. */
const riskTone = (score: number): ToneName => {
  if (score <= 30) return 'success';
  if (score <= 60) return 'warning';
  return 'danger';
};

export interface RiskEngineBodyHandle {
  subtitle: string;
}

/**
 * Risk Engine stage — read-only AI risk assessment results. Agents cannot
 * override scores or approve/decline; that sits with underwriting.
 */
export default function RiskEngineBody({ onSubtitle }: { onSubtitle?: (s: string) => void }) {
  const { colors } = useTheme();
  const { gutter, isCompact, columns } = useResponsive();
  const { toast } = useNotifications();

  const [assessments, setAssessments] = useState<AssessmentItem[]>([]);
  const [pending, setPending] = useState<PreUnderwritingCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setRefreshing(true);
    try {
      // A case that's cleared all 6 Pre-Underwriting gates but hasn't been
      // risk-assessed yet is meant to show up here — waiting, not missing —
      // otherwise this tab looks empty for every case until underwriting
      // gets to it, which reads as broken rather than "not yet actioned".
      const [assessed, awaiting] = await Promise.all([fetchAssessments(), fetchAwaitingRiskAssessment()]);
      setAssessments(assessed);
      // A case stops being "awaiting" the moment it has an assessment —
      // exclude by case_id in case the two lists raced a status change.
      const assessedCaseIds = new Set(assessed.map((a) => a.case_id));
      setPending(awaiting.filter((c) => !assessedCaseIds.has(c.id)));
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load assessments.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load({ silent: true });
  }, [load]);

  // A risk assessment can land while the agent stays on this exact screen —
  // poll while focused, same as Pre-Underwriting, rather than only
  // refreshing on in-app navigation.
  useFocusEffect(
    useCallback(() => {
      load({ silent: true });
      const timer = setInterval(() => load({ silent: true }), 15_000);
      return () => clearInterval(timer);
    }, [load])
  );

  useEffect(() => {
    if (loading) {
      onSubtitle?.('Loading…');
      return;
    }
    const parts = [`${assessments.length} ${assessments.length === 1 ? 'assessment' : 'assessments'}`];
    if (pending.length > 0) parts.push(`${pending.length} awaiting`);
    onSubtitle?.(parts.join(' · '));
  }, [loading, assessments.length, pending.length, onSubtitle]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = { ALL: assessments.length };
    for (const a of assessments) {
      const key = (a.ai_decision ?? '').toUpperCase();
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, [assessments]);

  const filtered = useMemo(
    () =>
      filter === 'ALL'
        ? assessments
        : assessments.filter((a) => (a.ai_decision ?? '').toUpperCase() === filter),
    [assessments, filter]
  );

  /**
   * Agents cannot approve, decline, or override a score — those decisions sit
   * with an underwriter. Explaining that is more useful than hiding the button.
   */
  const explainRestriction = (action: string) =>
    toast('Underwriter authorisation required', {
      body: `${action} is restricted to underwriters and managers.`,
      tone: 'warning',
      icon: 'lock-closed',
    });

  const gridColumns = isCompact ? 1 : columns(340);

  return (
    <>
      <View style={{ paddingHorizontal: gutter }}>
        <SegmentedControl<Filter>
          segments={[
            { value: 'ALL', label: 'All', count: counts.ALL ?? 0 },
            { value: 'HUMAN_REVIEW', label: 'Review', count: counts.HUMAN_REVIEW ?? 0 },
            { value: 'AUTO_APPROVE', label: 'Approved', count: counts.AUTO_APPROVE ?? 0 },
          ]}
          value={filter}
          onChange={setFilter}
          variant="chips"
          style={styles.filterControl}
        />

        <Banner
          tone="warning"
          title="Read-only view"
          description="Score overrides and approve/decline decisions require underwriter authorisation."
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
          key={`uw-${gridColumns}`}
          data={filtered}
          keyExtractor={(item) => item.id}
          numColumns={gridColumns}
          columnWrapperStyle={gridColumns > 1 ? styles.column : undefined}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: gutter },
            filtered.length === 0 && pending.length === 0 ? styles.listEmpty : null,
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
          ListHeaderComponent={
            pending.length > 0 ? (
              <View style={styles.pendingSection}>
                <Text variant="overline" color="subtle" uppercase style={styles.pendingTitle}>
                  Awaiting Risk Assessment ({pending.length})
                </Text>
                {pending.map((c) => (
                  <View
                    key={c.id}
                    style={[styles.pendingRow, { backgroundColor: colors.surfaceSunken, borderColor: colors.border }]}
                  >
                    <View style={styles.pendingIdentity}>
                      <Text variant="calloutStrong" numberOfLines={1}>
                        {c.customer_name}
                      </Text>
                      <Text variant="caption" color="muted" numberOfLines={1}>
                        {c.case_number}
                      </Text>
                    </View>
                    <Badge label="Pending" tone="neutral" variant="soft" icon="time-outline" />
                  </View>
                ))}
                {filtered.length > 0 ? <Divider spacingY="md" /> : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            pending.length > 0 ? null : (
              <EmptyState
                icon="shield-checkmark-outline"
                title={filter === 'ALL' ? 'No assessments yet' : 'Nothing in this bucket'}
                description={
                  filter === 'ALL'
                    ? 'Risk assessments appear here once a case reaches underwriting.'
                    : 'Try a different filter to see the other assessments.'
                }
                actionLabel={filter === 'ALL' ? undefined : 'Show all'}
                onAction={filter === 'ALL' ? undefined : () => setFilter('ALL')}
              />
            )
          }
          renderItem={({ item }) => {
            const decision = decisionMeta(item.ai_decision);
            const composite = Number(item.composite_risk_score) || 0;
            const compositeTone = riskTone(composite);
            const fraudPercent = Math.round((Number(item.fraud_probability) || 0) * 100);

            return (
              <Card padding="lg" style={gridColumns > 1 ? styles.card : undefined}>
                <View style={styles.cardHeader}>
                  <View style={styles.cardIdentity}>
                    <Text variant="title3" numberOfLines={1}>
                      {item.customer_name}
                    </Text>
                    <Text variant="caption" color="muted" numberOfLines={1}>
                      {item.case_id} · {formatRelativeTime(new Date(item.created_at).getTime())}
                    </Text>
                  </View>
                  <Badge label={decision.label} tone={decision.tone} variant="soft" icon={decision.icon} />
                </View>

                <Divider spacingY="md" />

                <View
                  style={[
                    styles.composite,
                    {
                      backgroundColor: colors.tone[compositeTone].soft,
                      borderColor: colors.tone[compositeTone].softBorder,
                    },
                  ]}
                >
                  <View style={styles.compositeText}>
                    <Text variant="overline" uppercase style={{ color: colors.tone[compositeTone].on }}>
                      Composite risk
                    </Text>
                    <Text style={[styles.compositeValue, { color: colors.tone[compositeTone].on }]}>
                      {composite}
                      <Text variant="caption" style={{ color: colors.tone[compositeTone].on }}>
                        {' '}
                        / 100
                      </Text>
                    </Text>
                  </View>
                  <Ionicons
                    name={composite <= 30 ? 'trending-down' : 'trending-up'}
                    size={22}
                    color={colors.tone[compositeTone].solid}
                  />
                </View>

                <View style={styles.scores}>
                  <ProgressBar
                    value={(Number(item.medical_score) || 0) / 100}
                    label={`Medical · ${item.medical_score}/100`}
                    tone={riskTone(100 - (Number(item.medical_score) || 0))}
                    height={6}
                    style={styles.score}
                  />
                  <ProgressBar
                    value={(Number(item.financial_score) || 0) / 100}
                    label={`Financial · ${item.financial_score}/100`}
                    tone={riskTone(100 - (Number(item.financial_score) || 0))}
                    height={6}
                    style={styles.score}
                  />
                  <ProgressBar
                    value={fraudPercent / 100}
                    label={`Fraud probability · ${fraudPercent}%`}
                    tone={riskTone(fraudPercent)}
                    height={6}
                    style={styles.score}
                  />
                </View>

                {item.reasons?.length ? (
                  <View style={styles.reasons}>
                    <Text variant="overline" color="subtle" uppercase style={styles.reasonsTitle}>
                      Key factors
                    </Text>
                    {item.reasons.slice(0, 3).map((reason, index) => (
                      <View key={index} style={styles.reason}>
                        <Ionicons name="ellipse" size={5} color={colors.textSubtle} style={styles.bullet} />
                        <Text variant="caption" color="muted" style={styles.reasonText}>
                          {reason}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                <View style={styles.actions}>
                  {['Overriding scores', 'Approving or declining'].map((action, index) => (
                    <Pressable
                      key={action}
                      onPress={() => explainRestriction(action)}
                      pressedScale={0.97}
                      accessibilityRole="button"
                      accessibilityLabel={`${action} — restricted`}
                      style={[
                        styles.action,
                        { backgroundColor: colors.surfaceSunken, borderColor: colors.border },
                      ]}
                    >
                      <Ionicons name="lock-closed-outline" size={14} color={colors.textSubtle} />
                      <Text variant="captionStrong" color="subtle" numberOfLines={1}>
                        {index === 0 ? 'Override scores' : 'Make decision'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Card>
            );
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  filterControl: {
    marginTop: spacing.md,
  },
  pendingSection: {
    marginBottom: spacing.sm,
  },
  pendingTitle: {
    marginBottom: spacing.sm,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.sm,
  },
  pendingIdentity: {
    flex: 1,
  },
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
  composite: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  compositeText: {
    flex: 1,
  },
  compositeValue: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    marginTop: spacing.xxs,
  },
  scores: {
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  score: {
    width: '100%',
  },
  reasons: {
    marginTop: spacing.lg,
  },
  reasonsTitle: {
    marginBottom: spacing.sm,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  bullet: {
    marginTop: 6,
  },
  reasonText: {
    flex: 1,
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
    borderRadius: radii.md,
    borderWidth: 1,
  },
});
