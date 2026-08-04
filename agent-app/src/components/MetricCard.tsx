import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  accent?: 'blue' | 'emerald' | 'amber' | 'slate';
  iconName?: keyof typeof Ionicons.glyphMap;
}

export default function MetricCard({ title, value, subtitle, accent = 'blue', iconName }: MetricCardProps) {
  const { colors: themeColors, isDark } = useTheme();

  const getColors = () => {
    switch (accent) {
      case 'emerald': return { bg: isDark ? themeColors.border : '#d1fae5', text: isDark ? '#34d399' : '#059669', icon: '#10b981' };
      case 'amber': return { bg: isDark ? themeColors.border : '#fef3c7', text: isDark ? '#fbbf24' : '#d97706', icon: '#f59e0b' };
      case 'slate': return { bg: isDark ? themeColors.border : '#f1f5f9', text: isDark ? '#94a3b8' : '#475569', icon: '#64748b' };
      case 'blue':
      default: return { bg: isDark ? themeColors.border : '#dbeafe', text: isDark ? themeColors.primary : '#2563eb', icon: '#3b82f6' };
    }
  };

  const colors = getColors();

  return (
    <View style={[styles.card, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: themeColors.textMuted }]}>{title}</Text>
        {iconName && (
          <View style={[styles.iconContainer, { backgroundColor: colors.bg }]}>
            <Ionicons name={iconName} size={16} color={colors.icon} />
          </View>
        )}
      </View>
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      {subtitle && <Text style={[styles.subtitle, { color: themeColors.textMuted }]}>{subtitle}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
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
  },
});
