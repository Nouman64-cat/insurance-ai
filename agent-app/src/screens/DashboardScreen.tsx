import React, { useMemo } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { statusLabel, entityTone, ToneName } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { useLeadSync } from '../sync/LeadSyncProvider';
import { UnifiedLead } from '../api/leads';
import LeadCard from '../components/LeadCard';
import {
  Screen,
  ScreenHeader,
  Text,
  Card,
  StatTile,
  SectionHeader,
  ProgressBar,
  EmptyState,
  Pressable,
  Banner,
  SkeletonList,
} from '../components/ui';

/** Monthly conversion target. Replace with a tenant setting once one exists. */
const MONTHLY_TARGET = 20;

interface QuickAction {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: ToneName;
  screen: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'New lead', icon: 'add-circle-outline', tone: 'brand', screen: 'SelectLeadCategory' },
  { label: 'Proposals', icon: 'document-text-outline', tone: 'success', screen: 'Proposals' },
  { label: 'Cases', icon: 'folder-open-outline', tone: 'warning', screen: 'Cases' },
  { label: 'Copilot', icon: 'chatbubble-ellipses-outline', tone: 'accent', screen: 'Chat' },
  { label: 'Underwriting', icon: 'shield-checkmark-outline', tone: 'info', screen: 'Underwriting' },
];

const greeting = (): string => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

