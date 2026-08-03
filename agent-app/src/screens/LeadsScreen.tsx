import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fetchAgentLeads, updateLeadStatus, UnifiedLead, ProfileStatus } from '../api/leads';
import LeadCard from '../components/LeadCard';
import { useFocusEffect } from '@react-navigation/native';

type FilterType = 'ALL' | 'LEAD' | 'PROSPECT' | 'NOT_INTERESTED';

export default function LeadsScreen() {
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterType>('ALL');

  const loadLeads = async () => {
    try {
      const data = await fetchAgentLeads();
      setLeads(data);
    } catch (err) {
      console.log('Error loading leads', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadLeads();
    }, [])
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadLeads();
  };

  const handleStatusChange = async (lead: UnifiedLead, newStatus: ProfileStatus) => {
    try {
      await updateLeadStatus(lead, newStatus);
      // Optimistic update
      setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: newStatus } : l));
    } catch (err) {
      console.log('Failed to update status', err);
    }
  };

  const filteredLeads = leads.filter(l => {
    if (filter === 'ALL') return true;
    return l.status === filter;
  });

  const FilterButton = ({ title, type }: { title: string, type: FilterType }) => {
    const active = filter === type;
    return (
      <Text 
        onPress={() => setFilter(type)} 
        style={[styles.filterBtn, active && styles.filterBtnActive]}
      >
        {title}
      </Text>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>My Leads</Text>
        <Text style={styles.subtitle}>Manage your pipeline</Text>
      </View>

      <View style={styles.filters}>
        <FilterButton title="All" type="ALL" />
        <FilterButton title="New" type="LEAD" />
        <FilterButton title="In Progress" type="PROSPECT" />
        <FilterButton title="Dead" type="NOT_INTERESTED" />
      </View>

      {loading && !refreshing ? (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color="#1D4ED8" />
        </View>
      ) : (
        <FlatList
          data={filteredLeads}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <LeadCard lead={item} onStatusChange={(newStatus) => handleStatusChange(item, newStatus)} />
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No leads found in this category.</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    padding: 16,
    paddingBottom: 12,
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
  filters: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  filterBtn: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    backgroundColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    overflow: 'hidden',
  },
  filterBtnActive: {
    backgroundColor: '#1D4ED8',
    color: '#ffffff',
  },
  listContent: {
    padding: 16,
    paddingTop: 4,
  },
  loader: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    textAlign: 'center',
    color: '#94a3b8',
    marginTop: 40,
    fontSize: 14,
  },
});
