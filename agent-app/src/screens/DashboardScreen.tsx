import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MetricCard from '../components/MetricCard';
import { fetchAgentLeads, UnifiedLead } from '../api/leads';
import { logout } from '../api/auth';
import Button from '../components/Button';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

export default function DashboardScreen() {
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const navigation = useNavigation<any>();

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
            <Text style={styles.title}>Agent Workspace</Text>
            <Text style={styles.subtitle}>Insurance Portal & Lifecycle Hub</Text>
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

        {/* Quick Module Access Grid */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Modules & Access Control</Text>
          
          <View style={styles.gridContainer}>
            {/* Full Access Modules */}
            <TouchableOpacity 
              style={styles.gridCard} 
              onPress={() => navigation.navigate('Proposals')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: '#eff6ff' }]}>
                <Ionicons name="document-text" size={22} color="#1d4ed8" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>Proposals</Text>
                <Text style={styles.cardAccessWrite}>Full Access</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={styles.gridCard} 
              onPress={() => navigation.navigate('Cases')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: '#eff6ff' }]}>
                <Ionicons name="folder-open" size={22} color="#1d4ed8" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>Cases</Text>
                <Text style={styles.cardAccessWrite}>Full Access</Text>
              </View>
            </TouchableOpacity>

            {/* Read Only Modules */}
            <TouchableOpacity 
              style={styles.gridCard} 
              onPress={() => navigation.navigate('Underwriting')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: '#fef3c7' }]}>
                <Ionicons name="analytics" size={22} color="#b45309" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>Underwriting</Text>
                <Text style={styles.cardAccessRead}>Read-Only</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={styles.gridCard} 
              onPress={() => navigation.navigate('PrePolicyIssuance')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: '#fef3c7' }]}>
                <Ionicons name="shield-checkmark" size={22} color="#b45309" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>Pre-Issuance</Text>
                <Text style={styles.cardAccessRead}>Read-Only</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={styles.gridCard} 
              onPress={() => navigation.navigate('PostPolicyIssuance')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: '#fef3c7' }]}>
                <Ionicons name="ribbon" size={22} color="#b45309" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>Post-Issuance</Text>
                <Text style={styles.cardAccessRead}>Read-Only</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity 
              style={styles.gridCard} 
              onPress={() => navigation.navigate('Chat')}
            >
              <View style={[styles.cardIconBox, { backgroundColor: '#dcfce7' }]}>
                <Ionicons name="sparkles" size={22} color="#15803d" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>AI Copilot</Text>
                <Text style={styles.cardAccessWrite}>Assistant</Text>
              </View>
            </TouchableOpacity>
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
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 13,
    color: '#64748b',
  },
  logoutBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  metricsGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  metricCol: {
    flex: 1,
  },
  section: {
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 12,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  gridCard: {
    width: '48%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardIconBox: {
    width: 38,
    height: 38,
    borderRadius: 8,
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
  },
  cardAccessWrite: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1d4ed8',
    marginTop: 2,
  },
  cardAccessRead: {
    fontSize: 11,
    fontWeight: '600',
    color: '#b45309',
    marginTop: 2,
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
