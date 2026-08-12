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
import { fetchCases, CaseItem } from '../api/cases';
import { inviteEApplication, buildEApplicationLink } from '../api/eApplication';
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
  LinkShareSheet,
} from '../components/ui';

type ViewMode = 'list' | 'board';

const STATUS_META: Record<string, { tone: ToneName; label: string }> = {
  DRAFT: { tone: 'neutral', label: 'Draft' },
  NEW: { tone: 'brand', label: 'New' },
  QUOTED: { tone: 'brand', label: 'Quoted' },
  UNDERWRITING: { tone: 'warning', label: 'Underwriting' },
  IN_PROGRESS: { tone: 'warning', label: 'In Progress' },
  PENDING: { tone: 'warning', label: 'Pending' },
  APPROVED: { tone: 'success', label: 'Approved' },
  ISSUED: { tone: 'success', label: 'Issued' },
  DECLINED: { tone: 'danger', label: 'Declined' },
  CLOSED: { tone: 'neutral', label: 'Closed' },
};

const PRIORITY_TONE: Record<string, ToneName> = {
  HIGH: 'danger',
  URGENT: 'danger',
  NORMAL: 'neutral',
  MEDIUM: 'warning',
  LOW: 'neutral',
};

const metaFor = (status: string) => {
  const key = (status ?? '').toUpperCase();
  return STATUS_META[key] ?? { tone: 'neutral' as ToneName, label: status || 'Unknown' };
};

const BOARD_COLUMNS: { title: string; statuses: string[] }[] = [
  { title: 'New', statuses: ['DRAFT', 'NEW', 'QUOTED'] },
  { title: 'Underwriting', statuses: ['UNDERWRITING', 'IN_PROGRESS', 'PENDING'] },
  { title: 'Closed', statuses: ['APPROVED', 'ISSUED', 'DECLINED', 'CLOSED'] },
];

