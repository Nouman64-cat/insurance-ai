import React, { useMemo, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '../theme/ThemeContext';
import { typography } from '../theme/tokens';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { LeadSyncProvider } from '../sync/LeadSyncProvider';
import ToastHost from '../notifications/ToastHost';
import NotificationPopup from '../notifications/NotificationPopup';
import AnimatedSplashScreen from '../components/ui/AnimatedSplashScreen';

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
import PolicyIssuanceScreen from '../screens/PolicyIssuanceScreen';
import CommissionScreen from '../screens/CommissionScreen';
import SECPRateCardScreen from '../screens/SECPRateCardScreen';
import ChatScreen from '../screens/ChatScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AboutScreen from '../screens/AboutScreen';
import HelpScreen from '../screens/HelpScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import AgentConfidentialReportScreen from '../screens/AgentConfidentialReportScreen';
import ReviewEApplicationScreen from '../screens/ReviewEApplicationScreen';
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
  PolicyIssuance: undefined;
  Commission: undefined;
  SECPRateCard: undefined;
  Notifications: undefined;
  AgentConfidentialReport: {
    caseId: string;
    applicantName?: string;
    /** Set when opened from the Copilot chat to fill a paused submit_agent_confidential_report
     * turn — called once, exactly once, with the outcome so the chat can resume itself. */
    onResolved?: (result: { success: boolean; message: string; status?: string }) => void;
  };
  ReviewEApplication: {
    caseId: string;
    applicantName?: string;
  };
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
  // Set when another screen (e.g. Pre-Underwriting) wants the composer
  // pre-filled with a specific command instead of starting from a blank chat.
  Chat: { prefillMessage?: string } | undefined;
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
  Chat: ['chatbubble-ellipses', 'chatbubble-ellipses-outline'],
};

function MainTabs() {
  const { colors } = useTheme();
  const { unreadCount } = useNotifications();
  const insets = useSafeAreaInsets();

  // Derived from the device's real bottom inset rather than a per-platform
  // constant: a fixed 84pt wastes a visible band on iPhones with a home button
  // (inset 0) and can clip on Android devices with gesture navigation.
  const barContentHeight = 56;
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'ios' ? 0 : 8);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        // The Chat tab's composer already handles the keyboard itself —
        // without this the bottom tab bar stays mounted and steals space
        // from it while typing.
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSubtle,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          // Removing the default elevation stops Android drawing a hard grey
          // band over the themed border.
          elevation: 0,
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
  const { width } = useResponsive();

  // A fixed width leaves only a sliver of the screen visible on a small phone
  // and looks lost on a tablet. Cap it so the underlying screen always stays
  // recognisable behind the scrim.
  const drawerWidth = Math.min(Math.round(width * 0.82), 340);

  return (
    <Drawer.Navigator
      drawerContent={(props) => <CustomDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        // Edge-swipe is the gesture users expect, but the Leads and Cases
        // boards scroll horizontally. Restricting the gesture to a narrow
        // strip at the screen edge gives both behaviours without conflict.
        swipeEnabled: true,
        swipeEdgeWidth: 24,
        drawerStyle: {
          backgroundColor: colors.surface,
          width: drawerWidth,
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
  const [showSplash, setShowSplash] = useState(true);

  return (
    <View style={{ flex: 1 }}>
      {showSplash ? (
        <AnimatedSplashScreen
          subtitle="Agent Portal"
          onFinish={() => setShowSplash(false)}
        />
      ) : null}
      <AuthStack.Navigator screenOptions={{ headerShown: false }}>
        <AuthStack.Screen name="Login" component={LoginScreen} />
      </AuthStack.Navigator>
    </View>
  );
}

function AppFlow() {
  const [showSplash, setShowSplash] = useState(true);

  return (
    <LeadSyncProvider>
      {showSplash ? (
        <AnimatedSplashScreen onFinish={() => setShowSplash(false)} />
      ) : null}
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
        <RootStack.Screen name="PolicyIssuance" component={PolicyIssuanceScreen} />
        <RootStack.Screen name="Commission" component={CommissionScreen} />
        <RootStack.Screen name="SECPRateCard" component={SECPRateCardScreen} />
        <RootStack.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <RootStack.Screen name="AgentConfidentialReport" component={AgentConfidentialReportScreen} />
        <RootStack.Screen name="ReviewEApplication" component={ReviewEApplicationScreen} />
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
