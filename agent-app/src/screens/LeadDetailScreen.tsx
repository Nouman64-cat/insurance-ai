import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { statusTone, statusLabel, entityTone, entityLabel } from '../theme/palette';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { useLeadSync } from '../sync/LeadSyncProvider';
import { updateLeadStatus, deleteLead, ProfileStatus } from '../api/leads';
import { RootStackParamList } from '../navigation/AppNavigator';
import { formatRelativeTime } from '../notifications/types';
import {
  Screen,
  ScreenHeader,
  Text,
  Card,
  Badge,
  Avatar,
  Button,
  ListRow,
  Divider,
  EmptyState,
  ConfirmDialog,
  SectionHeader,
  Pressable,
} from '../components/ui';

type DetailRoute = RouteProp<RootStackParamList, 'LeadDetail'>;

/** The pipeline, in order. Drives both the stepper and the "advance" action. */
const PIPELINE: ProfileStatus[] = ['LEAD', 'PROSPECT', 'UNDERWRITING_READY'];

export default function LeadDetailScreen() {
  const { colors } = useTheme();
  const route = useRoute<DetailRoute>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { canSeeAllLeads } = useSession();
  const { toast } = useNotifications();
  const { leads, applyLocal, removeLocal, refresh, syncing } = useLeadSync();

  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reading from the sync store rather than fetching means the screen updates
  // live when the portal changes this lead while it is open.
  const lead = useMemo(
    () => leads.find((l) => l.id === route.params.leadId) ?? null,
    [leads, route.params.leadId]
  );

  const changeStatus = useCallback(
    async (status: ProfileStatus) => {
      if (!lead) return;
      const previous = lead.status;
      setBusy(true);
      applyLocal(lead.id, { status });
      try {
        await updateLeadStatus(lead, status);
        toast(`Moved to ${statusLabel[status] ?? status}`, { tone: 'success', icon: 'checkmark-circle' });
      } catch (err: any) {
        applyLocal(lead.id, { status: previous });
        toast('Could not update the lead', {
          body: err?.message ?? 'Please try again.',
          tone: 'danger',
          icon: 'alert-circle',
        });
      } finally {
        setBusy(false);
      }
    },
    [lead, applyLocal, toast]
  );

  const handleDelete = useCallback(async () => {
    if (!lead) return;
    setBusy(true);
    try {
      await deleteLead(lead);
      removeLocal(lead.id);
      setConfirmDelete(false);
      toast(`${lead.name} deleted`, { tone: 'neutral', icon: 'trash-outline' });
      navigation.goBack();
    } catch (err: any) {
      toast('Could not delete the lead', {
        body: err?.message ?? 'Please try again.',
        tone: 'danger',
        icon: 'alert-circle',
      });
    } finally {
      setBusy(false);
    }
  }, [lead, removeLocal, toast, navigation]);

  const dial = (phone: string) => {
    Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() =>
      toast('No dialler available on this device', { tone: 'warning', icon: 'call-outline' })
    );
  };

  const mail = (address: string) => {
    Linking.openURL(`mailto:${address}`).catch(() =>
      toast('No mail app available on this device', { tone: 'warning', icon: 'mail-outline' })
    );
  };

  // A lead can vanish while its detail screen is open — deleted in the portal,
  // or reassigned out of this agent's scope.
  if (!lead) {
    return (
      <Screen header={<ScreenHeader title="Lead" leading="back" />}>
        <EmptyState
          icon="alert-circle-outline"
          title="This lead is no longer available"
          description="It may have been deleted, converted to a policyholder, or reassigned to another agent."
          actionLabel="Back to leads"
          onAction={() => navigation.goBack()}
          tone="warning"
        />
      </Screen>
    );
  }

  const tone = statusTone[lead.status] ?? 'neutral';
  const stageIndex = PIPELINE.indexOf(lead.status);
  const nextStage = stageIndex >= 0 && stageIndex < PIPELINE.length - 1 ? PIPELINE[stageIndex + 1] : null;
  const hasPhone = !!lead.contact_info && !/^no (phone|contact)$/i.test(lead.contact_info);

  return (
    <Screen
      refreshing={syncing}
      onRefresh={refresh}
      header={
        <ScreenHeader
          title={lead.name || 'Lead'}
          subtitle={entityLabel[lead.type] ?? lead.type}
          leading="back"
          actions={[
            {
              icon: 'trash-outline',
              onPress: () => setConfirmDelete(true),
              accessibilityLabel: 'Delete lead',
              tone: 'danger',
            },
          ]}
        />
      }
    >
      <Card padding="xl" style={styles.hero}>
        <View style={styles.heroTop}>
          <Avatar
            name={lead.name}
            tone={entityTone[lead.type] ?? 'neutral'}
            size={64}
            shape={lead.type === 'INDIVIDUAL' ? 'circle' : 'rounded'}
          />
          <View style={styles.heroText}>
            <Text variant="title2" numberOfLines={2}>
              {lead.name}
            </Text>
            <View style={styles.heroBadges}>
              <Badge label={statusLabel[lead.status] ?? lead.status} tone={tone} variant="soft" dot />
              <Badge
                label={entityLabel[lead.type] ?? lead.type}
                tone={entityTone[lead.type] ?? 'neutral'}
                variant="outline"
              />
            </View>
          </View>
        </View>

        <View style={styles.quickActions}>
          <QuickAction
            icon="call"
            label="Call"
            disabled={!hasPhone}
            onPress={() => dial(lead.contact_info)}
          />
          <QuickAction
            icon="chatbubble"
            label="SMS"
            disabled={!hasPhone}
            onPress={() =>
              Linking.openURL(`sms:${lead.contact_info.replace(/[^\d+]/g, '')}`).catch(() =>
                toast('No messaging app available', { tone: 'warning' })
              )
            }
          />
          <QuickAction
            icon="mail"
            label="Email"
            disabled={!lead.email}
            onPress={() => lead.email && mail(lead.email)}
          />
        </View>
      </Card>

      <SectionHeader title="Pipeline stage" icon="git-commit-outline" />
      <Card padding="lg" style={styles.section}>
        <View style={styles.stepper}>
          {PIPELINE.map((stage, index) => {
            const reached = stageIndex >= index && stageIndex !== -1;
            const stageColor = reached ? colors.tone.brand.solid : colors.borderStrong;
            return (
              <React.Fragment key={stage}>
                <View style={styles.step}>
                  <View
                    style={[
                      styles.stepDot,
                      {
                        backgroundColor: reached ? stageColor : colors.surface,
                        borderColor: stageColor,
                      },
                    ]}
                  >
                    {reached ? (
                      <Ionicons name="checkmark" size={13} color={colors.tone.brand.onSolid} />
                    ) : null}
                  </View>
                  <Text
                    variant="micro"
                    color={reached ? 'default' : 'subtle'}
                    align="center"
                    numberOfLines={2}
                    style={styles.stepLabel}
                  >
                    {statusLabel[stage] ?? stage}
                  </Text>
                </View>
                {index < PIPELINE.length - 1 ? (
                  <View
                    style={[
                      styles.stepLine,
                      { backgroundColor: stageIndex > index ? colors.tone.brand.solid : colors.border },
                    ]}
                  />
                ) : null}
              </React.Fragment>
            );
          })}
        </View>

        {lead.status === 'NOT_INTERESTED' ? (
          <Button
            title="Reactivate lead"
            onPress={() => changeStatus('LEAD')}
            variant="soft"
            tone="success"
            icon="refresh"
            fullWidth
            loading={busy}
            style={styles.stageAction}
          />
        ) : (
          <View style={styles.stageActions}>
            {nextStage ? (
              <Button
                title={`Move to ${statusLabel[nextStage] ?? nextStage}`}
                onPress={() => changeStatus(nextStage)}
                icon="arrow-forward"
                iconPosition="right"
                loading={busy}
                style={styles.stageActionItem}
              />
            ) : null}
            <Button
              title="Not interested"
              onPress={() => changeStatus('NOT_INTERESTED')}
              variant="outline"
              tone="neutral"
              disabled={busy}
              style={styles.stageActionItem}
            />
          </View>
        )}
      </Card>

      <SectionHeader title="Details" icon="information-circle-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow
          title="Contact"
          value={lead.contact_info}
          icon="call-outline"
          tone="brand"
          onPress={hasPhone ? () => dial(lead.contact_info) : undefined}
        />
        <Divider spacingY="none" />
        {lead.email ? (
          <>
            <ListRow
              title="Email"
              value={lead.email}
              icon="mail-outline"
              tone="info"
              onPress={() => mail(lead.email!)}
            />
            <Divider spacingY="none" />
          </>
        ) : null}
        {lead.city ? (
          <>
            <ListRow title="City" value={lead.city} icon="location-outline" tone="accent" />
            <Divider spacingY="none" />
          </>
        ) : null}
        {lead.primaryIdentifier ? (
          <>
            <ListRow
              title={lead.type === 'CORPORATE' ? 'Registration no.' : 'CNIC'}
              value={lead.primaryIdentifier}
              icon="card-outline"
              tone="neutral"
            />
            <Divider spacingY="none" />
          </>
        ) : null}
        {typeof lead.memberCount === 'number' && lead.type !== 'INDIVIDUAL' ? (
          <>
            <ListRow
              title={lead.type === 'FAMILY' ? 'Members' : 'Employees'}
              value={String(lead.memberCount)}
              icon="people-outline"
              tone="accent"
            />
            <Divider spacingY="none" />
          </>
        ) : null}
        <ListRow
          title="Owner"
          value={lead.assignedAgentName ?? 'Unassigned'}
          icon="person-circle-outline"
          tone={lead.assignedAgentName ? 'success' : 'warning'}
        />
        <Divider spacingY="none" />
        <ListRow
          title="Created"
          value={formatRelativeTime(new Date(lead.created_at).getTime())}
          subtitle={new Date(lead.created_at).toLocaleString()}
          icon="time-outline"
          tone="neutral"
        />
      </Card>

      {canSeeAllLeads ? (
        <Text variant="caption" color="subtle" align="center" style={styles.scopeNote}>
          You are viewing this lead with tenant-wide access.
        </Text>
      ) : null}

      <ConfirmDialog
        visible={confirmDelete}
        title={`Delete ${lead.name}?`}
        message="This removes the lead from the shared database, so it disappears from the portal too. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        icon="trash-outline"
        loading={busy}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      pressedScale={0.95}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={[
        styles.quickAction,
        {
          backgroundColor: colors.surfaceSunken,
          borderColor: colors.border,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={19} color={colors.tone.brand.solid} />
      <Text variant="captionStrong" color="muted">
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  heroText: {
    flex: 1,
  },
  heroBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  quickActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  quickAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  section: {
    marginBottom: spacing.xl,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.xl,
  },
  step: {
    alignItems: 'center',
    width: 78,
  },
  stepDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: {
    marginTop: spacing.xs,
  },
  stepLine: {
    flex: 1,
    height: 2,
    // Aligns the connector with the centre of the 26pt dots.
    marginTop: 12,
  },
  stageAction: {
    marginTop: spacing.sm,
  },
  stageActions: {
    gap: spacing.sm,
  },
  stageActionItem: {
    alignSelf: 'stretch',
  },
  scopeNote: {
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
});
