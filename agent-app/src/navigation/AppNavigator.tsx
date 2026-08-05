import React, { useMemo } from 'react';
import { View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  Theme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '../theme/ThemeContext';
import { typography } from '../theme/tokens';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { LeadSyncProvider } from '../sync/LeadSyncProvider';
import ToastHost from '../notifications/ToastHost';
import NotificationPopup from '../notifications/NotificationPopup';

import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import LeadsScreen from '../screens/LeadsScreen';
import LeadDetailScreen from '../screens/LeadDetailScreen';
import AddLeadScreen from '../screens/AddLeadScreen';
import SelectLeadCategoryScreen from '../screens/SelectLeadCategoryScreen';
import ProposalsScreen from '../screens/ProposalsScreen';
import AddProposalScreen from '../screens/AddProposalScreen';
import CasesScreen from '../screens/CasesScreen';
import AddCaseScreen from '../screens/AddCaseScreen';
import UnderwritingScreen from '../screens/UnderwritingScreen';
import PrePolicyIssuanceScreen from '../screens/PrePolicyIssuanceScreen';
import PostPolicyIssuanceScreen from '../screens/PostPolicyIssuanceScreen';
import ChatScreen from '../screens/ChatScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AboutScreen from '../screens/AboutScreen';
import HelpScreen from '../screens/HelpScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import AgentConfidentialReportScreen from '../screens/AgentConfidentialReportScreen';
import CustomDrawer from './CustomDrawer';

// ── Route types ──────────────────────────────────────────────────────────────

export type RootStackParamList = {
  Main: undefined;
  SelectLeadCategory: undefined;
  AddLead: {
    type?: 'INDIVIDUAL' | 'FAMILY' | 'CORPORATE';
    category?: 'quick' | 'normal';
  } | undefined;
  LeadDetail: { leadId: string };
  AddProposal: undefined;
  AddCase: undefined;
  Underwriting: undefined;
  PrePolicyIssuance: undefined;
  PostPolicyIssuance: undefined;
  Notifications: undefined;
  AgentConfidentialReport: { caseId: string; applicantName?: string };
};

export type AuthStackParamList = {
  Login: undefined;
};

export type MainDrawerParamList = {
  DashboardTabs: undefined;
  Settings: undefined;
  About: undefined;
  Help: undefined;
};

export type MainTabParamList = {
  Dashboard: undefined;
  Leads: undefined;
  Proposals: undefined;
  Cases: undefined;
  Chat: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const Drawer = createDrawerNavigator<MainDrawerParamList>();

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TAB_ICONS: Record<keyof MainTabParamList, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  Dashboard: ['home', 'home-outline'],
  Leads: ['people', 'people-outline'],
  Proposals: ['document-text', 'document-text-outline'],
  Cases: ['folder-open', 'folder-open-outline'],
  Chat: ['sparkles', 'sparkles-outline'],
};

function MainTabs() {
  const { colors } = useTheme();
  const { unreadCount } = useNotifications();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSubtle,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          // Removing the default elevation stops Android drawing a hard grey
          // band over the themed border.
          elevation: 0,
          height: Platform.OS === 'ios' ? 84 : 62,
          paddingTop: 6,
          paddingBottom: Platform.OS === 'ios' ? 28 : 8,
        },
        tabBarLabelStyle: {
          ...typography.micro,
          marginTop: 2,
        },
        tabBarIcon: ({ focused, color, size }) => {
          const [active, inactive] = TAB_ICONS[route.name];
          return <Ionicons name={focused ? active : inactive} size={size - 2} color={color} />;
        },
        tabBarBadgeStyle: {
          backgroundColor: colors.tone.danger.solid,
          color: colors.tone.danger.onSolid,
          fontSize: 10,
          fontWeight: '800',
          minWidth: 18,
          lineHeight: 15,
        },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen
        name="Leads"
        component={LeadsScreen}
        // Surfacing the unread count on Leads is honest: every notification the
        // app raises today concerns a lead.
        options={{ tabBarBadge: unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : undefined }}
      />
      <Tab.Screen name="Proposals" component={ProposalsScreen} />
      <Tab.Screen name="Cases" component={CasesScreen} />
      <Tab.Screen name="Chat" component={ChatScreen} options={{ title: 'Copilot' }} />
    </Tab.Navigator>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────────

function MainDrawer() {
  const { colors } = useTheme();

  return (
    <Drawer.Navigator
      useLegacyImplementation={false}
      drawerContent={(props) => <CustomDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        // Edge-swipe would fight the horizontal scroll views on the Leads
        // board, so the drawer opens from its header button only.
        swipeEnabled: false,
        drawerType: 'front',
        drawerStyle: {
          backgroundColor: colors.surface,
          width: 300,
        },
        overlayColor: colors.overlay,
      }}
    >
      <Drawer.Screen name="DashboardTabs" component={MainTabs} options={{ title: 'Dashboard' }} />
      <Drawer.Screen name="Settings" component={SettingsScreen} />
      <Drawer.Screen name="About" component={AboutScreen} />
      <Drawer.Screen name="Help" component={HelpScreen} options={{ title: 'Help & Support' }} />
    </Drawer.Navigator>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

function AuthFlow() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
    </AuthStack.Navigator>
  );
}

function AppFlow() {
  return (
    <LeadSyncProvider>
      <RootStack.Navigator
        screenOptions={{
          headerShown: false,
          // Screens own their headers via `ScreenHeader`, so the native header
          // is off everywhere; these options control transitions only.
          animation: 'slide_from_right',
          gestureEnabled: true,
          animationDuration: 260,
        }}
      >
        <RootStack.Screen name="Main" component={MainDrawer} />

        <RootStack.Screen name="LeadDetail" component={LeadDetailScreen} />
        <RootStack.Screen
          name="SelectLeadCategory"
          component={SelectLeadCategoryScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <RootStack.Screen name="AddLead" component={AddLeadScreen} />
        <RootStack.Screen name="AddProposal" component={AddProposalScreen} />
        <RootStack.Screen name="AddCase" component={AddCaseScreen} />
        <RootStack.Screen name="Underwriting" component={UnderwritingScreen} />
        <RootStack.Screen name="PrePolicyIssuance" component={PrePolicyIssuanceScreen} />
        <RootStack.Screen name="PostPolicyIssuance" component={PostPolicyIssuanceScreen} />
        <RootStack.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <RootStack.Screen name="AgentConfidentialReport" component={AgentConfidentialReportScreen} />
      </RootStack.Navigator>

      {/* Rendered as siblings of the navigator so they float above every
          screen without each screen having to host them. */}
      <ToastHost />
      <NotificationPopup />
    </LeadSyncProvider>
  );
}

export default function AppNavigator() {
  const { colors, isDark } = useTheme();
  const { isAuthenticated, initialising } = useSession();

  // Feeding the palette into React Navigation stops the white flash between
  // screen transitions in dark mode.
  const navTheme = useMemo<Theme>(() => {
    const base = isDark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.primary,
        background: colors.background,
        card: colors.surface,
        text: colors.text,
        border: colors.border,
        notification: colors.tone.danger.solid,
      },
    };
  }, [isDark, colors]);

  if (initialising) {
    return (
      <View style={[styles.splash, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {isAuthenticated ? <AppFlow /> : <AuthFlow />}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
