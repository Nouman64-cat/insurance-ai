import React, { useMemo, useState, useRef, useEffect } from 'react';
import { View, StyleSheet, ScrollView, Animated, LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii, duration } from '../theme/tokens';
import { statusLabel, statusTone, entityLabel, entityTone, ToneName } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { useLeadSync } from '../sync/LeadSyncProvider';
import { UnifiedLead } from '../api/leads';
import { formatRelativeTime } from '../notifications/types';
import {
  Screen,
  ScreenHeader,
  Text,
  SectionHeader,
  ProgressBar,
  EmptyState,
  Pressable,
  Banner,
  Badge,
  Avatar,
  SkeletonList,
} from '../components/ui';

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
  { label: 'Copilot', icon: 'sparkles-outline', tone: 'accent', screen: 'Chat' },
  { label: 'Underwriting', icon: 'shield-checkmark-outline', tone: 'info', screen: 'Underwriting' },
];

const greeting = (): string => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

type LeadFilter = 'ALL' | 'INDIVIDUAL' | 'FAMILY' | 'CORPORATE';

const ENTITY_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  INDIVIDUAL: 'person',
  FAMILY: 'people',
  CORPORATE: 'business',
};

export default function DashboardScreen() {
  const { colors, shadow } = useTheme();
  const { gutter, isCompact } = useResponsive();
  const navigation = useNavigation<any>();
  const { user, canSeeAllLeads } = useSession();
  const { unreadCount } = useNotifications();
  const { leads, loading, syncing, error, refresh } = useLeadSync();

  const [pipelineExpanded, setPipelineExpanded] = useState(false);
  const [activeFilter, setActiveFilter] = useState<LeadFilter>('ALL');

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
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
      active: leads.length - (byStatus.NOT_INTERESTED ?? 0),
      converted,
    };
  }, [leads]);

  const filteredLeads = useMemo(() => {
    if (activeFilter === 'ALL') return leads.slice(0, 5);
    return leads.filter((l) => l.type === activeFilter).slice(0, 5);
  }, [leads, activeFilter]);

  const targetPercent = Math.min(100, Math.round((stats.converted / MONTHLY_TARGET) * 100));

  const goToLeads = () => navigation.navigate('Leads');
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

      {/* ── Seamless Hero Banner ───────────────────────────────────────────── */}

      <Pressable
        onPress={goToLeads}
        pressedScale={0.985}
        accessibilityRole="button"
        accessibilityLabel={`${stats.active} active leads`}
        style={[
          styles.heroSurface,
          {
            backgroundColor: colors.tone.brand.solid,
          },
          shadow(2),
        ]}
      >
        <View style={styles.heroTopRow}>
          <View>
            <View style={styles.heroStatusBadge}>
              <View style={styles.pulseDot} />
              <Text variant="overline" uppercase style={{ color: colors.tone.brand.onSolid, opacity: 0.9 }}>
                {canSeeAllLeads ? 'Tenant Active Pipeline' : 'Active Pipeline'}
              </Text>
            </View>

            <View style={styles.heroValueRow}>
              <Text style={[styles.heroBigValue, { color: colors.tone.brand.onSolid }]}>
                {loading ? '—' : stats.active}
              </Text>
              <Text variant="body" style={{ color: colors.tone.brand.onSolid, opacity: 0.85, marginBottom: 6 }}>
                active {stats.active === 1 ? 'lead' : 'leads'}
                {stats.addedToday > 0 ? ` · ${stats.addedToday} added today` : ''}
              </Text>
            </View>
          </View>

          <View style={styles.heroSparkCircle}>
            <Ionicons name="stats-chart" size={24} color={colors.tone.brand.onSolid} />
          </View>
        </View>

        <View style={styles.heroBreakdownRow}>
          <View style={styles.heroStatColumn}>
            <Text style={styles.heroStatNumber}>{stats.individual}</Text>
            <Text style={styles.heroStatLabel}>Individual</Text>
          </View>
          <View style={styles.heroStatDivider} />
          <View style={styles.heroStatColumn}>
            <Text style={styles.heroStatNumber}>{stats.family}</Text>
            <Text style={styles.heroStatLabel}>Family</Text>
          </View>
          <View style={styles.heroStatDivider} />
          <View style={styles.heroStatColumn}>
            <Text style={styles.heroStatNumber}>{stats.corporate}</Text>
            <Text style={styles.heroStatLabel}>Corporate</Text>
          </View>
        </View>
      </Pressable>

      {/* ── Quick Actions Bar ─────────────────────────────────────────────── */}

      <SectionHeader title="Quick actions" icon="apps-outline" />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.actionsContainer}
        style={styles.actionsScroll}
      >
        {QUICK_ACTIONS.map((action) => {
          const tone = colors.tone[action.tone];
          return (
            <Pressable
              key={action.label}
              onPress={() => runAction(action)}
              pressedScale={0.92}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={styles.actionItem}
            >
              <View style={[styles.actionIconNode, { backgroundColor: tone.soft, borderColor: tone.softBorder }]}>
                <Ionicons name={action.icon} size={22} color={tone.on} />
              </View>
              <Text variant="micro" color="muted" numberOfLines={1} align="center">
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Seamless Animated Pipeline ───────────────────────────────────── */}

      <CollapsiblePipeline
        expanded={pipelineExpanded}
        onToggle={() => setPipelineExpanded((prev) => !prev)}
        stats={stats}
        loading={loading}
        goToLeads={goToLeads}
      />

      {/* ── Borderless Target Progress ────────────────────────────────────── */}

      <SectionHeader title="Monthly target" icon="stats-chart-outline" />
      <View style={styles.targetSection}>
        <View style={styles.targetRow}>
          <View>
            <Text variant="bodyStrong">Underwriting Handover</Text>
            <Text variant="caption" color="muted" style={{ marginTop: 2 }}>
              {stats.converted} of {MONTHLY_TARGET} leads converted
            </Text>
          </View>
          <Badge
            label={`${targetPercent}%`}
            tone={stats.converted >= MONTHLY_TARGET ? 'success' : 'brand'}
            variant="soft"
          />
        </View>
        <ProgressBar
          value={stats.converted / MONTHLY_TARGET}
          showValue={false}
          tone={stats.converted >= MONTHLY_TARGET ? 'success' : 'brand'}
          height={8}
          style={{ marginTop: spacing.md }}
        />
      </View>

      {/* ── Dynamic Recent Activity Feed ──────────────────────────────────── */}

      <SectionHeader
        title="Recent activity"
        icon="time-outline"
        count={leads.length}
        actionLabel={leads.length > 0 ? 'See all' : undefined}
        onAction={leads.length > 0 ? goToLeads : undefined}
      />

      {/* Filter Tabs */}
      <View style={styles.filterTabs}>
        {(['ALL', 'INDIVIDUAL', 'FAMILY', 'CORPORATE'] as LeadFilter[]).map((filter) => {
          const active = activeFilter === filter;
          const label =
            filter === 'ALL'
              ? 'All'
              : filter === 'INDIVIDUAL'
              ? 'Individual'
              : filter === 'FAMILY'
              ? 'Family'
              : 'Corporate';
          return (
            <Pressable
              key={filter}
              onPress={() => setActiveFilter(filter)}
              pressedScale={0.96}
              style={[
                styles.filterTabPill,
                active
                  ? { backgroundColor: colors.tone.brand.soft, borderColor: colors.tone.brand.softBorder }
                  : { backgroundColor: colors.surfaceSunken, borderColor: 'transparent' },
              ]}
            >
              <Text
                variant="micro"
                style={{
                  color: active ? colors.tone.brand.on : colors.textMuted,
                  fontWeight: active ? '700' : '500',
                }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <SkeletonList count={3} />
      ) : filteredLeads.length === 0 ? (
        <View style={styles.emptyContainer}>
          <EmptyState
            compact
            icon="people-outline"
            title="No leads in this category"
            description="Tap below to create a new lead."
            actionLabel="Add lead"
            onAction={() => navigation.navigate('SelectLeadCategory')}
          />
        </View>
      ) : (
        <View style={styles.leadListContainer}>
          {filteredLeads.map((lead: UnifiedLead, index: number) => {
            const tone = statusTone[lead.status] ?? 'neutral';
            const typeTone = entityTone[lead.type] ?? 'neutral';
            return (
              <View key={lead.id}>
                <Pressable
                  onPress={() => navigation.navigate('LeadDetail', { leadId: lead.id })}
                  pressedScale={0.985}
                  accessibilityRole="button"
                  accessibilityLabel={lead.name}
                  style={styles.leadRowItem}
                >
                  <Avatar
                    name={lead.name}
                    icon={ENTITY_ICON[lead.type]}
                    tone={typeTone}
                    size={40}
                    shape={lead.type === 'INDIVIDUAL' ? 'circle' : 'rounded'}
                  />

                  <View style={styles.leadInfoText}>
                    <Text variant="bodyStrong" numberOfLines={1}>
                      {lead.name || 'Unnamed lead'}
                    </Text>
                    <Text variant="caption" color="muted" numberOfLines={1}>
                      {entityLabel[lead.type] ?? lead.type} · {lead.contact_info}
                    </Text>
                  </View>

                  <View style={styles.leadTrailing}>
                    <Badge label={statusLabel[lead.status] ?? lead.status} tone={tone} variant="soft" dot />
                    <Text variant="micro" color="subtle" style={{ marginTop: 2 }}>
                      {formatRelativeTime(new Date(lead.created_at).getTime())}
                    </Text>
                  </View>
                </Pressable>
                {index < filteredLeads.length - 1 ? (
                  <View style={[styles.hairlineDivider, { backgroundColor: colors.borderSubtle }]} />
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.bottomSpace} />
    </Screen>
  );
}

function CollapsiblePipeline({
  expanded,
  onToggle,
  stats,
  loading,
  goToLeads,
}: {
  expanded: boolean;
  onToggle: () => void;
  stats: any;
  loading: boolean;
  goToLeads: () => void;
}) {
  const { colors } = useTheme();
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: expanded ? 1 : 0,
      duration: duration.normal,
      useNativeDriver: false,
    }).start();
  }, [expanded, progress]);

  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (Math.abs(contentHeight - h) > 1) {
      setContentHeight(h);
    }
  };

  return (
    <>
      <SectionHeader
        title="Pipeline"
        icon="funnel-outline"
        rightIcon={expanded ? 'remove-circle-outline' : 'add-circle-outline'}
        onRightIconPress={onToggle}
      />
      <Animated.View
        style={[
          styles.pipelineClip,
          {
            height:
              contentHeight === 0 && expanded
                ? undefined
                : progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, contentHeight],
                  }),
            opacity: progress,
          },
        ]}
      >
        <View
          style={contentHeight === 0 && expanded ? undefined : styles.pipelineMeasure}
          onLayout={onLayout}
        >
          <View style={styles.nodeListContainer}>
            <PipelineNode
              label={statusLabel.LEAD}
              count={stats.newLeads}
              icon="ellipse-outline"
              tone="brand"
              onPress={goToLeads}
            />
            <View style={[styles.hairlineDivider, { backgroundColor: colors.borderSubtle }]} />
            <PipelineNode
              label={statusLabel.PROSPECT}
              count={stats.inProgress}
              icon="hourglass-outline"
              tone="warning"
              onPress={goToLeads}
            />
            <View style={[styles.hairlineDivider, { backgroundColor: colors.borderSubtle }]} />
            <PipelineNode
              label={statusLabel.UNDERWRITING_READY}
              count={stats.underwriting}
              icon="shield-checkmark-outline"
              tone="accent"
              onPress={goToLeads}
            />
            <View style={[styles.hairlineDivider, { backgroundColor: colors.borderSubtle }]} />
            <PipelineNode
              label={statusLabel.NOT_INTERESTED}
              count={stats.dead}
              icon="remove-circle-outline"
              tone="neutral"
              onPress={goToLeads}
            />
          </View>
        </View>
      </Animated.View>
    </>
  );
}

function PipelineNode({
  label,
  count,
  icon,
  tone,
  onPress,
}: {
  label: string;
  count: number;
  icon: keyof typeof Ionicons.glyphMap;
  tone: ToneName;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const t = colors.tone[tone];
  return (
    <Pressable onPress={onPress} pressedScale={0.98} style={styles.nodeItem}>
      <View style={[styles.nodeIconWrap, { backgroundColor: t.soft }]}>
        <Ionicons name={icon} size={18} color={t.on} />
      </View>
      <View style={styles.nodeMeta}>
        <Text variant="caption" color="muted" numberOfLines={1}>
          {label}
        </Text>
        <Text variant="title3" style={{ fontWeight: '800' }}>
          {count}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textSubtle} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: spacing.md,
  },
  heroSurface: {
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
    padding: spacing.xl,
    borderRadius: radii.xl,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  heroStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#34d399',
  },
  heroValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  heroBigValue: {
    fontSize: 48,
    lineHeight: 52,
    fontWeight: '900',
    letterSpacing: -1.5,
  },
  heroSparkCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBreakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.25)',
  },
  heroStatColumn: {
    flex: 1,
    alignItems: 'center',
  },
  heroStatNumber: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '800',
    color: '#ffffff',
  },
  heroStatLabel: {
    fontSize: 12,
    lineHeight: 16,
    color: 'rgba(255, 255, 255, 0.8)',
    marginTop: 2,
    fontWeight: '500',
  },
  heroStatDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  actionsScroll: {
    marginBottom: spacing.xl,
    marginHorizontal: -spacing.xs,
  },
  actionsContainer: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  actionItem: {
    alignItems: 'center',
    gap: spacing.xs,
    width: 68,
  },
  actionIconNode: {
    width: 54,
    height: 54,
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pipelineClip: {
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  pipelineMeasure: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
  },
  nodeListContainer: {
    paddingVertical: spacing.xs,
  },
  nodeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  nodeIconWrap: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeMeta: {
    flex: 1,
  },
  targetSection: {
    paddingVertical: spacing.sm,
    marginBottom: spacing.xl,
  },
  targetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  filterTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  filterTabPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  emptyContainer: {
    paddingVertical: spacing.lg,
  },
  leadListContainer: {
    gap: spacing.xs,
  },
  leadRowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  leadInfoText: {
    flex: 1,
  },
  leadTrailing: {
    alignItems: 'flex-end',
  },
  hairlineDivider: {
    height: StyleSheet.hairlineWidth,
  },
  bottomSpace: {
    height: spacing.xxl,
  },
});
