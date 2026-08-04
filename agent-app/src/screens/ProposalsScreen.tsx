import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  ScrollView,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import { fetchProposals, ProposalItem } from '../api/proposals';
import { useNavigation } from '@react-navigation/native';

export default function ProposalsScreen() {
  const [proposals, setProposals] = useState<ProposalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');
  const navigation = useNavigation<any>();

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchProposals();
      setProposals(data);
    } catch (e) {
      console.log('Failed to fetch proposals', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filtered = proposals.filter((p) =>
    p.customer_name.toLowerCase().includes(search.toLowerCase()) ||
    p.product_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <View>
            <Text style={styles.title}>Proposals</Text>
            <Text style={styles.subtitle}>Create and manage client proposals</Text>
          </View>
          <View style={styles.viewToggle}>
            <TouchableOpacity onPress={() => setViewMode('list')} style={[styles.toggleBtn, viewMode === 'list' && styles.toggleBtnActive]}>
              <Ionicons name="list" size={18} color={viewMode === 'list' ? '#fff' : '#64748b'} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setViewMode('kanban')} style={[styles.toggleBtn, viewMode === 'kanban' && styles.toggleBtnActive]}>
              <Ionicons name="apps" size={18} color={viewMode === 'kanban' ? '#fff' : '#64748b'} />
            </TouchableOpacity>
          </View>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => navigation.navigate('AddProposal')}
        >
          <Ionicons name="add-circle" size={18} color="#ffffff" />
          <Text style={styles.addBtnText}>New Proposal</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={18} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by customer or product..."
          placeholderTextColor="#94a3b8"
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {viewMode === 'kanban' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.kanbanContainer}>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>Quoted</Text>
            <FlatList
              data={filtered.filter(p => p.status?.toUpperCase() === 'QUOTED' || p.status?.toUpperCase() === 'PENDING')}
              keyExtractor={(item) => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => renderCard(item)}
            />
          </View>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>Accepted / Approved</Text>
            <FlatList
              data={filtered.filter(p => p.status?.toUpperCase() === 'ACCEPTED' || p.status?.toUpperCase() === 'APPROVED')}
              keyExtractor={(item) => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => renderCard(item)}
            />
          </View>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>Other</Text>
            <FlatList
              data={filtered.filter(p => !['QUOTED', 'PENDING', 'ACCEPTED', 'APPROVED'].includes(p.status?.toUpperCase()))}
              keyExtractor={(item) => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => renderCard(item)}
            />
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => renderCard(item)}
        />
      )}
    </SafeAreaView>
  );

  function renderCard(item: ProposalItem) {
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.customerName}>{item.customer_name}</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.status}</Text>
          </View>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.productName}>{item.product_name}</Text>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Coverage:</Text>
            <Text style={styles.detailVal}>
              PKR {item.coverage_amount.toLocaleString()}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Term:</Text>
            <Text style={styles.detailVal}>{item.term_years} Years</Text>
          </View>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    padding: 16,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 12,
    color: '#64748b',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1d4ed8',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  addBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
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
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    margin: 16,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    color: '#0f172a',
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 20,
    gap: 12,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  kanbanContainer: {
    padding: 16,
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
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  customerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  badge: {
    backgroundColor: '#eff6ff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  badgeText: {
    color: '#1d4ed8',
    fontSize: 11,
    fontWeight: '700',
  },
  cardBody: {
    gap: 4,
  },
  productName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  detailLabel: {
    fontSize: 12,
    color: '#64748b',
  },
  detailVal: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0f172a',
  },
});
