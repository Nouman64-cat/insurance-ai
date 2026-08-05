import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, ScrollView, TextInput, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii, typography, hitTarget } from '../theme/tokens';
import { statusLabel } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { useLeadSync } from '../sync/LeadSyncProvider';
import { updateLeadStatus, deleteLead, UnifiedLead, ProfileStatus } from '../api/leads';
import { RootStackParamList } from '../navigation/AppNavigator';
import LeadCard from '../components/LeadCard';
import {
  Screen,
  ScreenHeader,
  Text,
  Fab,
  EmptyState,
  SkeletonList,
  SegmentedControl,
  Sheet,
  ListRow,
  ConfirmDialog,
  Banner,
  Pressable,
} from '../components/ui';

type StatusFilter = 'ALL' | 'LEAD' | 'PROSPECT' | 'UNDERWRITING_READY' | 'NOT_INTERESTED';
type ViewMode = 'list' | 'board';

/** Columns of the board view, left to right in pipeline order. */
const BOARD_COLUMNS: { status: ProfileStatus; title: string }[] = [
  { status: 'LEAD', title: 'New Leads' },
  { status: 'PROSPECT', title: 'In Progress' },
  { status: 'UNDERWRITING_READY', title: 'Underwriting' },
  { status: 'NOT_INTERESTED', title: 'Not Interested' },
];

