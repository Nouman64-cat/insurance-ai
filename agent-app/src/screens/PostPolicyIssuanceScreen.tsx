import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  RefreshControl,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { fetchPolicies, PolicyItem } from '../api/policies';

export default function PostPolicyIssuanceScreen() {
  const [policies, setPolicies] = useState<PolicyItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchPolicies();
      setPolicies(data.filter((p) => p.stage === 'POST_ISSUANCE'));
    } catch (e) {
      console.log('Failed to fetch post-issuance active policies', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRestrictedAction = (actionName: string) => {
    Alert.alert(
      'Access Restricted',
      `Currently, you have no access to ${actionName}. Please ask your manager for authorization.`
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.title}>Post-Policy Management</Text>
        <Text style={styles.subtitle}>Active policies & post-issuance endorsements</Text>
      </View>

      {/* Security Banner for Agent Role */}
      <View style={styles.readOnlyBanner}>
        <Ionicons name="lock-closed" size={18} color="#92400e" />
        <Text style={styles.bannerText}>
          Read-Only Mode: Policy endorsements, cancellations, & rider modifications require Manager authorization.
        </Text>
      </View>

      <FlatList
        data={policies}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View>
                <Text style={styles.policyNum}>{item.policy_number}</Text>
                <Text style={styles.customerName}>{item.customer_name}</Text>
              </View>
              <View style={styles.statusBadge}>
                <Text style={styles.statusText}>{item.status}</Text>
              </View>
            </View>

            <View style={styles.cardBody}>
              <Text style={styles.productName}>{item.product_name}</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Effective Date:</Text>
                <Text style={styles.detailVal}>{item.effective_date}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expiry Date:</Text>
                <Text style={styles.detailVal}>{item.expiry_date}</Text>
              </View>
            </View>

            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.disabledBtn}
                onPress={() => handleRestrictedAction('Policy Endorsement')}
              >
                <Ionicons name="lock-closed-outline" size={14} color="#64748b" />
                <Text style={styles.disabledBtnText}>Request Endorsement</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.disabledBtn}
                onPress={() => handleRestrictedAction('Policy Cancellation')}
              >
                <Ionicons name="lock-closed-outline" size={14} color="#64748b" />
                <Text style={styles.disabledBtnText}>Cancel Policy</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      />
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
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
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
  readOnlyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef3c7',
    borderColor: '#fde68a',
    borderWidth: 1,
    padding: 12,
    margin: 16,
    borderRadius: 10,
    gap: 8,
  },
  bannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: '#78350f',
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
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  policyNum: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1d4ed8',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  customerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 2,
  },
  statusBadge: {
    backgroundColor: '#dcfce7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#15803d',
  },
  cardBody: {
    gap: 4,
    marginVertical: 8,
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
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  disabledBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
    borderColor: '#cbd5e1',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    gap: 4,
  },
  disabledBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
});
