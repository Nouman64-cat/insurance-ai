import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../theme/ThemeContext';
import { spacing, radii } from '../../theme/tokens';
import { ToneName } from '../../theme/palette';
import { useResponsive } from '../../hooks/useResponsive';
import { useNotifications } from '../../notifications/NotificationContext';
import {
  fetchPreUnderwritingCases,
  isGateDone,
  isPreUnderwritingComplete,
  assessMedicalExam,
  inviteMedicalExam,
  PreUnderwritingCase,
} from '../../api/preUnderwriting';
import { inviteEApplication, buildEApplicationLink } from '../../api/eApplication';
import { RootStackParamList } from '../../navigation/AppNavigator';
import {
  Text,
  Card,
  Badge,
  Banner,
  EmptyState,
  SkeletonList,
  Divider,
  Pressable,
  LinkShareSheet,
} from '../../components/ui';

type GateField =
  | 'e_application_status'
  | 'acr_status'
  | 'compliance_status'
  | 'ipp_status'
  | 'insurance_history_status'
  | 'medical_exam_status';

const GATES: Array<{ field: GateField; label: string; actionLabel: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { field: 'e_application_status', label: 'Gate 1 · E-Application', actionLabel: 'Send E-Application Link', icon: 'link-outline' },
  { field: 'acr_status', label: 'Gate 2 · ACR', actionLabel: 'File Confidential Report', icon: 'document-text-outline' },
  { field: 'compliance_status', label: 'Gate 3 · Compliance', actionLabel: 'Run Compliance Screening', icon: 'shield-checkmark-outline' },
  { field: 'ipp_status', label: 'Gate 4 · Premium', actionLabel: 'Collect Initial Premium', icon: 'cash-outline' },
  { field: 'insurance_history_status', label: 'Gate 5 · History', actionLabel: 'Run Insurance History Check', icon: 'time-outline' },
  { field: 'medical_exam_status', label: 'Gate 6 · Medical', actionLabel: 'Assess & Invite Medical Exam', icon: 'medkit-outline' },
];

/** The only 3 of the 6 gates an Agent can act on from the app — Compliance,
 * Premium and Insurance History are underwriting-only and show read-only
 * here, same as the portal restricts them behind an Underwriter/Admin role. */
const AGENT_ACTIONABLE_GATES = new Set<GateField>(['e_application_status', 'acr_status', 'medical_exam_status']);

/** Untouched vs blocked vs in-progress vs done vs not-yet-reachable — mirrors
 * the portal's Pre-Underwriting timeline: gate N+1 is genuinely locked until
 * gate N is done (`g2Unlocked = g1Done`, etc.), and a case sitting at
 * "Submitted" or "Flagged" is a different state from "never started". */
type GateVisualState = 'done' | 'attention' | 'blocked' | 'pending' | 'locked';

const UNTOUCHED_STATUS = new Set(['NotSent', 'NotStarted', 'NotAssessed']);

const gateState = (field: GateField, status: string, locked: boolean): GateVisualState => {
  if (locked) return 'locked';
  if (isGateDone(field, status)) return 'done';
  if (status === 'Failed') return 'blocked';
  return UNTOUCHED_STATUS.has(status) ? 'pending' : 'attention';
};

const GATE_STATE_META: Record<GateVisualState, { tone: ToneName; icon: keyof typeof Ionicons.glyphMap }> = {
  done: { tone: 'success', icon: 'checkmark-circle' },
  attention: { tone: 'warning', icon: 'alert-circle' },
  blocked: { tone: 'danger', icon: 'close-circle' },
  pending: { tone: 'neutral', icon: 'ellipse-outline' },
  locked: { tone: 'neutral', icon: 'lock-closed-outline' },
};

/**
 * Pre-Underwriting stage. An Agent only runs Gates 1, 2 and 6 (E-Application,
 * ACR, Medical) — Compliance, Premium and Insurance History are underwriting
 * actions and render read-only here. Gate N+1 stays locked until gate N
 * clears, exactly matching the portal's own timeline
 * (frontend/app/underwriting/page.tsx).
 */
