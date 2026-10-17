import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme, ThemeType } from '../theme/ThemeContext';
import { useLocale } from '../i18n/LocaleContext';
import { LOCALES, LOCALE_LABELS, Locale } from '../i18n/config';
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
  const { locale, setLocale, restartRequired, t } = useLocale();
  const navigation = useNavigation<any>();
  const { user, signOut } = useSession();
  const { unreadCount, notifications, clearAll, toast } = useNotifications();

  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <Screen
      header={<ScreenHeader title={t('settings.title')} leading="menu" />}
    >
      {/* ── Account ───────────────────────────────────────────────────────── */}

      <Card padding="xl" style={styles.profile}>
        <View style={styles.profileTop}>
          <Avatar name={user?.fullName} size={60} tone="brand" />
          <View style={styles.profileText}>
            <Text variant="title2" numberOfLines={1}>
              {user?.fullName ?? t('common.agent')}
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

      <SectionHeader title={t('settings.account')} icon="person-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow title={t('settings.fullName')} value={user?.fullName ?? '—'} icon="person-outline" tone="brand" />
        <Divider spacingY="none" />
        <ListRow title={t('settings.email')} value={user?.email ?? '—'} icon="mail-outline" tone="info" />
        <Divider spacingY="none" />
        <ListRow title={t('settings.role')} value={user?.role ?? '—'} icon="shield-outline" tone="accent" />
        <Divider spacingY="none" />
        <ListRow
          title={t('settings.leadVisibility')}
          value={user && user.role !== 'Agent' ? t('settings.allLeads') : t('settings.myLeads')}
          subtitle={
            user && user.role !== 'Agent'
              ? t('settings.seesAllLeads')
              : t('settings.seesOwnLeads')
          }
          icon="eye-outline"
          tone="neutral"
        />
      </Card>

      {/* ── Appearance ────────────────────────────────────────────────────── */}

      <SectionHeader title={t('settings.appearance')} icon="color-palette-outline" />
      <Card padding="lg" style={styles.section}>
        <Text variant="captionStrong" color="muted" style={styles.controlLabel}>
          {t('settings.theme')}
        </Text>
        <SegmentedControl<ThemeType>
          segments={[
            { value: 'light', label: t('settings.light'), icon: 'sunny-outline' },
            { value: 'dark', label: t('settings.dark'), icon: 'moon-outline' },
            { value: 'system', label: t('settings.system'), icon: 'phone-portrait-outline' },
          ]}
          value={theme}
          onChange={setTheme}
        />
        <Text variant="caption" color="subtle" style={styles.controlHelp}>
          {theme === 'system'
            ? t('settings.themeSystemHelp')
            : theme === 'light' ? t('settings.themeLightHelp') : t('settings.themeDarkHelp')}
        </Text>

        <Text variant="captionStrong" color="muted" style={[styles.controlLabel, styles.languageLabel]}>
          {t('settings.language')}
        </Text>
        <SegmentedControl<Locale>
          segments={LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] }))}
          value={locale}
          onChange={setLocale}
        />
        <Text variant="caption" color={restartRequired ? 'muted' : 'subtle'} style={styles.controlHelp}>
          {restartRequired ? t('settings.restartRequired') : t('settings.languageHelp')}
        </Text>
      </Card>

      {/* ── Notifications ─────────────────────────────────────────────────── */}

      <SectionHeader title={t('settings.notifications')} icon="notifications-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow
          title={t('settings.notificationCentre')}
          subtitle={
            unreadCount > 0
              ? t('settings.unreadOf', { unread: unreadCount, total: notifications.length })
              : t('settings.inHistory', { total: notifications.length })
          }
          icon="notifications-outline"
          tone="warning"
          onPress={() => navigation.navigate('Notifications')}
        />
        <Divider spacingY="none" />
        <ListRow
          title={t('settings.clearHistory')}
          subtitle={t('settings.clearHistoryHelp')}
          icon="trash-outline"
          destructive
          disabled={notifications.length === 0}
          onPress={() => setConfirmClear(true)}
        />
      </Card>

      {/* ── Support ───────────────────────────────────────────────────────── */}

      <SectionHeader title={t('settings.support')} icon="help-buoy-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow
          title={t('settings.help')}
          subtitle={t('settings.helpSubtitle')}
          icon="help-buoy-outline"
          tone="info"
          onPress={() => navigation.navigate('Help')}
        />
        <Divider spacingY="none" />
        <ListRow
          title={t('settings.about')}
          subtitle={t('settings.aboutSubtitle')}
          icon="information-circle-outline"
          tone="neutral"
          onPress={() => navigation.navigate('About')}
        />
      </Card>

      <Card padding="md" style={styles.section}>
        <ListRow
          title={t('signOut.action')}
          subtitle={t('settings.signOutSubtitle')}
          icon="log-out-outline"
          destructive
          onPress={() => setConfirmSignOut(true)}
        />
      </Card>

      <Text variant="caption" color="subtle" align="center" style={styles.footer}>
        {t('settings.footer')}
      </Text>

      <ConfirmDialog
        visible={confirmClear}
        title={t('settings.clearConfirmTitle')}
        message={t('settings.clearConfirmMessage')}
        confirmLabel={t('common.clear')}
        tone="danger"
        icon="trash-outline"
        onConfirm={() => {
          clearAll();
          setConfirmClear(false);
          toast(t('settings.cleared'), { tone: 'neutral', icon: 'checkmark-circle' });
        }}
        onCancel={() => setConfirmClear(false)}
      />

      <ConfirmDialog
        visible={confirmSignOut}
        title={t('signOut.confirmTitle')}
        message={t('signOut.confirmMessage')}
        confirmLabel={t('signOut.action')}
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
  languageLabel: {
    marginTop: spacing.xl,
  },
  footer: {
    marginTop: spacing.sm,
    marginBottom: spacing.xxl,
  },
});
