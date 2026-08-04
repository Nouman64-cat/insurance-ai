import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Platform,
  RefreshControl,
  ScrollView,
  Dimensions,
  Share,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import { fetchCases, CaseItem } from '../api/cases';
import { inviteEApplication, buildEApplicationLink } from '../api/eApplication';
import { useNavigation } from '@react-navigation/native';

export default function CasesScreen() {
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');
  const [sendingLinkFor, setSendingLinkFor] = useState<string | null>(null);
  const navigation = useNavigation<any>();

  const handleSendEAppLink = async (item: CaseItem) => {
    setSendingLinkFor(item.id);
    try {
      const invite = await inviteEApplication(item.id);
      const link = buildEApplicationLink(invite.link_path);
      await Share.share({ message: `Please complete your life insurance application here: ${link}` });
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to generate E-Application link');
    } finally {
      setSendingLinkFor(null);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchCases();
      setCases(data);
    } catch (e) {
      console.log('Failed to fetch cases', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filtered = cases.filter((c) =>
    c.applicant_name.toLowerCase().includes(search.toLowerCase()) ||
    c.case_number.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <View>
            <Text style={styles.title}>Cases</Text>
            <Text style={styles.subtitle}>Active underwriting cases</Text>
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
          onPress={() => navigation.navigate('AddCase')}
        >
          <Ionicons name="add-circle" size={18} color="#ffffff" />
          <Text style={styles.addBtnText}>New Case</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={18} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by case no or applicant..."
          placeholderTextColor="#94a3b8"
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {viewMode === 'kanban' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.kanbanContainer}>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>Draft / New</Text>
            <FlatList
              data={filtered.filter(c => ['DRAFT', 'NEW', 'QUOTED'].includes(c.status?.toUpperCase()))}
              keyExtractor={(item) => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => renderCard(item)}
            />
          </View>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>In Progress</Text>
            <FlatList
              data={filtered.filter(c => ['UNDERWRITING', 'IN_PROGRESS', 'PENDING'].includes(c.status?.toUpperCase()))}
              keyExtractor={(item) => item.id}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => renderCard(item)}
            />
          </View>
          <View style={styles.kanbanColumn}>
            <Text style={styles.columnTitle}>Closed / Other</Text>
            <FlatList
              data={filtered.filter(c => !['DRAFT', 'NEW', 'QUOTED', 'UNDERWRITING', 'IN_PROGRESS', 'PENDING'].includes(c.status?.toUpperCase()))}
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

  function renderCard(item: CaseItem) {
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.caseNum}>{item.case_number}</Text>
            <Text style={styles.applicantName}>{item.applicant_name}</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.status}</Text>
          </View>
        </View>
        <View style={styles.cardFooter}>
          <Text style={styles.metaText}>Type: {item.case_type}</Text>
          <Text style={styles.metaText}>Priority: {item.priority}</Text>
        </View>
        <View style={styles.preUwRow}>
          <TouchableOpacity
            style={styles.preUwBtn}
            onPress={() => handleSendEAppLink(item)}
            disabled={sendingLinkFor === item.id}
          >
            <Ionicons name="link-outline" size={14} color="#1d4ed8" />
            <Text style={styles.preUwBtnText}>
              {sendingLinkFor === item.id ? 'Generating…' : 'Send E-Application'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.preUwBtn}
            onPress={() => navigation.navigate('AgentConfidentialReport', { caseId: item.id, applicantName: item.applicant_name })}
          >
            <Ionicons name="lock-closed-outline" size={14} color="#1d4ed8" />
            <Text style={styles.preUwBtnText}>File ACR</Text>
          </TouchableOpacity>
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
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  caseNum: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1d4ed8',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  applicantName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 2,
  },
  badge: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  badgeText: {
    color: '#334155',
    fontSize: 11,
    fontWeight: '700',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    paddingTop: 8,
  },
  metaText: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '500',
  },
  preUwRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  preUwBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
  },
  preUwBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1d4ed8',
  },
});
