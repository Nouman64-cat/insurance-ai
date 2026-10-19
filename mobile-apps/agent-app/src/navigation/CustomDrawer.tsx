import React, { useState } from 'react';
import { View, StyleSheet, Image } from 'react-native';
import { DrawerContentScrollView, DrawerContentComponentProps } from '@react-navigation/drawer';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { useLocale } from '../i18n/LocaleContext';
import { spacing, radii } from '../theme/tokens';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { Text, Pressable, Avatar, Badge, ConfirmDialog, Divider } from '../components/ui';

const LOGO = require('../../assets/logo-horizontal.png');

interface DrawerLink {
  route: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Nested screens live on the root stack, not the drawer navigator. */
  onRootStack?: boolean;
  badge?: number;
}

export default function CustomDrawer(props: DrawerContentComponentProps) {
  const { colors, shadow } = useTheme();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useSession();
  const { unreadCount } = useNotifications();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const activeRoute = props.state.routeNames[props.state.index];

  const links: DrawerLink[] = [
    { route: 'DashboardTabs', label: t('nav.dashboard'), icon: 'grid-outline' },
    { route: 'Notifications', label: t('nav.notifications'), icon: 'notifications-outline', onRootStack: true, badge: unreadCount },
    { route: 'Underwriting', label: t('nav.underwriting'), icon: 'shield-checkmark-outline', onRootStack: true },
    { route: 'PolicyIssuance', label: t('nav.policyIssuance'), icon: 'ribbon-outline', onRootStack: true },
    { route: 'Commission', label: t('nav.commission'), icon: 'cash-outline', onRootStack: true },
    { route: 'SECPRateCard', label: t('nav.secpCommissionTypes'), icon: 'document-text-outline', onRootStack: true },
    { route: 'Settings', label: t('nav.settings'), icon: 'settings-outline' },
    { route: 'About', label: t('nav.about'), icon: 'information-circle-outline' },
    { route: 'Help', label: t('nav.help'), icon: 'help-buoy-outline' },
  ];

  const go = (link: DrawerLink) => {
    props.navigation.closeDrawer();
    // React Navigation bubbles an unhandled `navigate` up to the parent
    // navigator, so this reaches both the drawer's own screens and the
    // root-stack screens it is nested inside.
    props.navigation.navigate(link.route as never);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.header, { paddingTop: insets.top + spacing.xl }]}>
          <View style={[styles.logoPlate, { backgroundColor: '#FFFFFF' }, shadow(0)]}>
            <Image source={LOGO} style={styles.logo} resizeMode="contain" accessibilityLabel="GetInsuredAI" />
          </View>

          <View style={styles.identity}>
            <Avatar name={user?.fullName} size={48} tone="brand" />
            <View style={styles.identityText}>
              <Text variant="title3" numberOfLines={1}>
                {user?.fullName ?? t('common.agent')}
              </Text>
              <Text variant="caption" color="muted" numberOfLines={1}>
                {user?.email ?? ''}
              </Text>
            </View>
          </View>

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

        <Divider spacingY="md" />

        <View style={styles.menu}>
          {links.map((link) => {
            const active = !link.onRootStack && activeRoute === link.route;
            return (
              <Pressable
                key={link.route}
                onPress={() => go(link)}
                accessibilityRole="button"
                accessibilityLabel={link.label}
                accessibilityState={{ selected: active }}
                pressedScale={0.98}
                style={[
                  styles.item,
                  active ? { backgroundColor: colors.tone.brand.soft } : null,
                ]}
              >
                <Ionicons
                  name={link.icon}
                  size={21}
                  color={active ? colors.tone.brand.on : colors.textMuted}
                />
                <Text
                  variant={active ? 'bodyStrong' : 'body'}
                  numberOfLines={1}
                  style={[styles.itemLabel, active ? { color: colors.tone.brand.on } : null]}
                >
                  {link.label}
                </Text>
                {link.badge ? (
                  <View style={[styles.itemBadge, { backgroundColor: colors.tone.danger.solid }]}>
                    <Text variant="micro" style={{ color: colors.tone.danger.onSolid }}>
                      {link.badge > 99 ? '99+' : link.badge}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </DrawerContentScrollView>

      <View
        style={[
          styles.footer,
          { borderTopColor: colors.border, paddingBottom: insets.bottom + spacing.lg },
        ]}
      >
        <Pressable
          onPress={() => setConfirmSignOut(true)}
          accessibilityRole="button"
          accessibilityLabel={t('signOut.action')}
          pressedScale={0.98}
          style={styles.item}
        >
          <Ionicons name="log-out-outline" size={21} color={colors.tone.danger.solid} />
          <Text variant="bodyStrong" style={[styles.itemLabel, { color: colors.tone.danger.on }]}>
            {t('signOut.action')}
          </Text>
        </Pressable>
      </View>

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    paddingTop: 0,
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },
  logoPlate: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    marginBottom: spacing.xl,
  },
  logo: {
    width: 192,
    height: 50,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  identityText: {
    flex: 1,
  },
  roleBadge: {
    marginTop: spacing.md,
  },
  menu: {
    paddingHorizontal: spacing.md,
    gap: spacing.xxs,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
  },
  itemLabel: {
    flex: 1,
  },
  itemBadge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radii.pill,
    alignItems: 'center',
  },
  footer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
