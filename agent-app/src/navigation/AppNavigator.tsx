import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import LeadsScreen from '../screens/LeadsScreen';
import AddLeadScreen from '../screens/AddLeadScreen';
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
import CustomDrawer from './CustomDrawer';
import AgentConfidentialReportScreen from '../screens/AgentConfidentialReportScreen';

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
  AddLead: { type?: 'INDIVIDUAL' | 'FAMILY' | 'CORPORATE', category?: 'quick' | 'normal' } | undefined;
  Proposals: undefined;
  AddProposal: undefined;
  Cases: undefined;
  AddCase: undefined;
  Underwriting: undefined;
  PrePolicyIssuance: undefined;
  PostPolicyIssuance: undefined;
  Chat: undefined;
  AgentConfidentialReport: { caseId: string; applicantName?: string };
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

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const Drawer = createDrawerNavigator<MainDrawerParamList>();

function MainTabs() {
  const { colors } = useTheme();
  
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'help';

          if (route.name === 'Dashboard') iconName = focused ? 'home' : 'home-outline';
          else if (route.name === 'Leads') iconName = focused ? 'people' : 'people-outline';
          else if (route.name === 'Proposals') iconName = focused ? 'document-text' : 'document-text-outline';
          else if (route.name === 'Cases') iconName = focused ? 'folder-open' : 'folder-open-outline';
          else if (route.name === 'Chat') iconName = focused ? 'chatbubbles' : 'chatbubbles-outline';

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        headerShown: false,
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Leads" component={LeadsScreen} />
      <Tab.Screen name="Proposals" component={ProposalsScreen} />
      <Tab.Screen name="Cases" component={CasesScreen} />
      <Tab.Screen name="Chat" component={ChatScreen} options={{ title: 'AI Copilot' }} />
    </Tab.Navigator>
  );
}

function MainDrawer() {
  const { colors, isDark } = useTheme();
  
  return (
    <Drawer.Navigator
      useLegacyImplementation={false}
      drawerContent={(props) => <CustomDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        swipeEnabled: false,
        drawerActiveBackgroundColor: isDark ? colors.border : '#eff6ff',
        drawerActiveTintColor: colors.primary,
        drawerInactiveTintColor: colors.text,
        drawerLabelStyle: { fontSize: 16, fontWeight: '500', marginLeft: -10 },
      }}
    >
      <Drawer.Screen 
        name="DashboardTabs" 
        component={MainTabs} 
        options={{ 
          title: 'Dashboard',
          drawerIcon: ({ color }) => <Ionicons name="home-outline" size={22} color={color} />
        }} 
      />
      <Drawer.Screen 
        name="Settings" 
        component={SettingsScreen} 
        options={{ 
          drawerIcon: ({ color }) => <Ionicons name="settings-outline" size={22} color={color} />
        }} 
      />
      <Drawer.Screen 
        name="About" 
        component={AboutScreen} 
        options={{ 
          drawerIcon: ({ color }) => <Ionicons name="information-circle-outline" size={22} color={color} />
        }} 
      />
      <Drawer.Screen 
        name="Help" 
        component={HelpScreen} 
        options={{ 
          title: 'Help & Support',
          drawerIcon: ({ color }) => <Ionicons name="help-circle-outline" size={22} color={color} />
        }} 
      />
    </Drawer.Navigator>
  );
}

export default function AppNavigator() {
  const [isLoading, setIsLoading] = useState(true);
  const [userToken, setUserToken] = useState<string | null>(null);

  useEffect(() => {
    const bootstrapAsync = async () => {
      try {
        const token = await AsyncStorage.getItem('jwt_token');
        setUserToken(token);
      } catch (e) {
        // Restoring token failed
      }
      setIsLoading(false);
    };

    bootstrapAsync();
  }, []);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8fafc' }}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator 
        screenOptions={{ headerShown: false }}
        initialRouteName={userToken ? 'Main' : 'Auth'}
      >
        <Stack.Screen name="Auth" component={LoginScreen} />
        <Stack.Screen name="Main" component={MainDrawer} />
        <Stack.Screen name="AddLead" component={AddLeadScreen} />
        <Stack.Screen name="Proposals" component={ProposalsScreen} />
        <Stack.Screen name="AddProposal" component={AddProposalScreen} />
        <Stack.Screen name="Cases" component={CasesScreen} />
        <Stack.Screen name="AddCase" component={AddCaseScreen} />
        <Stack.Screen name="Underwriting" component={UnderwritingScreen} />
        <Stack.Screen name="PrePolicyIssuance" component={PrePolicyIssuanceScreen} />
        <Stack.Screen name="PostPolicyIssuance" component={PostPolicyIssuanceScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
        <Stack.Screen name="AgentConfidentialReport" component={AgentConfidentialReportScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