export default function LeadsScreen() {
  const { colors } = useTheme();
  const { gutter, columns, isCompact, width } = useResponsive();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { canSeeAllLeads } = useSession();
  const { toast } = useNotifications();
  const { leads, loading, syncing, error, refresh, applyLocal, removeLocal } = useLeadSync();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [menuLead, setMenuLead] = useState<UnifiedLead | null>(null);
  const [pendingDelete, setPendingDelete] = useState<UnifiedLead | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Derived data ───────────────────────────────────────────────────────────

  const counts = useMemo(() => {
    const tally: Record<string, number> = { ALL: leads.length };
    for (const lead of leads) tally[lead.status] = (tally[lead.status] ?? 0) + 1;
    return tally;
  }, [leads]);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter(
      (l) =>
        l.name?.toLowerCase().includes(q) ||
        l.contact_info?.toLowerCase().includes(q) ||
        l.city?.toLowerCase().includes(q) ||
        l.primaryIdentifier?.toLowerCase().includes(q) ||
        l.assignedAgentName?.toLowerCase().includes(q)
    );
  }, [leads, query]);

  const filtered = useMemo(
    () => (filter === 'ALL' ? searched : searched.filter((l) => l.status === filter)),
    [searched, filter]
  );

  const filterSegments = useMemo(
    () =>
      (['ALL', 'LEAD', 'PROSPECT', 'UNDERWRITING_READY', 'NOT_INTERESTED'] as StatusFilter[]).map(
        (value) => ({
          value,
          label: value === 'ALL' ? 'All' : statusLabel[value] ?? value,
          count: counts[value] ?? 0,
        })
      ),
    [counts]
  );

  // ── Mutations ──────────────────────────────────────────────────────────────

  const changeStatus = useCallback(
    async (lead: UnifiedLead, status: ProfileStatus) => {
      const previousStatus = lead.status;
      // Optimistic: the row moves immediately, and `applyLocal` also updates the
      // sync baseline so the next poll does not announce the user's own change.
      applyLocal(lead.id, { status });
      try {
        await updateLeadStatus(lead, status);
        toast(`${lead.name} → ${statusLabel[status] ?? status}`, {
          tone: 'success',
          icon: 'checkmark-circle',
        });
      } catch (err: any) {
        applyLocal(lead.id, { status: previousStatus });
        toast('Could not update the lead', {
          body: err?.message ?? 'Please try again.',
          tone: 'danger',
          icon: 'alert-circle',
        });
      }
    },
    [applyLocal, toast]
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const lead = pendingDelete;
    setDeleting(true);
    try {
      await deleteLead(lead);
      removeLocal(lead.id);
      setPendingDelete(null);
      toast(`${lead.name} deleted`, { tone: 'neutral', icon: 'trash-outline' });
    } catch (err: any) {
      toast('Could not delete the lead', {
        body: err?.message ?? 'Please try again.',
        tone: 'danger',
        icon: 'alert-circle',
      });
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, removeLocal, toast]);

  const openLead = useCallback(
    (lead: UnifiedLead) => navigation.navigate('LeadDetail', { leadId: lead.id }),
    [navigation]
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  const gridColumns = viewMode === 'list' && !isCompact ? columns(300) : 1;

  const renderList = () => {
    if (loading) return <SkeletonList count={4} />;

    if (filtered.length === 0) {
      const isFiltered = query.trim().length > 0 || filter !== 'ALL';
      return (
        <EmptyState
          icon={isFiltered ? 'search-outline' : 'people-outline'}
          title={isFiltered ? 'No matching leads' : 'No leads yet'}
          description={
            isFiltered
              ? 'Try a different search term, or clear the filter to see everything.'
              : canSeeAllLeads
              ? 'When an agent adds a lead — here or in the portal — it appears on this board straight away.'
              : 'Add your first lead and it will sync to the portal instantly.'
          }
          actionLabel={isFiltered ? 'Clear filters' : 'Add a lead'}
          onAction={
            isFiltered
              ? () => {
                  setQuery('');
                  setFilter('ALL');
                }
              : () => navigation.navigate('SelectLeadCategory')
          }
        />
      );
    }

    return (
      <FlatList
        key={`list-${gridColumns}`}
        data={filtered}
        keyExtractor={(item) => item.id}
        numColumns={gridColumns}
        columnWrapperStyle={gridColumns > 1 ? styles.column : undefined}
        contentContainerStyle={[styles.listContent, { paddingHorizontal: gutter }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={syncing && !loading}
            onRefresh={refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
        // Keeps memory flat on a large book without blanking rows while scrolling.
        initialNumToRender={8}
        windowSize={11}
        removeClippedSubviews
        renderItem={({ item }) => (
          <LeadCard
            lead={item}
            showOwner={canSeeAllLeads}
            onPress={() => openLead(item)}
            onStatusChange={(status) => changeStatus(item, status)}
            onMenu={() => setMenuLead(item)}
            style={gridColumns > 1 ? styles.gridItem : undefined}
          />
        )}
      />
    );
  };

  const renderBoard = () => {
    if (loading) {
      return (
        <View style={{ paddingHorizontal: gutter }}>
          <SkeletonList count={3} />
        </View>
      );
    }

    // Column width leaves the next column peeking, which is what tells the user
    // the board scrolls horizontally.
    const columnWidth = isCompact ? width * 0.82 : 320;

    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.board, { paddingHorizontal: gutter }]}
        refreshControl={
          <RefreshControl
            refreshing={syncing && !loading}
            onRefresh={refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        {BOARD_COLUMNS.map((column) => {
          const items = searched.filter((l) => l.status === column.status);
          return (
            <View key={column.status} style={[styles.boardColumn, { width: columnWidth }]}>
              <View style={[styles.boardHeader, { backgroundColor: colors.surfaceSunken }]}>
                <Text variant="calloutStrong" numberOfLines={1} style={styles.boardTitle}>
                  {column.title}
                </Text>
                <View style={[styles.boardCount, { backgroundColor: colors.surface }]}>
                  <Text variant="micro" color="muted">
                    {items.length}
                  </Text>
                </View>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.boardList}
                // The board scrolls horizontally; each column scrolls vertically.
                nestedScrollEnabled
              >
                {items.length === 0 ? (
                  <View style={[styles.boardEmpty, { borderColor: colors.border }]}>
                    <Ionicons name="albums-outline" size={20} color={colors.textSubtle} />
                    <Text variant="caption" color="subtle" align="center">
                      Nothing here yet
                    </Text>
                  </View>
                ) : (
                  items.map((item) => (
                    <LeadCard
                      key={item.id}
                      lead={item}
                      compact
                      showOwner={canSeeAllLeads}
                      onPress={() => openLead(item)}
                      onMenu={() => setMenuLead(item)}
                    />
                  ))
                )}
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>
    );
  };

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader
          title={canSeeAllLeads ? 'All Leads' : 'My Leads'}
          subtitle={
            syncing
              ? 'Syncing…'
              : `${leads.length} ${leads.length === 1 ? 'lead' : 'leads'} in your pipeline`
          }
          leading="menu"
          actions={[
            {
              icon: 'notifications-outline',
              onPress: () => navigation.navigate('Notifications'),
              accessibilityLabel: 'Notifications',
            },
          ]}
        >
          <View style={styles.controls}>
            <View
              style={[
                styles.search,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <Ionicons name="search" size={18} color={colors.textSubtle} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={canSeeAllLeads ? 'Search leads or agents…' : 'Search your leads…'}
                placeholderTextColor={colors.textSubtle}
                style={[styles.searchInput, typography.body, { color: colors.text }]}
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel="Search leads"
              />
              {query.length > 0 ? (
                <Pressable
                  onPress={() => setQuery('')}
                  pressedScale={0.9}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                >
                  <Ionicons name="close-circle" size={18} color={colors.textSubtle} />
                </Pressable>
              ) : null}
            </View>

            <SegmentedControl<ViewMode>
              segments={[
                { value: 'list', label: '', icon: 'list' },
                { value: 'board', label: '', icon: 'grid' },
              ]}
              value={viewMode}
              onChange={setViewMode}
              style={styles.viewToggle}
            />
          </View>

          {viewMode === 'list' ? (
            <SegmentedControl<StatusFilter>
              segments={filterSegments}
              value={filter}
              onChange={setFilter}
              variant="chips"
              style={styles.filters}
            />
          ) : null}
        </ScreenHeader>
      }
    >
      {error && !loading ? (
        <Banner
          tone="warning"
          title="Working from cached data"
          description={error}
          actionLabel="Retry now"
          onAction={refresh}
          style={[styles.banner, { marginHorizontal: gutter }]}
        />
      ) : null}

      {viewMode === 'list' ? renderList() : renderBoard()}

      <Fab
        icon="add"
        label="Add Lead"
        onPress={() => navigation.navigate('SelectLeadCategory')}
        accessibilityLabel="Add a new lead"
      />

      <Sheet
        visible={!!menuLead}
        onClose={() => setMenuLead(null)}
        title={menuLead?.name}
        subtitle={menuLead ? statusLabel[menuLead.status] ?? menuLead.status : undefined}
        scrollable={false}
      >
        {menuLead ? (
          <View style={styles.menu}>
            <ListRow
              title="View details"
              subtitle="Full profile, contact and pipeline history"
              icon="open-outline"
              tone="brand"
              onPress={() => {
                const lead = menuLead;
                setMenuLead(null);
                openLead(lead);
              }}
            />
            {menuLead.status !== 'PROSPECT' ? (
              <ListRow
                title="Mark as In Progress"
                subtitle="You are actively working this lead"
                icon="play-forward-outline"
                tone="warning"
                onPress={() => {
                  const lead = menuLead;
                  setMenuLead(null);
                  changeStatus(lead, 'PROSPECT');
                }}
              />
            ) : null}
            {menuLead.status !== 'NOT_INTERESTED' ? (
              <ListRow
                title="Mark as Not Interested"
                subtitle="Moves the lead out of the active pipeline"
                icon="close-circle-outline"
                tone="neutral"
                onPress={() => {
                  const lead = menuLead;
                  setMenuLead(null);
                  changeStatus(lead, 'NOT_INTERESTED');
                }}
              />
            ) : (
              <ListRow
                title="Reactivate lead"
                subtitle="Return it to the new-leads column"
                icon="refresh-outline"
                tone="success"
                onPress={() => {
                  const lead = menuLead;
                  setMenuLead(null);
                  changeStatus(lead, 'LEAD');
                }}
              />
            )}
            <ListRow
              title="Delete lead"
              subtitle="Permanently removes it for everyone"
              icon="trash-outline"
              destructive
              onPress={() => {
                const lead = menuLead;
                setMenuLead(null);
                setPendingDelete(lead);
              }}
            />
          </View>
        ) : null}
      </Sheet>

      <ConfirmDialog
        visible={!!pendingDelete}
        title={`Delete ${pendingDelete?.name ?? 'this lead'}?`}
        message="This removes the lead from the shared database, so it disappears from the portal too. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        icon="trash-outline"
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: hitTarget.comfortable,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    padding: 0,
  },
  viewToggle: {
    width: 96,
  },
  filters: {
    marginTop: spacing.md,
  },
  banner: {
    marginBottom: spacing.md,
  },
  listContent: {
    paddingTop: spacing.lg,
    paddingBottom: 120,
    gap: spacing.md,
  },
  column: {
    gap: spacing.md,
  },
  gridItem: {
    flex: 1,
  },
  board: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  boardColumn: {
    flex: 1,
  },
  boardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    marginBottom: spacing.md,
  },
  boardTitle: {
    flex: 1,
  },
  boardCount: {
    minWidth: 24,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    alignItems: 'center',
  },
  boardList: {
    gap: spacing.md,
    paddingBottom: 120,
  },
  boardEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxxl,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  menu: {
    paddingBottom: spacing.md,
  },
});
