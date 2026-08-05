import React, { useMemo, useState, useCallback } from 'react';
import { View, StyleSheet, SectionList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { useResponsive } from '../hooks/useResponsive';
import { useNotifications } from '../notifications/NotificationContext';
import {
  AppNotification,
  NOTIFICATION_PRESETS,
  formatRelativeTime,
} from '../notifications/types';
import {
  Screen,
  ScreenHeader,
  Text,
  Pressable,
  EmptyState,
  ConfirmDialog,
  Badge,
} from '../components/ui';

type Filter = 'all' | 'unread';

/** Groups the feed the way people scan it: today, yesterday, then by date. */
const bucketFor = (timestamp: number, now: number): string => {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - 86_400_000;
  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfYesterday) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
};

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const { gutter } = useResponsive();
  const navigation = useNavigation<any>();
  const { notifications, unreadCount, markRead, markAllRead, remove, clearAll } = useNotifications();

  const [filter, setFilter] = useState<Filter>('all');
  const [confirmClear, setConfirmClear] = useState(false);

  const sections = useMemo(() => {
    const now = Date.now();
    const visible = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

    const grouped = new Map<string, AppNotification[]>();
    for (const item of visible) {
      const key = bucketFor(item.createdAt, now);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }
    // `notifications` is already newest-first, so insertion order is correct.
    return Array.from(grouped, ([title, data]) => ({ title, data }));
  }, [notifications, filter]);

  const openNotification = useCallback(
    (item: AppNotification) => {
      markRead(item.id);
      if (item.target) {
        navigation.navigate(item.target.screen, item.target.params);
      }
    },
    [markRead, navigation]
  );

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader
          title="Notifications"
          subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'You are all caught up'}
          actions={
            notifications.length > 0
              ? [
                  {
                    icon: 'checkmark-done-outline',
                    onPress: markAllRead,
                    accessibilityLabel: 'Mark all as read',
                  },
                  {
                    icon: 'trash-outline',
                    onPress: () => setConfirmClear(true),
                    accessibilityLabel: 'Clear all notifications',
                  },
                ]
              : []
          }
        >
          <View style={styles.filters}>
            {(['all', 'unread'] as Filter[]).map((value) => {
              const active = filter === value;
              const count = value === 'unread' ? unreadCount : notifications.length;
              return (
                <Pressable
                  key={value}
                  onPress={() => setFilter(value)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={value === 'all' ? 'All notifications' : 'Unread notifications'}
                  pressedScale={0.96}
                  style={[
                    styles.filterChip,
                    {
                      backgroundColor: active ? colors.tone.brand.solid : colors.surface,
                      borderColor: active ? colors.tone.brand.solid : colors.border,
                    },
                  ]}
                >
                  <Text
                    variant="captionStrong"
                    style={{ color: active ? colors.tone.brand.onSolid : colors.textMuted }}
                  >
                    {value === 'all' ? 'All' : 'Unread'} · {count}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScreenHeader>
      }
    >
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[
          styles.list,
          { paddingHorizontal: gutter },
          sections.length === 0 ? styles.listEmpty : null,
        ]}
        showsVerticalScrollIndicator={false}
        renderSectionHeader={({ section }) => (
          <Text variant="overline" color="subtle" uppercase style={styles.sectionHeader}>
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <NotificationRow
            item={item}
            onPress={() => openNotification(item)}
            onDismiss={() => remove(item.id)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={filter === 'unread' ? 'checkmark-done-outline' : 'notifications-off-outline'}
            title={filter === 'unread' ? 'Nothing unread' : 'No notifications yet'}
            description={
              filter === 'unread'
                ? 'Every notification has been read. New activity will appear here.'
                : 'When a lead is added, reassigned, or changes stage — in this app or in the portal — it shows up here.'
            }
            actionLabel={filter === 'unread' ? 'Show all' : undefined}
            onAction={filter === 'unread' ? () => setFilter('all') : undefined}
          />
        }
      />

      <ConfirmDialog
        visible={confirmClear}
        title="Clear all notifications?"
        message="This removes the whole history from this device. It does not change any lead."
        confirmLabel="Clear all"
        tone="danger"
        icon="trash-outline"
        onConfirm={() => {
          clearAll();
          setConfirmClear(false);
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </Screen>
  );
}

function NotificationRow({
  item,
  onPress,
  onDismiss,
}: {
  item: AppNotification;
  onPress: () => void;
  onDismiss: () => void;
}) {
  const { colors, shadow } = useTheme();
  const preset = NOTIFICATION_PRESETS[item.kind] ?? NOTIFICATION_PRESETS.generic;
  const tone = colors.tone[preset.tone];

  return (
    <Pressable
      onPress={onPress}
      pressedScale={0.99}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${item.body ?? ''} ${formatRelativeTime(item.createdAt)}`}
      style={[
        styles.row,
        {
          backgroundColor: colors.surface,
          // A tinted left edge marks unread without relying on colour alone —
          // the bold title carries the same signal.
          borderColor: item.read ? colors.border : tone.softBorder,
        },
        shadow(item.read ? 0 : 1),
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: tone.soft, borderColor: tone.softBorder }]}>
        <Ionicons name={preset.icon} size={18} color={tone.on} />
      </View>

      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text variant={item.read ? 'callout' : 'calloutStrong'} numberOfLines={2} style={styles.rowTitle}>
            {item.title}
          </Text>
          {!item.read ? <View style={[styles.unreadDot, { backgroundColor: tone.solid }]} /> : null}
        </View>

        {item.body ? (
          <Text variant="caption" color="muted" numberOfLines={2} style={styles.rowText}>
            {item.body}
          </Text>
        ) : null}

        <View style={styles.rowMeta}>
          <Text variant="micro" color="subtle">
            {formatRelativeTime(item.createdAt)}
          </Text>
          {item.actorName ? (
            <Badge label={item.actorName} tone={preset.tone} variant="soft" icon="person-outline" />
          ) : null}
        </View>
      </View>

      <Pressable
        onPress={onDismiss}
        pressedScale={0.88}
        accessibilityRole="button"
        accessibilityLabel={`Dismiss ${item.title}`}
        style={styles.dismiss}
      >
        <Ionicons name="close" size={16} color={colors.textSubtle} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  list: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl,
    gap: spacing.sm,
  },
  listEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  sectionHeader: {
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  rowTitle: {
    flex: 1,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
  },
  rowText: {
    marginTop: spacing.xxs,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  dismiss: {
    padding: spacing.xs,
  },
});