export default function DashboardScreen() {
  const { colors } = useTheme();
  const { gutter, isCompact } = useResponsive();
  const navigation = useNavigation<any>();
  const { user, canSeeAllLeads } = useSession();
  const { unreadCount } = useNotifications();
  const { leads, loading, syncing, error, refresh } = useLeadSync();

  const [pipelineExpanded, setPipelineExpanded] = React.useState(false);

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    // Anything created since local midnight counts as "today".
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    let addedToday = 0;

    for (const lead of leads) {
      byStatus[lead.status] = (byStatus[lead.status] ?? 0) + 1;
      byType[lead.type] = (byType[lead.type] ?? 0) + 1;
      if (new Date(lead.created_at).getTime() >= startOfToday) addedToday += 1;
    }

    const converted = byStatus.UNDERWRITING_READY ?? 0;
    return {
      total: leads.length,
      newLeads: byStatus.LEAD ?? 0,
      inProgress: byStatus.PROSPECT ?? 0,
      underwriting: converted,
      dead: byStatus.NOT_INTERESTED ?? 0,
      individual: byType.INDIVIDUAL ?? 0,
      family: byType.FAMILY ?? 0,
      corporate: byType.CORPORATE ?? 0,
      addedToday,
      // Active pipeline excludes dead leads — that is the number an agent works.
      active: leads.length - (byStatus.NOT_INTERESTED ?? 0),
      converted,
    };
  }, [leads]);

  const recentLeads = useMemo(() => leads.slice(0, 4), [leads]);

  const goToLeads = () => navigation.navigate('Leads');

  // React Navigation bubbles an unhandled `navigate` up the navigator tree, so
  // one call reaches a sibling tab and a root-stack screen alike. Resolving the
  // parent by hand is brittle — from a tab screen `getParent()` is the drawer,
  // not the stack that actually owns these routes.
  const runAction = (action: QuickAction) => navigation.navigate(action.screen);

  return (
    <Screen
      refreshing={syncing && !loading}
      onRefresh={refresh}
      padded={false}
      header={
        <ScreenHeader
          title={user?.fullName?.split(' ')[0] ?? 'Agent'}
          subtitle={greeting()}
          leading="menu"
          actions={[
            {
              icon: 'notifications-outline',
              onPress: () => navigation.navigate('Notifications'),
              accessibilityLabel: 'Notifications',
              badgeCount: unreadCount,
            },
          ]}
        />
      }
      contentContainerStyle={{ paddingHorizontal: gutter }}
    >
      {error && !loading ? (
        <Banner
          tone="warning"
          title="Showing the last synced data"
          description={error}
          actionLabel="Retry now"
          onAction={refresh}
          style={styles.banner}
        />
      ) : null}

      {/* ── Hero ──────────────────────────────────────────────────────────── */}

      <Card
        padding="xl"
        level={2}
        style={[styles.hero, { backgroundColor: colors.tone.brand.solid, borderColor: 'transparent' }]}
        onPress={goToLeads}
        accessibilityLabel={`${stats.active} active leads. Opens the leads board.`}
      >
        <View style={styles.heroTop}>
          <View style={styles.heroText}>
            <Text variant="overline" uppercase style={{ color: colors.tone.brand.onSolid, opacity: 0.75 }}>
              {canSeeAllLeads ? 'Tenant pipeline' : 'Your pipeline'}
            </Text>
            <Text style={[styles.heroValue, { color: colors.tone.brand.onSolid }]}>
              {loading ? '—' : stats.active}
            </Text>
            <Text variant="caption" style={{ color: colors.tone.brand.onSolid, opacity: 0.85 }}>
              active {stats.active === 1 ? 'lead' : 'leads'}
              {stats.addedToday > 0 ? ` · ${stats.addedToday} added today` : ''}
            </Text>
          </View>
          <View style={styles.heroIcon}>
            <Ionicons name="people" size={26} color={colors.tone.brand.onSolid} />
          </View>
        </View>

        <View style={styles.heroDivider} />

        <View style={styles.heroBreakdown}>
          <HeroStat label="Individual" value={stats.individual} tone="brand" />
          <HeroStat label="Family" value={stats.family} tone="brand" />
          <HeroStat label="Corporate" value={stats.corporate} tone="brand" />
        </View>
      </Card>

      {/* ── Quick actions ─────────────────────────────────────────────────── */}

      <SectionHeader title="Quick actions" icon="apps-outline" />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.actions}
        style={styles.actionsScroll}
      >
        {QUICK_ACTIONS.map((action) => {
          const tone = colors.tone[action.tone];
          return (
            <Pressable
              key={action.label}
              onPress={() => runAction(action)}
              pressedScale={0.94}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={styles.action}
            >
              <View style={[styles.actionIcon, { backgroundColor: tone.soft, borderColor: tone.softBorder }]}>
                <Ionicons name={action.icon} size={24} color={tone.on} />
              </View>
              <Text variant="micro" color="muted" numberOfLines={1} align="center">
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Pipeline stats ────────────────────────────────────────────────── */}

      <SectionHeader 
        title="Pipeline" 
        icon={pipelineExpanded ? "remove-circle" : "add-circle"} 
        onIconPress={() => setPipelineExpanded(!pipelineExpanded)}
      />
      {pipelineExpanded ? (
        <>
          <View style={[styles.grid, isCompact ? null : styles.gridWide]}>
        <StatTile
          label={statusLabel.LEAD}
          value={stats.newLeads}
          caption="Awaiting first contact"
          icon="ellipse-outline"
          tone="brand"
          loading={loading}
          onPress={goToLeads}
        />
        <StatTile
          label={statusLabel.PROSPECT}
          value={stats.inProgress}
          caption="Being actively worked"
          icon="hourglass-outline"
          tone="warning"
          loading={loading}
          onPress={goToLeads}
        />
      </View>
      <View style={[styles.grid, isCompact ? null : styles.gridWide]}>
        <StatTile
          label={statusLabel.UNDERWRITING_READY}
          value={stats.underwriting}
          caption="Handed to underwriting"
          icon="shield-checkmark-outline"
          tone="accent"
          loading={loading}
          onPress={goToLeads}
        />
        <StatTile
          label={statusLabel.NOT_INTERESTED}
          value={stats.dead}
          caption="Out of the pipeline"
          icon="remove-circle-outline"
          tone="neutral"
          loading={loading}
          onPress={goToLeads}
        />
      </View>
        </>
      ) : null}

      {/* ── Target ────────────────────────────────────────────────────────── */}

      <SectionHeader title="Monthly target" icon="stats-chart-outline" />
      <Card padding="lg" style={styles.section}>
        <ProgressBar
          value={stats.converted / MONTHLY_TARGET}
          label="Leads handed to underwriting"
          showValue
          tone={stats.converted >= MONTHLY_TARGET ? 'success' : 'brand'}
          height={10}
        />
        <Text variant="caption" color="muted" style={styles.targetCaption}>
          {stats.converted} of {MONTHLY_TARGET} this month
          {stats.converted >= MONTHLY_TARGET
            ? ' — target met.'
            : ` · ${MONTHLY_TARGET - stats.converted} to go.`}
        </Text>
      </Card>

      {/* ── Recent ────────────────────────────────────────────────────────── */}

      <SectionHeader
        title="Recent leads"
        icon="time-outline"
        count={leads.length}
        actionLabel={leads.length > 0 ? 'See all' : undefined}
        onAction={leads.length > 0 ? goToLeads : undefined}
      />

      {loading ? (
        <SkeletonList count={2} />
      ) : recentLeads.length === 0 ? (
        <Card padding="none" variant="outline" bordered={false} style={styles.section}>
          <EmptyState
            compact
            icon="people-outline"
            title="No leads yet"
            description="Create your first lead — it syncs to the web portal straight away."
            actionLabel="Add a lead"
            onAction={() => navigation.navigate('SelectLeadCategory')}
          />
        </Card>
      ) : (
        <View style={styles.recent}>
          {recentLeads.map((lead: UnifiedLead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              compact
              showOwner={canSeeAllLeads}
              onPress={() => navigation.navigate('LeadDetail', { leadId: lead.id })}
            />
          ))}
        </View>
      )}

      <View style={styles.bottomSpace} />
    </Screen>
  );
}

function HeroStat({ label, value, tone }: { label: string; value: number; tone: ToneName }) {
  const { colors } = useTheme();
  const onSolid = colors.tone[tone].onSolid;
  return (
    <View style={styles.heroStat}>
      <Text style={[styles.heroStatValue, { color: onSolid }]}>{value}</Text>
      <Text variant="micro" style={{ color: onSolid, opacity: 0.75 }}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: spacing.md,
  },
  hero: {
    marginTop: spacing.lg,
    marginBottom: spacing.xxl,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  heroText: {
    flex: 1,
  },
  heroValue: {
    fontSize: 44,
    lineHeight: 50,
    fontWeight: '800',
    letterSpacing: -1.5,
    marginTop: spacing.xs,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    // A translucent white tile reads correctly on the solid brand fill in both
    // themes, where a fixed hex would not.
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  heroDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
    marginVertical: spacing.lg,
  },
  heroBreakdown: {
    flexDirection: 'row',
  },
  heroStat: {
    flex: 1,
  },
  heroStatValue: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '800',
  },
  actionsScroll: {
    marginBottom: spacing.xxl,
    // Lets the row bleed past the screen gutter without clipping the tiles.
    marginHorizontal: -spacing.xs,
  },
  actions: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  action: {
    alignItems: 'center',
    gap: spacing.sm,
    width: 68,
  },
  actionIcon: {
    width: 56,
    height: 56,
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: {
    flexDirection: 'column',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  gridWide: {
    gap: spacing.lg,
  },
  section: {
    marginBottom: spacing.xxl,
  },
  targetCaption: {
    marginTop: spacing.md,
  },
  recent: {
    gap: spacing.md,
  },
  bottomSpace: {
    height: spacing.xxl,
  },
});
