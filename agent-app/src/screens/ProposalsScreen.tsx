import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, ScrollView, TextInput, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii, typography, hitTarget } from '../theme/tokens';
import { ToneName } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { useBottomClearance } from '../hooks/useBottomClearance';
import { useNotifications } from '../notifications/NotificationContext';
import { fetchProposals, ProposalItem } from '../api/proposals';
import { formatRelativeTime } from '../notifications/types';
import {
  Screen,
  ScreenHeader,
  Text,
  Card,
  Badge,
  Avatar,
  Fab,
  EmptyState,
  SkeletonList,
  SegmentedControl,
  Banner,
  Divider,
  Pressable,
} from '../components/ui';

type ViewMode = 'list' | 'board';

/** Maps the many status strings the backend emits onto a tone and a label. */
const STATUS_META: Record<string, { tone: ToneName; label: string }> = {
  QUOTED: { tone: 'brand', label: 'Quoted' },
  PENDING: { tone: 'warning', label: 'Pending' },
  ACCEPTED: { tone: 'success', label: 'Accepted' },
  APPROVED: { tone: 'success', label: 'Approved' },
  DECLINED: { tone: 'danger', label: 'Declined' },
  REJECTED: { tone: 'danger', label: 'Rejected' },
  EXPIRED: { tone: 'neutral', label: 'Expired' },
};

const metaFor = (status: string) => {
  const key = (status ?? '').toUpperCase();
  return STATUS_META[key] ?? { tone: 'neutral' as ToneName, label: status || 'Unknown' };
};

const BOARD_COLUMNS: { title: string; statuses: string[] }[] = [
  { title: 'Quoted', statuses: ['QUOTED', 'PENDING'] },
  { title: 'Accepted', statuses: ['ACCEPTED', 'APPROVED'] },
  { title: 'Closed', statuses: ['DECLINED', 'REJECTED', 'EXPIRED'] },
];

/** PKR amounts run to eight digits — abbreviate so cards stay scannable. */
const formatCurrency = (amount: number): string => {
  if (!Number.isFinite(amount)) return '—';
  if (amount >= 10_000_000) return `${(amount / 10_000_000).toFixed(2)} Cr`;
  if (amount >= 100_000) return `${(amount / 100_000).toFixed(2)} Lac`;
  return amount.toLocaleString();
};