export default function PreUnderwritingBody({ onSubtitle }: { onSubtitle?: (s: string) => void }) {
  const { colors } = useTheme();
  const { gutter, isCompact, columns } = useResponsive();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { toast } = useNotifications();

  const [cases, setCases] = useState<PreUnderwritingCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyCaseId, setBusyCaseId] = useState<string | null>(null);
  const [linkResult, setLinkResult] = useState<{ title: string; subtitle: string; url: string } | null>(null);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setRefreshing(true);
    try {
      const data = await fetchPreUnderwritingCases();
      setCases(data.filter((c) => !isPreUnderwritingComplete(c)));
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load cases.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load({ silent: true });
  }, [load]);

  // A customer can submit their e-application (or any other gate can clear)
  // minutes after the agent sent the link, while they're still sitting on
  // this exact screen — a focus-only refresh wouldn't catch that, since
  // nothing about in-app navigation changed. Polling while focused, and
  // stopping the moment focus is lost, keeps the queue live without a
  // background timer running once the agent has moved on.
  useFocusEffect(
    useCallback(() => {
      load({ silent: true });
      const timer = setInterval(() => load({ silent: true }), 15_000);
      return () => clearInterval(timer);
    }, [load])
  );

  useEffect(() => {
    onSubtitle?.(loading ? 'Loading…' : `${cases.length} in progress`);
  }, [loading, cases.length, onSubtitle]);

  const runGate = useCallback(
    async (item: PreUnderwritingCase, field: GateField) => {
      // Compliance, Premium and Insurance History are underwriting-only —
      // nothing in the UI offers a way to reach this for those fields, but
      // guard it anyway rather than silently running an action the agent
      // isn't supposed to have.
      if (!AGENT_ACTIONABLE_GATES.has(field)) {
        toast('Handled by underwriting', {
          body: 'This gate is actioned from the portal, not the agent app.',
          tone: 'neutral',
          icon: 'lock-closed-outline',
        });
        return;
      }

      if (field === 'acr_status') {
        // The native ACR screen already renders correctly for every state —
        // a blank form, an editable draft, or a locked read-only view — so
        // it's always the right destination regardless of current status.
        navigation.navigate('AgentConfidentialReport', {
          caseId: item.id,
          applicantName: item.customer_name,
        });
        return;
      }

      // The customer has already submitted (or the report is already
      // verified) — the next step is reading it, not sending another invite.
      if (field === 'e_application_status' && (item.e_application_status === 'Submitted' || item.e_application_status === 'Verified')) {
        navigation.navigate('ReviewEApplication', {
          caseId: item.id,
          applicantName: item.customer_name,
        });
        return;
      }

      setBusyCaseId(item.id);
      try {
        if (field === 'e_application_status') {
          const invite = await inviteEApplication(item.id);
          const link = buildEApplicationLink(invite.link_path);
          setLinkResult({
            title: 'E-Application link ready',
            subtitle: `For ${item.customer_name}`,
            url: link,
          });
        } else if (field === 'medical_exam_status') {
          // The non-medical-limit assessment has to run before an invite can
          // be sent — inviting straight away 409s on the backend.
          let status = item.medical_exam_status;
          if (status === 'NotAssessed') {
            const assessed = await assessMedicalExam(item.id);
            status = assessed.status;
          }
          if (status === 'NotRequired') {
            toast('No medical exam required', {
              body: 'This case is within the non-medical limit.',
              tone: 'success',
              icon: 'checkmark-circle',
            });
          } else {
            const invite = await inviteMedicalExam(item.id);
            const link = buildEApplicationLink(invite.link_path);
            setLinkResult({
              title: 'Medical exam link ready',
              subtitle: `For ${item.customer_name}`,
              url: link,
            });
          }
        }
        await load({ silent: true });
      } catch (err: any) {
        toast('Could not complete this step', {
          body: err?.message ?? 'Please try again.',
          tone: 'danger',
          icon: 'alert-circle',
        });
      } finally {
        setBusyCaseId(null);
      }
    },
    [load, navigation, toast]
  );

  /** The action changes with the gate's current sub-status — the static
   * GATES table only names the default, first-time action. Mirrors the
   * portal's own per-gate button copy (e.g. "Continue ACR →" for a saved
   * draft). Only called for the 3 agent-actionable gates — Compliance, IPP
   * and Insurance History render as a read-only notice instead, see below. */
  const actionFor = (item: PreUnderwritingCase, gate: (typeof GATES)[number]) => {
    const status = item[gate.field];
    switch (gate.field) {
      case 'e_application_status':
        if (status === 'Verified') return { label: 'View Form', icon: 'eye-outline' as const };
        if (status === 'Submitted') return { label: 'Review Submission', icon: 'eye-outline' as const };
        return { label: status !== 'NotSent' ? 'Resend E-Application Link' : gate.actionLabel, icon: gate.icon };
      case 'acr_status':
        return {
          label: status === 'Submitted' ? 'View ACR' : status === 'Draft' ? 'Continue Confidential Report' : gate.actionLabel,
          icon: gate.icon,
        };
      case 'medical_exam_status':
        if (status === 'Required') return { label: 'Invite for Medical Exam', icon: 'medkit-outline' as const };
        if (status === 'Invited' || status === 'Scheduled') {
          return { label: 'Resend Booking Link', icon: 'link-outline' as const };
        }
        if (isGateDone(gate.field, status)) return { label: 'Re-Apply NML Grid', icon: 'medkit-outline' as const };
        return { label: gate.actionLabel, icon: gate.icon };
      default:
        return { label: gate.actionLabel, icon: gate.icon };
    }
  };

  const gridColumns = isCompact ? 1 : columns(360);

  return (
    <>
      <View style={{ paddingHorizontal: gutter }}>
        <Banner
          tone="success"
          title="Your gates: 1, 2 and 6"
          description="E-Application, ACR and Medical are yours to run. Compliance, Premium and Insurance History are handled by underwriting — shown here read-only."
          icon="checkmark-done-circle-outline"
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
          key={`preuw-${gridColumns}`}
          data={cases}
          keyExtractor={(item) => item.id}
          numColumns={gridColumns}
          columnWrapperStyle={gridColumns > 1 ? styles.column : undefined}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: gutter },
            cases.length === 0 ? styles.listEmpty : null,
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
              icon="checkmark-done-outline"
              title="Nothing in progress"
              description="Cases appear here while they move through the 6 pre-underwriting gates."
            />
          }
          renderItem={({ item }) => {
            const nextGateIndex = GATES.findIndex((g) => !isGateDone(g.field, item[g.field]));
            const nextGate = nextGateIndex === -1 ? undefined : GATES[nextGateIndex];
            const action = nextGate ? actionFor(item, nextGate) : null;
            const busy = busyCaseId === item.id;
            return (
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
                </View>

                <Divider spacingY="md" />

                <View style={styles.gates}>
                  {GATES.map((g, idx) => {
                    // A gate past the first incomplete one hasn't been
                    // reached yet — its raw status (usually "NotStarted")
                    // isn't meaningful, so show it as locked rather than
                    // pending, matching the portal's sequential unlock model.
                    const locked = nextGateIndex !== -1 && idx > nextGateIndex;
                    const meta = GATE_STATE_META[gateState(g.field, item[g.field], locked)];
                    return (
                      <Badge
                        key={g.field}
                        label={g.label.replace(/^Gate \d · /, '')}
                        tone={meta.tone}
                        variant="soft"
                        icon={meta.icon}
                        style={styles.gateBadge}
                      />
                    );
                  })}
                </View>

                {nextGate && action && AGENT_ACTIONABLE_GATES.has(nextGate.field) ? (
                  <Pressable
                    onPress={() => runGate(item, nextGate.field)}
                    disabled={busy}
                    pressedScale={0.97}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    accessibilityState={{ disabled: busy, busy }}
                    style={[
                      styles.action,
                      { backgroundColor: colors.tone.brand.solid },
                      busy ? styles.actionBusy : null,
                    ]}
                  >
                    <Ionicons
                      name={busy ? 'hourglass-outline' : action.icon}
                      size={16}
                      color={colors.tone.brand.onSolid}
                    />
                    <Text variant="captionStrong" numberOfLines={1} style={{ color: colors.tone.brand.onSolid }}>
                      {busy ? 'Working…' : action.label}
                    </Text>
                  </Pressable>
                ) : nextGate ? (
                  <View style={[styles.readOnlyNotice, { backgroundColor: colors.surfaceSunken, borderColor: colors.border }]}>
                    <Ionicons name="lock-closed-outline" size={15} color={colors.textMuted} />
                    <Text variant="caption" color="muted" style={styles.readOnlyText}>
                      {nextGate.label.replace(/^Gate \d · /, '')} is run by underwriting from the portal — check back once it clears.
                    </Text>
                  </View>
                ) : null}
              </Card>
            );
          }}
        />
      )}

      <LinkShareSheet
        visible={!!linkResult}
        onClose={() => setLinkResult(null)}
        title={linkResult?.title ?? ''}
        subtitle={linkResult?.subtitle}
        url={linkResult?.url ?? ''}
        onCopied={() => toast('Link copied', { tone: 'success', icon: 'copy-outline' })}
      />
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
  gates: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  gateBadge: {
    marginBottom: spacing.xxs,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    marginTop: spacing.lg,
  },
  actionBusy: {
    opacity: 0.7,
  },
  readOnlyNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.lg,
  },
  readOnlyText: {
    flex: 1,
  },
});
