import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MetricCard from '../components/MetricCard';
import { fetchAgentLeads, UnifiedLead } from '../api/leads';
import { logout } from '../api/auth';
import Button from '../components/Button';
import { useNavigation, DrawerActions } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';

export default function DashboardScreen() {
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const navigation = useNavigation<any>();
  const { colors, isDark } = useTheme();

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchAgentLeads();
      setLeads(data);
    } catch (err) {
      console.log('Failed to fetch leads on dashboard', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const indLeads = leads.filter(l => l.type === 'INDIVIDUAL').length;
  const famLeads = leads.filter(l => l.type === 'FAMILY').length;
  const corpLeads = leads.filter(l => l.type === 'CORPORATE').length;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView 
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} tintColor={colors.primary} />}
      >
        <View style={[styles.header, { backgroundColor: colors.surface, borderColor: colors.border, justifyContent: 'flex-start', alignItems: 'flex-start' }]}>
          <TouchableOpacity style={[styles.menuIconBtn, { backgroundColor: isDark ? colors.border : '#eff6ff', marginRight: 16, marginTop: 2 }]} onPress={() => navigation.dispatch(DrawerActions.toggleDrawer())}>
            <Ionicons name="menu-outline" size={26} color={colors.primary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 12}}>
              <Ionicons name="shield-checkmark" size={22} color={colors.primary} style={{marginRight: 6}} />
              <Text style={{fontSize: 20, fontWeight: '900', color: colors.text, letterSpacing: -0.5}}>Rizviz</Text>
            </View>
            <Text style={[styles.greeting, { color: colors.textMuted }]}>Welcome back,</Text>
            <Text style={[styles.title, { color: colors.text }]}>Agent Workspace</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>Insurance Portal & Lifecycle Hub</Text>
          </View>
        </View>

        <View style={styles.metricsGrid}>
          <View style={styles.metricCol}>
            <MetricCard 
              title="Total Leads" 
              value={leads.length} 
              accent="blue" 
              iconName="people" 
            />
            <MetricCard 
              title="Individual" 
              value={indLeads} 
              accent="slate" 
              iconName="person" 
            />
          </View>
          <View style={styles.metricCol}>
            <MetricCard 
              title="Family" 
              value={famLeads} 
              accent="slate" 
              iconName="people-circle" 
            />
            <MetricCard 
              title="Corporate" 
              value={corpLeads} 
              accent="slate" 
              iconName="business" 
            />
          </View>
        </View>

        {/* Quick Module Access Grid */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Modules & Access</Text>
            <Ionicons name="apps-outline" size={20} color={colors.textMuted} />
          </View>
          
          <View style={styles.gridContainer}>
            {/* Full Access Modules */}
            <TouchableOpacity 
              style={[styles.gridCard, { backgroundColor: colors.surface, borderColor: colors.border }]} 
              onPress={() => navigation.navigate('Proposals')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: isDark ? colors.border : '#eff6ff' }]}>
                <Ionicons name="document-text" size={24} color={colors.primary} />
              </View>
              <View style={styles.cardInfo}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Proposals</Text>
                <Text style={[styles.cardAccessWrite, { color: colors.primary }]}>Full Access</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.gridCard, { backgroundColor: colors.surface, borderColor: colors.border }]} 
              onPress={() => navigation.navigate('Cases')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: isDark ? colors.border : '#eff6ff' }]}>
                <Ionicons name="folder-open" size={24} color={colors.primary} />
              </View>
              <View style={styles.cardInfo}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Cases</Text>
                <Text style={[styles.cardAccessWrite, { color: colors.primary }]}>Full Access</Text>
              </View>
            </TouchableOpacity>

            {/* Read Only Modules */}
            <TouchableOpacity 
              style={[styles.gridCard, { backgroundColor: colors.surface, borderColor: colors.border }]} 
              onPress={() => navigation.navigate('Underwriting')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: isDark ? colors.border : '#eff6ff' }]}>
                <Ionicons name="analytics" size={24} color={colors.primary} />
              </View>
              <View style={styles.cardInfo}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Underwriting</Text>
                <Text style={[styles.cardAccessRead, { color: colors.textMuted }]}>Read-Only</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.gridCard, { backgroundColor: colors.surface, borderColor: colors.border }]} 
              onPress={() => navigation.navigate('PrePolicyIssuance')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: isDark ? colors.border : '#eff6ff' }]}>
                <Ionicons name="shield-checkmark" size={24} color={colors.primary} />
              </View>
              <View style={styles.cardInfo}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Pre-Issuance</Text>
                <Text style={[styles.cardAccessRead, { color: colors.textMuted }]}>Read-Only</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.gridCard, { backgroundColor: colors.surface, borderColor: colors.border }]} 
              onPress={() => navigation.navigate('PostPolicyIssuance')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: isDark ? colors.border : '#eff6ff' }]}>
                <Ionicons name="ribbon" size={24} color={colors.primary} />
              </View>
              <View style={styles.cardInfo}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Post-Issuance</Text>
                <Text style={[styles.cardAccessRead, { color: colors.textMuted }]}>Read-Only</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.gridCard, { backgroundColor: colors.surface, borderColor: colors.border }]} 
              onPress={() => navigation.navigate('Chat')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: colors.primary }]}>
                <Ionicons name="sparkles" size={24} color="#ffffff" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>AI Copilot</Text>
                <Text style={[styles.cardAccessAssistant, { color: colors.text }]}>Assistant</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Pipeline Overview</Text>
            <Ionicons name="stats-chart" size={20} color={colors.textMuted} />
          </View>
          <View style={[styles.pipelineCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.pipeStat}>
              <View style={[styles.pipeIconBox, { backgroundColor: isDark ? colors.border : '#eff6ff' }]}>
                <Ionicons name="star" size={18} color={colors.primary} />
              </View>
              <Text style={[styles.pipeVal, { color: colors.primary }]}>{leads.filter(l => l.status === 'LEAD').length}</Text>
              <Text style={styles.pipeLabel}>New Leads</Text>
            </View>
            
            <View style={[styles.pipeDivider, { backgroundColor: colors.border }]} />
            
            <View style={styles.pipeStat}>
              <View style={[styles.pipeIconBox, { backgroundColor: isDark ? colors.border : '#f1f5f9' }]}>
                <Ionicons name="time" size={18} color={colors.textMuted} />
              </View>
              <Text style={[styles.pipeVal, { color: colors.textMuted }]}>{leads.filter(l => l.status === 'PROSPECT').length}</Text>
              <Text style={styles.pipeLabel}>In Progress</Text>
            </View>

            <View style={[styles.pipeDivider, { backgroundColor: colors.border }]} />

            <View style={styles.pipeStat}>
              <View style={[styles.pipeIconBox, { backgroundColor: isDark ? colors.border : '#f8fafc' }]}>
                <Ionicons name="close-circle" size={18} color={isDark ? '#64748b' : '#94a3b8'} />
              </View>
              <Text style={[styles.pipeVal, { color: isDark ? '#64748b' : '#94a3b8' }]}>{leads.filter(l => l.status === 'NOT_INTERESTED').length}</Text>
              <Text style={styles.pipeLabel}>Dead</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  container: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
    backgroundColor: '#ffffff',
    padding: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.03,
    shadowRadius: 10,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#f1f5f9',
  },
  greeting: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: '600',
    marginBottom: 4,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0f172a',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  menuIconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricsGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  metricCol: {
    flex: 1,
  },
  section: {
    marginTop: 28,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e293b',
    letterSpacing: -0.3,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  gridCard: {
    width: '48%',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 6,
    elevation: 1,
  },
  cardIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardInfo: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 2,
  },
  cardAccessWrite: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1d4ed8',
  },
  cardAccessRead: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  cardAccessAssistant: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0f172a',
  },
  pipelineCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.03,
    shadowRadius: 10,
    elevation: 2,
  },
  pipeStat: {
    alignItems: 'center',
    flex: 1,
  },
  pipeIconBox: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  pipeDivider: {
    width: 1,
    backgroundColor: '#e2e8f0',
    marginHorizontal: 10,
  },
  pipeVal: {
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 4,
  },
  pipeLabel: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
  }
});
