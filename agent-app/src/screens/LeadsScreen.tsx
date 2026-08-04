import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl, Modal, TouchableOpacity, Alert, ScrollView, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fetchAgentLeads, updateLeadStatus, deleteLead, UnifiedLead, ProfileStatus, EntityType } from '../api/leads';
import LeadCard from '../components/LeadCard';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';
import { Ionicons } from '@expo/vector-icons';

type FilterType = 'ALL' | 'LEAD' | 'PROSPECT' | 'NOT_INTERESTED';

export default function LeadsScreen() {
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterType>('ALL');
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');

  // Modal State
  const [modalVisible, setModalVisible] = useState(false);
  const [step, setStep] = useState(1);
  const [selectedType, setSelectedType] = useState<EntityType | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<'quick' | 'normal' | null>(null);

  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

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

  const handleDeleteLead = async (lead: UnifiedLead) => {
    try {
      await deleteLead(lead);
      // Optimistic update
      setLeads(prev => prev.filter(l => l.id !== lead.id));
    } catch (err) {
      console.log('Failed to delete lead', err);
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

  const openAddLeadModal = () => {
    setStep(1);
    setSelectedType(null);
    setSelectedCategory(null);
    setModalVisible(true);
  };

  const handleSelectType = (type: EntityType) => {
    setSelectedType(type);
    setStep(2);
  };

  const handleProceed = () => {
    if (!selectedCategory) return;
    setModalVisible(false);
    navigation.navigate('AddLead', { type: selectedType || 'INDIVIDUAL', category: selectedCategory });
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>My Leads</Text>
          <Text style={styles.subtitle}>Manage your pipeline</Text>
        </View>
        <View style={styles.viewToggle}>
          <TouchableOpacity onPress={() => setViewMode('list')} style={[styles.toggleBtn, viewMode === 'list' && styles.toggleBtnActive]}>
            <Ionicons name="list" size={20} color={viewMode === 'list' ? '#fff' : '#64748b'} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setViewMode('kanban')} style={[styles.toggleBtn, viewMode === 'kanban' && styles.toggleBtnActive]}>
            <Ionicons name="apps" size={20} color={viewMode === 'kanban' ? '#fff' : '#64748b'} />
          </TouchableOpacity>
        </View>
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
      ) : viewMode === 'kanban' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.kanbanContainer}>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>New Leads</Text>
            <FlatList
              data={leads.filter(l => l.status === 'LEAD')}
              keyExtractor={item => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <LeadCard lead={item} onStatusChange={(newStatus) => handleStatusChange(item, newStatus)} onDelete={() => handleDeleteLead(item)} onEdit={() => Alert.alert('Coming Soon', 'Edit functionality coming in next update')} />
              )}
            />
          </View>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>In Progress</Text>
            <FlatList
              data={leads.filter(l => l.status === 'PROSPECT')}
              keyExtractor={item => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <LeadCard lead={item} onStatusChange={(newStatus) => handleStatusChange(item, newStatus)} onDelete={() => handleDeleteLead(item)} onEdit={() => Alert.alert('Coming Soon', 'Edit functionality coming in next update')} />
              )}
            />
          </View>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>Dead</Text>
            <FlatList
              data={leads.filter(l => l.status === 'NOT_INTERESTED')}
              keyExtractor={item => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <LeadCard lead={item} onStatusChange={(newStatus) => handleStatusChange(item, newStatus)} onDelete={() => handleDeleteLead(item)} onEdit={() => Alert.alert('Coming Soon', 'Edit functionality coming in next update')} />
              )}
            />
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={filteredLeads}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <LeadCard
              lead={item}
              onStatusChange={(newStatus) => handleStatusChange(item, newStatus)}
              onDelete={() => handleDeleteLead(item)}
              onEdit={() => Alert.alert('Coming Soon', 'Edit functionality coming in next update')}
            />
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No leads found in this category.</Text>
          }
        />
      )}

      {/* Floating Action Button */}
      <TouchableOpacity style={styles.fab} onPress={openAddLeadModal} activeOpacity={0.8}>
        <Ionicons name="add" size={20} color="#fff" style={{ marginRight: 4 }} />
        <Text style={styles.fabText}>Add Lead</Text>
      </TouchableOpacity>

      {/* Add Lead Sequence Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {step === 1 ? 'Select Category' : 'Select Lead Type'}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={24} color="#64748b" />
              </TouchableOpacity>
            </View>

            {step === 1 ? (
              <View style={styles.modalOptions}>
                <TouchableOpacity style={styles.modalBtn} onPress={() => handleSelectType('INDIVIDUAL')}>
                  <Text style={styles.modalBtnText}>Individual</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalBtn} onPress={() => handleSelectType('FAMILY')}>
                  <Text style={styles.modalBtnText}>Family</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalBtn} onPress={() => handleSelectType('CORPORATE')}>
                  <Text style={styles.modalBtnText}>Corporate</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.modalOptions}>
                <TouchableOpacity
                  style={[styles.modalOptionCard, selectedCategory === 'quick' && styles.modalOptionCardActive]}
                  onPress={() => setSelectedCategory('quick')}
                >
                  <Text style={[styles.modalBtnTextSecondary, selectedCategory === 'quick' && { color: '#ffffff' }]}>Quick Lead</Text>
                  <Text style={[styles.modalSubText, selectedCategory === 'quick' && { color: '#bfdbfe' }]}>Minimal information required</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.modalOptionCard, selectedCategory === 'normal' && styles.modalOptionCardActive]}
                  onPress={() => setSelectedCategory('normal')}
                >
                  <Text style={[styles.modalBtnTextSecondary, selectedCategory === 'normal' && { color: '#ffffff' }]}>Complete detail</Text>
                  <Text style={[styles.modalSubText, selectedCategory === 'normal' && { color: '#bfdbfe' }]}>Full profile details</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.modalProceedBtn, !selectedCategory && { opacity: 0.5 }]}
                  onPress={handleProceed}
                  disabled={!selectedCategory}
                >
                  <Text style={styles.modalProceedText}>Continue</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.modalBackBtn} onPress={() => setStep(1)}>
                  <Text style={styles.modalBackText}>Back</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    padding: 4,
  },
  toggleBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  toggleBtnActive: {
    backgroundColor: '#1d4ed8',
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
    paddingBottom: 80, // Space for FAB
  },
  kanbanContainer: {
    padding: 16,
    paddingBottom: 80,
    gap: 16,
  },
  kanbanColumn: {
    width: Dimensions.get('window').width * 0.85,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
  },
  columnTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 12,
    paddingHorizontal: 4,
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
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: '#1D4ED8',
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
  },
  fabText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
  },
  modalOptions: {
    gap: 12,
  },
  modalBtn: {
    backgroundColor: '#f1f5f9',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
  },
  modalOptionCard: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  modalOptionCardActive: {
    backgroundColor: '#1D4ED8',
    borderColor: '#1D4ED8',
  },
  modalBtnTextSecondary: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1e293b',
  },
  modalSubText: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 4,
  },
  modalProceedBtn: {
    backgroundColor: '#0f172a',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalProceedText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  modalBackBtn: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalBackText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  }
});
