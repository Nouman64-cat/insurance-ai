import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AppNavigator from './src/navigation/AppNavigator';
import { ThemeProvider } from './src/theme/ThemeContext';
import { SessionProvider } from './src/context/SessionContext';
import { NotificationProvider } from './src/notifications/NotificationContext';

/**
 * Provider order matters:
 *   Theme        — everything below renders with the right palette.
 *   Session      — identity and role, which the sync scope depends on.
 *   Notification — the feed, which the sync layer writes into.
 * `LeadSyncProvider` sits inside the navigator so it only runs once signed in.
 */
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SessionProvider>
            <NotificationProvider>
              <AppNavigator />
            </NotificationProvider>
          </SessionProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
