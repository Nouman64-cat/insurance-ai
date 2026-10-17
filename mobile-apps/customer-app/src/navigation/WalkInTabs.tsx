import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { t } from '../i18n/t';
import PlansScreen from '../screens/walkin/PlansScreen';
import ApplyScreen from '../screens/walkin/ApplyScreen';
import StatusScreen from '../screens/walkin/StatusScreen';
import WalkInProfileScreen from '../screens/walkin/WalkInProfileScreen';

const Tab = createBottomTabNavigator();
const ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  Plans: ['shield-outline', 'shield'], Apply: ['create-outline', 'create'], Status: ['pulse-outline', 'pulse'], Profile: ['person-outline', 'person'],
};

/** The prospect's whole app: only what the web portal's /walk-in section offers. */
export default function WalkInTabs() {
  const { colors } = useTheme();
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      headerShown: false,
      tabBarActiveTintColor: colors.primary,
      tabBarInactiveTintColor: colors.textMuted,
      tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border },
      tabBarIcon: ({ focused, color, size }) => <Ionicons name={ICONS[route.name][focused ? 1 : 0]} size={size} color={color} />,
    })}>
      <Tab.Screen name="Plans" component={PlansScreen} options={{ title: t('walkin.nav.plans').replace('Explore Insurance ', '') }} />
      <Tab.Screen name="Apply" component={ApplyScreen} options={{ title: t('walkin.nav.apply') }} />
      <Tab.Screen name="Status" component={StatusScreen} options={{ title: t('walkin.nav.status') }} />
      <Tab.Screen name="Profile" component={WalkInProfileScreen} options={{ title: t('walkin.nav.profile') }} />
    </Tab.Navigator>
  );
}
