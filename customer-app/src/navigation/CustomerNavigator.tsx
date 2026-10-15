import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { CustomerProvider, useCustomer } from '../context/CustomerContext';
import { t } from '../i18n/t';
import DashboardScreen from '../screens/customer/DashboardScreen';
import PoliciesScreen from '../screens/customer/PoliciesScreen';
import PaymentsScreen from '../screens/customer/PaymentsScreen';
import ClaimsScreen from '../screens/customer/ClaimsScreen';
import MoreScreen from '../screens/customer/MoreScreen';
import PolicyDetailScreen from '../screens/customer/PolicyDetailScreen';
import ClaimDetailScreen from '../screens/customer/ClaimDetailScreen';
import NewClaimScreen from '../screens/customer/NewClaimScreen';
import DocumentsScreen from '../screens/customer/DocumentsScreen';
import NotificationsScreen from '../screens/customer/NotificationsScreen';
import ProfileScreen from '../screens/customer/ProfileScreen';
import SupportScreen from '../screens/customer/SupportScreen';
import TicketDetailScreen from '../screens/customer/TicketDetailScreen';
import { FamilyDetailScreen, FamilyListScreen } from '../screens/customer/FamilyScreens';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  Home: ['home-outline', 'home'], Policies: ['documents-outline', 'documents'], Payments: ['card-outline', 'card'],
  Claims: ['medkit-outline', 'medkit'], More: ['menu-outline', 'menu'],
};

function Tabs() {
  const { colors } = useTheme();
  const { unread } = useCustomer();
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      headerShown: false,
      tabBarActiveTintColor: colors.primary,
      tabBarInactiveTintColor: colors.textMuted,
      tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border },
      tabBarIcon: ({ focused, color, size }) => <Ionicons name={ICONS[route.name][focused ? 1 : 0]} size={size} color={color} />,
    })}>
      <Tab.Screen name="Home" component={DashboardScreen} options={{ title: t('nav.dashboard') }} />
      <Tab.Screen name="Policies" component={PoliciesScreen} options={{ title: 'Policies' }} />
      <Tab.Screen name="Payments" component={PaymentsScreen} options={{ title: 'Payments' }} />
      <Tab.Screen name="Claims" component={ClaimsScreen} options={{ title: t('nav.claims') }} />
      <Tab.Screen name="More" component={MoreScreen} options={{ title: 'More', tabBarBadge: unread > 0 ? unread : undefined }} />
    </Tab.Navigator>
  );
}

/** The signed-in policyholder's whole app. Everything the web portal's sidebar offers is reachable from the tabs or More. */
export default function CustomerNavigator() {
  return (
    <CustomerProvider>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="PolicyDetail" component={PolicyDetailScreen} />
        <Stack.Screen name="ClaimDetail" component={ClaimDetailScreen} />
        <Stack.Screen name="NewClaim" component={NewClaimScreen} />
        <Stack.Screen name="Documents" component={DocumentsScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
        <Stack.Screen name="Profile" component={ProfileScreen} />
        <Stack.Screen name="Support" component={SupportScreen} />
        <Stack.Screen name="TicketDetail" component={TicketDetailScreen} />
        <Stack.Screen name="FamilyList" component={FamilyListScreen} />
        <Stack.Screen name="FamilyDetail" component={FamilyDetailScreen} />
      </Stack.Navigator>
    </CustomerProvider>
  );
}
