import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { statusTone, statusLabel, entityTone, entityLabel, ToneName } from '../theme/palette';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { useLeadSync } from '../sync/LeadSyncProvider';
import { fetchLeadJourney, LeadJourney as Journey } from '../api/leadJourney';
import { RootStackParamList } from '../navigation/AppNavigator';
import { formatRelativeTime } from '../notifications/types';
import LeadJourneyView from '../components/LeadJourney';
import {
  Screen,
  ScreenHeader,
  Text,
  Card,
  Badge,
  Avatar,
  ListRow,
  Divider,
  EmptyState,
  SectionHeader,
  Pressable,
} from '../components/ui';

type DetailRoute = RouteProp<RootStackParamList, 'LeadDetail'>;

/**
 * Read-only lead detail. An agent's job is to capture the lead and then track
 * it — advancing the pipeline is underwriting's and operations' decision, made
 * in the portal. This screen therefore exposes contact actions and the journey,
 * and no status controls at all.
 */
export default function LeadDetailScreen() {
  const { colors } = useTheme();
  const route = useRoute<DetailRoute>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { canSeeAllLeads } = useSession();
  const { toast } = useNotifications();
  const { leads, refresh, syncing } = useLeadSync();

  const [journey, setJourney] = useState<Journey | null>(null);
  const [journeyLoading, setJourneyLoading] = useState(true);
  const [journeyError, setJourneyError] = useState<string | null>(null);
  const [journeyExpanded, setJourneyExpanded] = useState(true);

  // Reading from the sync store rather than fetching means the screen updates
  // live when the portal changes this lead while it is open.
  const lead = useMemo(
    () => leads.find((l) => l.id === route.params.leadId) ?? null,
    [leads, route.params.leadId]
  );

  const loadJourney = useCallback(async () => {
    if (!lead) return;
    setJourneyLoading(true);
    setJourneyError(null);
    try {
      const result = await fetchLeadJourney({
        leadId: lead.id,
        type: lead.type,
        profileStatus: lead.status,
        createdAt: lead.created_at,
        groupPolicyStatus: lead.groupPolicyStatus,
      });
      setJourney(result);
    } catch (err: any) {
      setJourneyError(err?.message ?? 'Could not load the journey.');
    } finally {
      setJourneyLoading(false);
    }
    // Re-derives whenever the lead's own status changes, so a portal-side move
    // is reflected without leaving the screen.
  }, [lead?.id, lead?.status, lead?.groupPolicyStatus]);

  useEffect(() => {
    loadJourney();
  }, [loadJourney]);

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
  const hasPhone = !!lead.contact_info && !/^no (phone|contact)$/i.test(lead.contact_info);

  return (
    <Screen
      refreshing={syncing}
      onRefresh={() => {
        refresh();
        loadJourney();
      }}
      header={
        <ScreenHeader
          title={lead.name || 'Lead'}
          subtitle={entityLabel[lead.type] ?? lead.type}
          leading="back"
        />
      }
    >
      <Card padding="xl" style={styles.hero}>
        <View style={styles.heroTop}>
          <Avatar
            name={lead.name}
            tone={entityTone[lead.type] ?? 'neutral'}
            size={60}
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
            tone="brand"
            disabled={!hasPhone}
            onPress={() => dial(lead.contact_info)}
          />
          <QuickAction
            icon="chatbubble"
            label="Message"
            tone="accent"
            disabled={!hasPhone}
            onPress={() =>
              Linking.openURL(`sms:${lead.contact_info.replace(/[^\d+]/g, '')}`).catch(() =>
                toast('No messaging app available', { tone: 'warning' })
              )
            }
          />
          <QuickAction
            icon="logo-whatsapp"
            label="WhatsApp"
            tone="success"
            disabled={!hasPhone}
            onPress={() => {
              const cleanPhone = lead.contact_info.replace(/[^\d+]/g, '');
              Linking.openURL(`whatsapp://send?phone=${cleanPhone}`).catch(() =>
                Linking.openURL(`https://wa.me/${cleanPhone}`).catch(() =>
                  toast('WhatsApp not installed', { tone: 'warning' })
                )
              );
            }}
          />
        </View>
      </Card>

      <SectionHeader
        title="Journey"
        icon="git-commit-outline"
        rightIcon={journeyExpanded ? 'remove-circle-outline' : 'add-circle-outline'}
        onRightIconPress={() => setJourneyExpanded((prev) => !prev)}
      />
      {journeyExpanded ? (
        <LeadJourneyView
          journey={journey}
          loading={journeyLoading}
          error={journeyError}
          onRetry={loadJourney}
        />
      ) : null}

      <SectionHeader title="Details" icon="information-circle-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow
          title="Contact"
          value={lead.contact_info}
          icon="call-outline"
          tone="brand"
          onPress={hasPhone ? () => dial(lead.contact_info) : undefined}
        />
        {lead.city ? (
          <>
            <Divider spacingY="none" />
            <ListRow title="City" value={lead.city} icon="location-outline" tone="accent" />
          </>
        ) : null}
        {lead.primaryIdentifier ? (
          <>
            <Divider spacingY="none" />
            <ListRow
              title={lead.type === 'CORPORATE' ? 'Registration no.' : 'CNIC'}
              value={lead.primaryIdentifier}
              icon="card-outline"
              tone="neutral"
            />
          </>
        ) : null}
        {typeof lead.memberCount === 'number' && lead.type !== 'INDIVIDUAL' ? (
          <>
            <Divider spacingY="none" />
            <ListRow
              title={lead.type === 'FAMILY' ? 'Members' : 'Employees'}
              value={String(lead.memberCount)}
              icon="people-outline"
              tone="accent"
            />
          </>
        ) : null}
        <Divider spacingY="none" />
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
    </Screen>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  disabled,
  tone = 'brand',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: ToneName;
}) {
  const { colors } = useTheme();
  const t = colors.tone[tone] ?? colors.tone.brand;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      pressedScale={0.92}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={[
        styles.quickActionTile,
        {
          backgroundColor: t.solid,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={20} color={t.onSolid} />
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
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  quickActionTile: {
    width: 48,
    height: 48,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    marginBottom: spacing.xl,
  },
  scopeNote: {
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
});
