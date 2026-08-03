import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MetricCard from '../components/MetricCard';
import { fetchAgentLeads, UnifiedLead } from '../api/leads';
import { logout } from '../api/auth';
import Button from '../components/Button';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Main'>;

export default function DashboardScreen() {
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const navigation = useNavigation<NavProp>();

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

  const handleLogout = async () => {
    await logout();
    navigation.replace('Auth');
  };

  const indLeads = leads.filter(l => l.type === 'INDIVIDUAL').length;
  const famLeads = leads.filter(l => l.type === 'FAMILY').length;
  const corpLeads = leads.filter(l => l.type === 'CORPORATE').length;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView 
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Agent Dashboard</Text>
            <Text style={styles.subtitle}>Your active portfolio overview</Text>
          </View>
          <Button title="Logout" type="secondary" onPress={handleLogout} style={styles.logoutBtn} textStyle={{fontSize: 12}} />
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
              accent="emerald" 
              iconName="person" 
            />
          </View>
          <View style={styles.metricCol}>
            <MetricCard 
              title="Family" 
              value={famLeads} 
              accent="amber" 
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

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pipeline Overview</Text>
          <View style={styles.pipelineCard}>
            <View style={styles.pipeStat}>
              <Text style={styles.pipeVal}>{leads.filter(l => l.status === 'LEAD').length}</Text>
              <Text style={styles.pipeLabel}>New Leads</Text>
            </View>
            <View style={styles.pipeStat}>
              <Text style={styles.pipeVal}>{leads.filter(l => l.status === 'PROSPECT').length}</Text>
              <Text style={styles.pipeLabel}>In Progress</Text>
            </View>
            <View style={styles.pipeStat}>
              <Text style={styles.pipeVal}>{leads.filter(l => l.status === 'NOT_INTERESTED').length}</Text>
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
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
  },
  logoutBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  metricsGrid: {
    flexDirection: 'row',
    gap: 16,
  },
  metricCol: {
    flex: 1,
  },
  section: {
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 12,
  },
  pipelineCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pipeStat: {
    alignItems: 'center',
  },
  pipeVal: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1d4ed8',
  },
  pipeLabel: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 4,
    fontWeight: '600',
  }
});
