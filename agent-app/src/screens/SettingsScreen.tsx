import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme, ThemeType } from '../theme/ThemeContext';
import { spacing } from '../theme/tokens';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import {
  Screen,
  ScreenHeader,
  Card,
  Text,
  Avatar,
  Badge,
  ListRow,
  Divider,
  SectionHeader,
  SegmentedControl,
  ConfirmDialog,
} from '../components/ui';

export default function SettingsScreen() {
  const { theme, setTheme, colors } = useTheme();
  const navigation = useNavigation<any>();
  const { user, signOut } = useSession();
  const { unreadCount, notifications, clearAll, toast } = useNotifications();

  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <Screen
      header={<ScreenHeader title="Settings" leading="menu" />}
    >
      {/* ── Account ───────────────────────────────────────────────────────── */}

      <Card padding="xl" style={styles.profile}>
        <View style={styles.profileTop}>
          <Avatar name={user?.fullName} size={60} tone="brand" />
          <View style={styles.profileText}>
            <Text variant="title2" numberOfLines={1}>
              {user?.fullName ?? 'Agent'}
            </Text>
            <Text variant="caption" color="muted" numberOfLines={1}>
              {user?.email ?? '—'}
            </Text>
            {user ? (
              <Badge
                label={user.role}
                tone={user.role === 'Agent' ? 'brand' : 'accent'}
                variant="soft"
                icon="ribbon-outline"
                style={styles.roleBadge}
              />
            ) : null}
          </View>
        </View>
      </Card>

      <SectionHeader title="Account" icon="person-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow title="Full name" value={user?.fullName ?? '—'} icon="person-outline" tone="brand" />
        <Divider spacingY="none" />
        <ListRow title="Email" value={user?.email ?? '—'} icon="mail-outline" tone="info" />
        <Divider spacingY="none" />
        <ListRow title="Role" value={user?.role ?? '—'} icon="shield-outline" tone="accent" />
        <Divider spacingY="none" />
        <ListRow
          title="Lead visibility"
          value={user && user.role !== 'Agent' ? 'All leads' : 'My leads'}
          subtitle={
            user && user.role !== 'Agent'
              ? 'You see every lead in the tenant.'
              : 'You see only the leads assigned to you.'
          }
          icon="eye-outline"
          tone="neutral"
        />
      </Card>

      {/* ── Appearance ────────────────────────────────────────────────────── */}

      <SectionHeader title="Appearance" icon="color-palette-outline" />
      <Card padding="lg" style={styles.section}>
        <Text variant="captionStrong" color="muted" style={styles.controlLabel}>
          Theme
        </Text>
        <SegmentedControl<ThemeType>
          segments={[
            { value: 'light', label: 'Light', icon: 'sunny-outline' },
            { value: 'dark', label: 'Dark', icon: 'moon-outline' },
            { value: 'system', label: 'System', icon: 'phone-portrait-outline' },
          ]}
          value={theme}
          onChange={setTheme}
        />
        <Text variant="caption" color="subtle" style={styles.controlHelp}>
          {theme === 'system'
            ? 'Follows your device setting automatically.'
            : `Always uses the ${theme} theme, whatever your device is set to.`}
        </Text>
      </Card>

      {/* ── Notifications ─────────────────────────────────────────────────── */}

      <SectionHeader title="Notifications" icon="notifications-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow
          title="Notification centre"
          subtitle={
            unreadCount > 0
              ? `${unreadCount} unread of ${notifications.length}`
              : `${notifications.length} in history`
          }
          icon="notifications-outline"
          tone="warning"
          onPress={() => navigation.navigate('Notifications')}
        />
        <Divider spacingY="none" />
        <ListRow
          title="Clear notification history"
          subtitle="Removes the local feed. No leads are affected."
          icon="trash-outline"
          destructive
          disabled={notifications.length === 0}
          onPress={() => setConfirmClear(true)}
        />
      </Card>

      {/* ── Support ───────────────────────────────────────────────────────── */}

      <SectionHeader title="Support" icon="help-buoy-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow
          title="Help & support"
          subtitle="Contact the internal IT team"
          icon="help-buoy-outline"
          tone="info"
          onPress={() => navigation.navigate('Help')}
        />
        <Divider spacingY="none" />
        <ListRow
          title="About"
          subtitle="Version and build information"
          icon="information-circle-outline"
          tone="neutral"
          onPress={() => navigation.navigate('About')}
        />
      </Card>

      <Card padding="md" style={styles.section}>
        <ListRow
          title="Sign out"
          subtitle="You will need to sign in again"
          icon="log-out-outline"
          destructive
          onPress={() => setConfirmSignOut(true)}
        />
      </Card>

      <Text variant="caption" color="subtle" align="center" style={styles.footer}>
        Rizvi Agent Portal · v1.0.0
      </Text>

      <ConfirmDialog
        visible={confirmClear}
        title="Clear notification history?"
        message="This removes the feed from this device only. No lead or case is changed."
        confirmLabel="Clear"
        tone="danger"
        icon="trash-outline"
        onConfirm={() => {
          clearAll();
          setConfirmClear(false);
          toast('Notification history cleared', { tone: 'neutral', icon: 'checkmark-circle' });
        }}
        onCancel={() => setConfirmClear(false)}
      />

      <ConfirmDialog
        visible={confirmSignOut}
        title="Sign out?"
        message="You will need your email and password to sign back in."
        confirmLabel="Sign out"
        tone="danger"
        icon="log-out-outline"
        onConfirm={() => {
          setConfirmSignOut(false);
          // The root navigator swaps to the auth stack off `isAuthenticated`.
          signOut();
        }}
        onCancel={() => setConfirmSignOut(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: {
    marginTop: spacing.lg,
    marginBottom: spacing.xxl,
  },
  profileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  profileText: {
    flex: 1,
  },
  roleBadge: {
    marginTop: spacing.sm,
  },
  section: {
    marginBottom: spacing.xxl,
  },
  controlLabel: {
    marginBottom: spacing.sm,
  },
  controlHelp: {
    marginTop: spacing.md,
  },
  footer: {
    marginTop: spacing.sm,
    marginBottom: spacing.xxl,
  },
});
