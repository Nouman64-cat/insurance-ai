import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity } from 'react-native';
import { DrawerContentScrollView, DrawerItemList } from '@react-navigation/drawer';
import { useTheme } from '../theme/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { logout } from '../api/auth';
import { useNavigation } from '@react-navigation/native';

export default function CustomDrawer(props: any) {
  const { colors, isDark } = useTheme();
  const navigation = useNavigation<any>();
  const [accountInfo, setAccountInfo] = useState({
    name: 'Agent',
    email: 'agent@rizviz.com',
  });

  useEffect(() => {
    const loadInfo = async () => {
      const name = await AsyncStorage.getItem('agent_name');
      const email = await AsyncStorage.getItem('user_email');
      setAccountInfo({
        name: name || 'Agent',
        email: email || 'agent@rizviz.com',
      });
    };
    loadInfo();
  }, []);

  const handleLogout = async () => {
    await logout();
    navigation.replace('Auth');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <DrawerContentScrollView {...props} contentContainerStyle={{ paddingTop: 0 }}>
        {/* Header section with Logo and Account Info */}
        <View style={[styles.header, { backgroundColor: isDark ? colors.surface : '#1d4ed8' }]}>
          <View style={styles.logoContainer}>
            <Image 
              source={require('../assets/rizvi.png')} 
              style={styles.logo} 
              resizeMode="contain"
            />
          </View>
          <Text style={styles.name}>{accountInfo.name}</Text>
          <Text style={styles.email}>{accountInfo.email}</Text>
        </View>

        {/* Standard Drawer Items mapping to routes */}
        <View style={styles.menuContainer}>
          <DrawerItemList {...props} />
        </View>
      </DrawerContentScrollView>

      {/* Footer with Logout */}
      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={22} color={colors.danger} />
          <Text style={[styles.logoutText, { color: colors.danger }]}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    padding: 20,
    paddingTop: 60,
    paddingBottom: 30,
    borderBottomRightRadius: 24,
    marginBottom: 10,
  },
  logoContainer: {
    backgroundColor: '#ffffff',
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
    padding: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  logo: {
    width: '100%',
    height: '100%',
  },
  name: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  email: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 14,
  },
  menuContainer: {
    paddingHorizontal: 8,
  },
  footer: {
    padding: 20,
    borderTopWidth: 1,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 12,
  },
});
