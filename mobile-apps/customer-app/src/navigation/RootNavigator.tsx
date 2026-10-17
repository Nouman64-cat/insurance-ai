import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import Logo from '../components/Logo';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../context/AuthContext';
import LoginScreen from '../screens/auth/LoginScreen';
import FirstLoginScreen from '../screens/auth/FirstLoginScreen';
import WalkInStartScreen from '../screens/auth/WalkInStartScreen';
import PayScreen from '../screens/walkin/PayScreen';
import WalkInTabs from './WalkInTabs';
import CustomerNavigator from './CustomerNavigator';

const Stack = createNativeStackNavigator();

const SignedOut = () => (
  <Stack.Navigator screenOptions={{ headerShown: false }}>
    <Stack.Screen name="Login" component={LoginScreen} />
    <Stack.Screen name="WalkInStart" component={WalkInStartScreen} />
  </Stack.Navigator>
);
const PasswordChange = () => (
  <Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="FirstLogin" component={FirstLoginScreen} /></Stack.Navigator>
);
const WalkIn = () => (
  <Stack.Navigator screenOptions={{ headerShown: false }}>
    <Stack.Screen name="WalkInTabs" component={WalkInTabs} />
    <Stack.Screen name="Pay" component={PayScreen} />
  </Stack.Navigator>
);

/**
 * One navigator tree per session state, like the web portal's middleware: a walk-in can never reach a policyholder screen and
 * vice versa, because those screens are simply not in the tree. When a lead becomes a policy the Track Status screen offers
 * "Go to sign in", which ends the guest session; the policyholder signs in with the credentials the insurer sent.
 * `key={state}` resets navigation history whenever the session changes.
 */
export default function RootNavigator() {
  const { colors, isDark } = useTheme();
  const { state } = useAuth();
  const base = isDark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, background: colors.background, card: colors.background, text: colors.text, border: colors.border, primary: colors.primary } };

  if (state === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: 24 }}>
        <Logo variant="mark" width={88} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  return (
    <NavigationContainer theme={theme} key={state}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {state === 'signedOut' ? <SignedOut /> : state === 'passwordChange' ? <PasswordChange /> : state === 'walkIn' ? <WalkIn /> : <CustomerNavigator />}
    </NavigationContainer>
  );
}
