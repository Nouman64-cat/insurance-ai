import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';

export default function HelpScreen() {
  const { colors } = useTheme();

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Help & Support</Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.text }]}>Contact IT Support</Text>
          <Text style={[styles.text, { color: colors.textMuted }]}>
            If you are experiencing issues with the app, such as login failures, sync errors, or crashes, 
            please reach out to the internal IT support team.
          </Text>
          
          <Text style={[styles.contactInfo, { color: colors.primary, marginTop: 16 }]}>
            support@rizviz.com
          </Text>
          <Text style={[styles.contactInfo, { color: colors.primary }]}>
            +92 800 123 4567
          </Text>
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
  card: { borderWidth: 1, borderRadius: 16, padding: 20 },
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  text: { fontSize: 15, lineHeight: 22 },
  contactInfo: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
});