export default function ProposalsScreen() {
  const { colors } = useTheme();
  const { gutter, isCompact, width, columns } = useResponsive();
  const { listPadding } = useBottomClearance();
  const navigation = useNavigation<any>();
  const { toast } = useNotifications();

  const [proposals, setProposals] = useState<ProposalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setRefreshing(true);
      try {
        const data = await fetchProposals();
        setProposals(data);
        setError(null);
      } catch (err: any) {
        setError(err?.message ?? 'Could not load proposals.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    load({ silent: true });
  }, [load]);

  // A proposal created on the Add screen should be present the moment the user
  // returns, without them having to pull to refresh.
  useFocusEffect(
    useCallback(() => {
      load({ silent: true });
    }, [load])
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return proposals;
    return proposals.filter(
      (p) =>
        p.customer_name?.toLowerCase().includes(q) ||
        p.product_name?.toLowerCase().includes(q) ||
        p.customer_cnic?.toLowerCase().includes(q)
    );
  }, [proposals, search]);

  const totalCoverage = useMemo(
    () => proposals.reduce((sum, p) => sum + (Number(p.coverage_amount) || 0), 0),
    [proposals]
  );

  const renderCard = (item: ProposalItem, compact = false) => {
    const meta = metaFor(item.status);
    return (
      <Card
        key={item.id}
        padding="lg"
        onPress={() =>
          toast(item.customer_name, {
            body: `${item.product_name} · PKR ${formatCurrency(item.coverage_amount)}`,
            tone: meta.tone,
            icon: 'document-text-outline',
          })
        }
        accessibilityLabel={`${item.customer_name}, ${meta.label}`}
        style={compact ? undefined : styles.card}
      >
        <View style={styles.cardHeader}>
          <Avatar name={item.customer_name} tone={meta.tone} size={42} />
          <View style={styles.cardIdentity}>
            <Text variant="title3" numberOfLines={1}>
              {item.customer_name || 'Unnamed'}
            </Text>
            <Text variant="caption" color="muted" numberOfLines={1}>
              {item.product_name}
            </Text>
          </View>
          <Badge label={meta.label} tone={meta.tone} variant="soft" dot />
        </View>

        <Divider spacingY="md" />

        <View style={styles.cardBody}>
          <View style={styles.metric}>
            <Text variant="micro" color="subtle" uppercase>
              Coverage
            </Text>
            <Text variant="bodyStrong" numberOfLines={1}>
              PKR {formatCurrency(item.coverage_amount)}
            </Text>
          </View>
          <View style={styles.metric}>
            <Text variant="micro" color="subtle" uppercase>
              Term
            </Text>
            <Text variant="bodyStrong">{item.term_years} yrs</Text>
          </View>
          <View style={styles.metric}>
            <Text variant="micro" color="subtle" uppercase>
              Created
            </Text>
            <Text variant="bodyStrong" numberOfLines={1}>
              {formatRelativeTime(new Date(item.created_at).getTime())}
            </Text>
          </View>
        </View>
      </Card>
    );
  };

  const gridColumns = viewMode === 'list' && !isCompact ? columns(320) : 1;

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader
          title="Proposals"
          subtitle={
            loading
              ? 'Loading…'
              : `${proposals.length} ${proposals.length === 1 ? 'proposal' : 'proposals'} · PKR ${formatCurrency(totalCoverage)} covered`
          }
          leading="menu"
        >
          <View style={styles.controls}>
            <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Ionicons name="search" size={18} color={colors.textSubtle} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search by customer or product…"
                placeholderTextColor={colors.textSubtle}
                style={[styles.searchInput, typography.body, { color: colors.text }]}
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel="Search proposals"
              />
              {search.length > 0 ? (
                <Pressable
                  onPress={() => setSearch('')}
                  pressedScale={0.9}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                >
                  <Ionicons name="close-circle" size={18} color={colors.textSubtle} />
                </Pressable>
              ) : null}
            </View>


          </View>
        </ScreenHeader>
      }
    >
      {error && !loading ? (
        <Banner
          tone="warning"
          title="Could not refresh proposals"
          description={error}
          actionLabel="Retry"
          onAction={() => load()}
          style={[styles.banner, { marginHorizontal: gutter }]}
        />
      ) : null}

      {loading ? (
        <View style={{ paddingHorizontal: gutter }}>
          <SkeletonList count={3} />
        </View>
      ) : viewMode === 'board' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.board, { paddingHorizontal: gutter }]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load()} tintColor={colors.primary} />
          }
        >
          {BOARD_COLUMNS.map((column) => {
            const items = filtered.filter((p) => column.statuses.includes((p.status ?? '').toUpperCase()));
            return (
              <View key={column.title} style={[styles.boardColumn, { width: isCompact ? width * 0.82 : 320 }]}>
                <View style={[styles.boardHeader, { backgroundColor: colors.surfaceSunken }]}>
                  <Text variant="calloutStrong" style={styles.boardTitle} numberOfLines={1}>
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
                  contentContainerStyle={[styles.boardList, { paddingBottom: listPadding }]}
                  nestedScrollEnabled
                >
                  {items.length === 0 ? (
                    <View style={[styles.boardEmpty, { borderColor: colors.border }]}>
                      <Ionicons name="documents-outline" size={20} color={colors.textSubtle} />
                      <Text variant="caption" color="subtle">
                        Nothing here yet
                      </Text>
                    </View>
                  ) : (
                    items.map((item) => renderCard(item, true))
                  )}
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <FlatList
          key={`proposals-${gridColumns}`}
          data={filtered}
          keyExtractor={(item) => item.id}
          numColumns={gridColumns}
          columnWrapperStyle={gridColumns > 1 ? styles.column : undefined}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: gutter, paddingBottom: listPadding },
            filtered.length === 0 ? styles.listEmpty : null,
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
          renderItem={({ item }) => renderCard(item)}
          ListEmptyComponent={
            <EmptyState
              icon={search ? 'search-outline' : 'document-text-outline'}
              title={search ? 'No matching proposals' : 'No proposals yet'}
              description={
                search
                  ? 'Try a different customer or product name.'
                  : 'Create a proposal to quote coverage for one of your leads.'
              }
              actionLabel={search ? 'Clear search' : 'New proposal'}
              onAction={
                search ? () => setSearch('') : () => navigation.navigate('AddProposal')
              }
            />
          }
        />
      )}

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
    overflow: 'hidden',
  },
  searchInput: {
    flex: 1,
    paddingVertical: 0,
    paddingHorizontal: 0,
    marginHorizontal: 0,
    minWidth: 0,
  },
  viewToggle: {
    width: 96,
  },
  banner: {
    marginBottom: spacing.md,
  },
  listContent: {
    paddingTop: spacing.lg,
    // Bottom padding is supplied dynamically via useBottomClearance.
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
  cardBody: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  metric: {
    flex: 1,
    gap: spacing.xxs,
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
    // Bottom padding is supplied dynamically via useBottomClearance.
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
});
