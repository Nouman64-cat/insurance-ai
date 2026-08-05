import React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { ToneName } from '../theme/palette';
import {
  LeadJourney as Journey,
  JourneyStage,
  JourneyStageKey,
  StageState,
} from '../api/leadJourney';
import { Text, Card, Badge, Banner, Divider } from './ui';

export interface LeadJourneyProps {
  journey: Journey | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/**
 * Read-only lifecycle timeline. Agents track a lead's progress here but cannot
 * advance it — stage changes are driven by underwriting and operations in the
 * portal, and this view deliberately exposes no controls.
 */

const STAGE_ICON: Record<JourneyStageKey, keyof typeof Ionicons.glyphMap> = {
  LEAD: 'person-add-outline',
  PROPOSAL: 'document-text-outline',
  UNDERWRITING: 'shield-checkmark-outline',
  ISSUANCE: 'ribbon-outline',
};

const STATE_TONE: Record<StageState, ToneName> = {
  complete: 'success',
  current: 'brand',
  pending: 'neutral',
  blocked: 'neutral',
};

const formatMoney = (amount: number): string => {
  if (!Number.isFinite(amount) || amount <= 0) return '—';
  if (amount >= 10_000_000) return `${(amount / 10_000_000).toFixed(2)} Cr`;
  if (amount >= 100_000) return `${(amount / 100_000).toFixed(2)} Lac`;
  return amount.toLocaleString();
};

export default function LeadJourney({ journey, loading, error, onRetry }: LeadJourneyProps) {
  const { colors } = useTheme();

  if (loading) {
    return (
      <Card padding="xl" style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
        <Text variant="caption" color="muted" style={styles.centeredText}>
          Loading the lead's journey…
        </Text>
      </Card>
    );
  }

  if (error) {
    return (
      <Banner
        tone="warning"
        title="Could not load the journey"
        description={error}
        actionLabel={onRetry ? 'Retry' : undefined}
        onAction={onRetry}
      />
    );
  }

  if (!journey) return null;

  return (
    <>
      {journey.isBlocked && journey.blockedReason ? (
        <Banner
          tone="danger"
          title="This journey has stopped"
          description={journey.blockedReason}
          icon="close-circle-outline"
          style={styles.blockedBanner}
        />
      ) : null}

      <Card padding="lg" style={styles.timeline}>
        {journey.stages.map((stage, index) => (
          <StageRow
            key={stage.key}
            stage={stage}
            isLast={index === journey.stages.length - 1}
          />
        ))}
      </Card>

      {journey.policies.length > 0 ? (
        <Card padding="lg" style={styles.policies}>
          <Text variant="overline" color="subtle" uppercase style={styles.policiesTitle}>
            {journey.policies.length === 1 ? 'Policy' : 'Policies'}
          </Text>

          {journey.policies.map((policy, index) => (
            <View key={policy.id}>
              {index > 0 ? <Divider spacingY="md" /> : null}
              <View style={styles.policyHeader}>
                <View style={styles.policyIdentity}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {policy.productName}
                  </Text>
                  {policy.policyNumber ? (
                    <Text variant="caption" color="muted" numberOfLines={1}>
                      {policy.policyNumber}
                    </Text>
                  ) : null}
                </View>
                <Badge label={policy.status} tone="neutral" variant="soft" />
              </View>

              <View style={styles.policyFacts}>
                <Fact label="Coverage" value={`PKR ${formatMoney(policy.coverageAmount)}`} />
                {policy.termYears > 0 ? <Fact label="Term" value={`${policy.termYears} yrs`} /> : null}
                {policy.caseNumber ? <Fact label="Case" value={policy.caseNumber} /> : null}
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      <View style={[styles.readOnly, { backgroundColor: colors.surfaceSunken }]}>
        <Ionicons name="lock-closed-outline" size={14} color={colors.textSubtle} />
        <Text variant="caption" color="subtle" style={styles.readOnlyText}>
          Stages are advanced by underwriting and operations. You will be notified here whenever
          this lead moves.
        </Text>
      </View>
    </>
  );
}

function StageRow({ stage, isLast }: { stage: JourneyStage; isLast: boolean }) {
  const { colors } = useTheme();
  const tone = colors.tone[STATE_TONE[stage.state]];

  const isDone = stage.state === 'complete';
  const isCurrent = stage.state === 'current';
  const isMuted = stage.state === 'pending' || stage.state === 'blocked';

  return (
    <View style={styles.stageRow}>
      {/* Rail: marker plus the connector down to the next stage. */}
      <View style={styles.rail}>
        <View
          style={[
            styles.marker,
            {
              backgroundColor: isDone ? tone.solid : isCurrent ? tone.soft : 'transparent',
              borderColor: isMuted ? colors.borderStrong : tone.solid,
            },
          ]}
        >
          {isDone ? (
            <Ionicons name="checkmark" size={14} color={tone.onSolid} />
          ) : (
            <Ionicons
              name={STAGE_ICON[stage.key]}
              size={13}
              color={isMuted ? colors.textSubtle : tone.on}
            />
          )}
        </View>

        {!isLast ? (
          <View
            style={[
              styles.connector,
              { backgroundColor: isDone ? colors.tone.success.solid : colors.border },
            ]}
          />
        ) : null}
      </View>

      <View style={[styles.stageBody, isLast ? styles.stageBodyLast : null]}>
        <View style={styles.stageTitleRow}>
          <Text
            variant={isCurrent ? 'title3' : 'bodyStrong'}
            color={isMuted ? 'subtle' : 'default'}
            numberOfLines={1}
            style={styles.stageTitle}
          >
            {stage.title}
          </Text>
          {isCurrent ? <Badge label="Current" tone="brand" variant="solid" /> : null}
        </View>

        <Text variant="caption" color={isMuted ? 'subtle' : 'muted'} style={styles.stageDescription}>
          {stage.description}
        </Text>

        {stage.statusLabel || stage.at ? (
          <View style={styles.stageMeta}>
            {stage.statusLabel ? (
              <Badge
                label={stage.statusLabel}
                tone={STATE_TONE[stage.state]}
                variant="soft"
              />
            ) : null}
            {stage.at ? (
              <Text variant="micro" color="subtle">
                {new Date(stage.at).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text variant="micro" color="subtle" uppercase>
        {label}
      </Text>
      <Text variant="calloutStrong" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    gap: spacing.md,
  },
  centeredText: {
    marginTop: spacing.xs,
  },
  blockedBanner: {
    marginBottom: spacing.md,
  },
  timeline: {
    marginBottom: spacing.md,
  },
  stageRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  rail: {
    alignItems: 'center',
    width: 30,
  },
  marker: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connector: {
    width: 2,
    flex: 1,
    marginVertical: spacing.xs,
    // Guarantees a visible connector even when the body text is very short.
    minHeight: spacing.lg,
  },
  stageBody: {
    flex: 1,
    paddingBottom: spacing.xl,
  },
  stageBodyLast: {
    paddingBottom: 0,
  },
  stageTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // Aligns the title with the centre of its 30pt marker.
    minHeight: 30,
  },
  stageTitle: {
    flexShrink: 1,
  },
  stageDescription: {
    marginTop: spacing.xxs,
  },
  stageMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  policies: {
    marginBottom: spacing.md,
  },
  policiesTitle: {
    marginBottom: spacing.md,
  },
  policyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  policyIdentity: {
    flex: 1,
  },
  policyFacts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  fact: {
    flexGrow: 1,
    minWidth: 92,
    gap: spacing.xxs,
  },
  readOnly: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    marginBottom: spacing.xl,
  },
  readOnlyText: {
    flex: 1,
  },
});
