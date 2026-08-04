import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';

export default function AboutScreen() {
  const { colors } = useTheme();

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>About Rizviz</Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.text, { color: colors.text }]}>
            Rizviz Agent App is the ultimate digital companion for insurance agents. It streamlines the 
            entire lifecycle of a policy — from initial lead capture, to running AI-driven underwriting 
            checks, all the way to policy issuance.
          </Text>
          <Text style={[styles.text, { color: colors.text, marginTop: 12 }]}>
            Version: 1.0.0{'\n'}
            Build: 2026.08.04
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
  text: { fontSize: 16, lineHeight: 24 },
});
