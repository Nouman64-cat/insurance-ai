import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Switch, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

export default function SettingsScreen() {
  const { isDark, setTheme, colors, theme } = useTheme();
  const [accountInfo, setAccountInfo] = useState({
    name: 'Loading...',
    email: 'Loading...',
    role: 'Loading...'
  });

  useEffect(() => {
    const loadInfo = async () => {
      const name = await AsyncStorage.getItem('agent_name');
      const email = await AsyncStorage.getItem('user_email');
      const role = await AsyncStorage.getItem('user_role');
      setAccountInfo({
        name: name || 'N/A',
        email: email || 'N/A',
        role: role || 'N/A'
      });
    };
    loadInfo();
  }, []);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Settings</Text>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Account Information</Text>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <Ionicons name="person-outline" size={20} color={colors.primary} />
              </View>
              <View>
                <Text style={[styles.rowLabel, { color: colors.textMuted }]}>Name</Text>
                <Text style={[styles.rowValue, { color: colors.text }]}>{accountInfo.name}</Text>
              </View>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <Ionicons name="mail-outline" size={20} color={colors.primary} />
              </View>
              <View>
                <Text style={[styles.rowLabel, { color: colors.textMuted }]}>Email</Text>
                <Text style={[styles.rowValue, { color: colors.text }]}>{accountInfo.email}</Text>
              </View>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <Ionicons name="shield-outline" size={20} color={colors.primary} />
              </View>
              <View>
                <Text style={[styles.rowLabel, { color: colors.textMuted }]}>Role</Text>
                <Text style={[styles.rowValue, { color: colors.text }]}>{accountInfo.role}</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Preferences</Text>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.row, { justifyContent: 'space-between', alignItems: 'center' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={styles.iconBox}>
                  <Ionicons name="moon-outline" size={20} color={colors.primary} />
                </View>
                <Text style={[styles.rowValue, { color: colors.text }]}>Dark Mode</Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={(val) => setTheme(val ? 'dark' : 'light')}
                trackColor={{ false: '#cbd5e1', true: colors.primary }}
                thumbColor={'#ffffff'}
              />
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { padding: 16 },
  header: { marginBottom: 24, paddingVertical: 10 },
  title: { fontSize: 28, fontWeight: '800' },
  section: { marginBottom: 32 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(29, 78, 216, 0.1)', justifyContent: 'center', alignItems: 'center' },
  rowLabel: { fontSize: 12, fontWeight: '500' },
  rowValue: { fontSize: 15, fontWeight: '600' },
  divider: { height: 1, marginVertical: 12 },
});