export default function CasesScreen() {
  const { colors } = useTheme();
  const { gutter, isCompact, width, columns } = useResponsive();
  const { listPadding } = useBottomClearance();
  const navigation = useNavigation<any>();
  const { toast } = useNotifications();

  const [cases, setCases] = useState<CaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sendingLinkFor, setSendingLinkFor] = useState<string | null>(null);
  const [eAppLink, setEAppLink] = useState<{ applicantName: string; url: string } | null>(null);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setRefreshing(true);
    try {
      const data = await fetchCases();
      setCases(data);
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

  useFocusEffect(
    useCallback(() => {
      load({ silent: true });
    }, [load])
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter(
      (c) =>
        c.applicant_name?.toLowerCase().includes(q) ||
        c.case_number?.toLowerCase().includes(q) ||
        c.customer_cnic?.toLowerCase().includes(q)
    );
  }, [cases, search]);

  const sendEApplicationLink = useCallback(
    async (item: CaseItem) => {
      setSendingLinkFor(item.id);
      try {
        const invite = await inviteEApplication(item.id);
        const link = buildEApplicationLink(invite.link_path);
        setEAppLink({ applicantName: item.applicant_name, url: link });
      } catch (err: any) {
        toast('Could not generate the link', {
          body: err?.message ?? 'Please try again.',
          tone: 'danger',
          icon: 'alert-circle',
        });
      } finally {
        setSendingLinkFor(null);
      }
    },
    [toast]
  );

  const renderCard = (item: CaseItem, compact = false) => {
    const meta = metaFor(item.status);
    const priorityTone = PRIORITY_TONE[(item.priority ?? '').toUpperCase()] ?? 'neutral';
    const sending = sendingLinkFor === item.id;

    return (
      <Card key={item.id} padding="lg" style={compact ? undefined : styles.card}>
        <View style={styles.cardHeader}>
          <Avatar name={item.applicant_name} tone={meta.tone} size={42} shape="rounded" />
          <View style={styles.cardIdentity}>
            <Text variant="title3" numberOfLines={1}>
              {item.applicant_name || 'Applicant'}
            </Text>
            <Text variant="caption" color="muted" numberOfLines={1}>
              {item.case_number}
            </Text>
          </View>
          <Badge label={meta.label} tone={meta.tone} variant="soft" dot />
        </View>

        <View style={styles.meta}>
          <Badge label={item.case_type} tone="neutral" variant="outline" icon="albums-outline" />
          <Badge label={item.priority} tone={priorityTone} variant="soft" icon="flag-outline" />
          <Text variant="micro" color="subtle" style={styles.metaTime}>
            {formatRelativeTime(new Date(item.created_at).getTime())}
          </Text>
        </View>

        <Divider spacingY="md" />

        <View style={styles.actions}>
          <Pressable
            onPress={() => sendEApplicationLink(item)}
            disabled={sending}
            pressedScale={0.97}
            accessibilityRole="button"
            accessibilityLabel={`Send e-application link to ${item.applicant_name}`}
            accessibilityState={{ disabled: sending, busy: sending }}
            style={[
              styles.action,
              { backgroundColor: colors.tone.brand.soft, borderColor: colors.tone.brand.softBorder },
              sending ? styles.actionBusy : null,
            ]}
          >
            <Ionicons
              name={sending ? 'hourglass-outline' : 'link-outline'}
              size={15}
              color={colors.tone.brand.on}
            />
            <Text variant="captionStrong" style={{ color: colors.tone.brand.on }} numberOfLines={1}>
              {sending ? 'Generating…' : 'E-Application'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() =>
              navigation.navigate('AgentConfidentialReport', {
                caseId: item.id,
                applicantName: item.applicant_name,
              })
            }
            pressedScale={0.97}
            accessibilityRole="button"
            accessibilityLabel={`File the agent's confidential report for ${item.applicant_name}`}
            style={[
              styles.action,
              { backgroundColor: colors.surfaceSunken, borderColor: colors.border },
            ]}
          >
            <Ionicons name="lock-closed-outline" size={15} color={colors.textMuted} />
            <Text variant="captionStrong" color="muted" numberOfLines={1}>
              File ACR
            </Text>
          </Pressable>
        </View>
      </Card>
    );
  };

  const gridColumns = viewMode === 'list' && !isCompact ? columns(320) : 1;

  return (
    <>
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader
          title="Cases"
          subtitle={
            loading ? 'Loading…' : `${cases.length} ${cases.length === 1 ? 'case' : 'cases'} in underwriting`
          }
          leading="menu"
        >
          <View style={styles.controls}>
            <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Ionicons name="search" size={18} color={colors.textSubtle} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search by case number or applicant…"
                placeholderTextColor={colors.textSubtle}
                style={[styles.searchInput, typography.body, { color: colors.text }]}
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel="Search cases"
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
          title="Could not refresh cases"
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
            const items = filtered.filter((c) => column.statuses.includes((c.status ?? '').toUpperCase()));
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
                      <Ionicons name="folder-outline" size={20} color={colors.textSubtle} />
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
          key={`cases-${gridColumns}`}
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
              icon={search ? 'search-outline' : 'folder-open-outline'}
              title={search ? 'No matching cases' : 'No cases yet'}
              description={
                search
                  ? 'Try a different case number or applicant name.'
                  : 'Cases are created when a lead is ready for underwriting.'
              }
              actionLabel={search ? 'Clear search' : 'New case'}
              onAction={search ? () => setSearch('') : () => navigation.navigate('AddCase')}
            />
          }
        />
      )}

      <Fab
        icon="add"
        onPress={() => navigation.navigate('AddCase')}
        accessibilityLabel="Create a new case"
      />
    </Screen>

    <LinkShareSheet
      visible={!!eAppLink}
      onClose={() => setEAppLink(null)}
      title="E-Application link ready"
      subtitle={eAppLink ? `For ${eAppLink.applicantName}` : undefined}
      url={eAppLink?.url ?? ''}
      onCopied={() => toast('Link copied', { tone: 'success', icon: 'copy-outline' })}
    />
    </>
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
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  metaTime: {
    marginLeft: 'auto',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
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
  actionBusy: {
    opacity: 0.7,
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
