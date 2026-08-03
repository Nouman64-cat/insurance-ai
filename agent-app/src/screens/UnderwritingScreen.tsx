import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { fetchAssessments, AssessmentItem } from '../api/underwriting';

export default function UnderwritingScreen() {
  const [assessments, setAssessments] = useState<AssessmentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchAssessments();
      setAssessments(data);
    } catch (e) {
      console.log('Failed to fetch underwriting assessments', e);
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
        <Text style={styles.title}>Underwriting Risk Engine</Text>
        <Text style={styles.subtitle}>AI Risk Assessments & Composite Scoring</Text>
      </View>

      {/* Security Banner for Agent Role */}
      <View style={styles.readOnlyBanner}>
        <Ionicons name="lock-closed" size={18} color="#92400e" />
        <Text style={styles.bannerText}>
          Read-Only Mode: Underwriting decisions & score overrides require Manager authorization.
        </Text>
      </View>

      <FlatList
        data={assessments}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View>
                <Text style={styles.customerName}>{item.customer_name}</Text>
                <Text style={styles.caseId}>{item.case_id}</Text>
              </View>
              <View style={[
                styles.decisionBadge,
                item.ai_decision === 'AUTO_APPROVE' ? styles.badgeApprove : styles.badgeReview
              ]}>
                <Text style={styles.decisionText}>{item.ai_decision}</Text>
              </View>
            </View>

            <View style={styles.scoresGrid}>
              <View style={styles.scoreItem}>
                <Text style={styles.scoreVal}>{item.medical_score}/100</Text>
                <Text style={styles.scoreLabel}>Medical</Text>
              </View>
              <View style={styles.scoreItem}>
                <Text style={styles.scoreVal}>{item.financial_score}/100</Text>
                <Text style={styles.scoreLabel}>Financial</Text>
              </View>
              <View style={styles.scoreItem}>
                <Text style={styles.scoreVal}>{item.fraud_probability}</Text>
                <Text style={styles.scoreLabel}>Fraud Prob</Text>
              </View>
              <View style={styles.scoreItem}>
                <Text style={[styles.scoreVal, { color: '#1d4ed8' }]}>
                  {item.composite_risk_score}
                </Text>
                <Text style={styles.scoreLabel}>Composite</Text>
              </View>
            </View>

            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.disabledBtn}
                onPress={() => handleRestrictedAction('Override Scores')}
              >
                <Ionicons name="lock-closed-outline" size={14} color="#64748b" />
                <Text style={styles.disabledBtnText}>Override Scores</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.disabledBtn}
                onPress={() => handleRestrictedAction('Approve or Decline')}
              >
                <Ionicons name="lock-closed-outline" size={14} color="#64748b" />
                <Text style={styles.disabledBtnText}>Make Decision</Text>
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
    alignItems: 'center',
    marginBottom: 12,
  },
  customerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  caseId: {
    fontSize: 12,
    color: '#64748b',
  },
  decisionBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeApprove: {
    backgroundColor: '#dcfce7',
  },
  badgeReview: {
    backgroundColor: '#eff6ff',
  },
  decisionText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0f172a',
  },
  scoresGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  scoreItem: {
    alignItems: 'center',
  },
  scoreVal: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  scoreLabel: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
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
