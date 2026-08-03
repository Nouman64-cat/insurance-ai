import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  accent?: 'blue' | 'emerald' | 'amber' | 'slate';
  iconName?: keyof typeof Ionicons.glyphMap;
}

export default function MetricCard({ title, value, subtitle, accent = 'blue', iconName }: MetricCardProps) {
  const getColors = () => {
    switch (accent) {
      case 'emerald': return { bg: '#d1fae5', text: '#059669', icon: '#10b981' };
      case 'amber': return { bg: '#fef3c7', text: '#d97706', icon: '#f59e0b' };
      case 'slate': return { bg: '#f1f5f9', text: '#475569', icon: '#64748b' };
      case 'blue':
      default: return { bg: '#dbeafe', text: '#2563eb', icon: '#3b82f6' };
    }
  };

  const colors = getColors();

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {iconName && (
          <View style={[styles.iconContainer, { backgroundColor: colors.bg }]}>
            <Ionicons name={iconName} size={16} color={colors.icon} />
          </View>
        )}
      </View>
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0', // slate-200
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#94a3b8', // slate-400
    letterSpacing: 0.5,
  },
  iconContainer: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: '#94a3b8', // slate-400
  },
});
