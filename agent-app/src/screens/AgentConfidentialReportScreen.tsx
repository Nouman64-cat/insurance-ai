import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, Switch, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import Input from '../components/Input';
import Button from '../components/Button';
import {
  fetchConfidentialReport,
  saveConfidentialReport,
  submitConfidentialReport,
  ACRRecommendation,
} from '../api/confidentialReport';

const RECOMMENDATIONS: { value: ACRRecommendation; label: string }[] = [
  { value: 'Recommend', label: 'Recommend' },
  { value: 'RecommendWithCaution', label: 'Recommend with caution' },
  { value: 'DoNotRecommend', label: 'Do not recommend' },
];

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: '#1D4ED8' }} />
    </View>
  );
}

export default function AgentConfidentialReportScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { caseId, applicantName } = route.params ?? {};

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);

  const [knownSince, setKnownSince] = useState('');
  const [relationship, setRelationship] = useState('');
  const [purpose, setPurpose] = useState('');
  const [financialInterestExplained, setFinancialInterestExplained] = useState(true);
  const [adverseInfoKnown, setAdverseInfoKnown] = useState(false);
  const [adverseInfoDetails, setAdverseInfoDetails] = useState('');

  const [occupationVerified, setOccupationVerified] = useState(true);
  const [incomeSourceVerified, setIncomeSourceVerified] = useState(true);
  const [estimatedIncome, setEstimatedIncome] = useState('');
  const [incomeNote, setIncomeNote] = useState('');

  const [healthNote, setHealthNote] = useState('');
  const [hazardousKnown, setHazardousKnown] = useState(false);

  const [recommendation, setRecommendation] = useState<ACRRecommendation>('Recommend');
  const [remarks, setRemarks] = useState('');

  useEffect(() => {
    (async () => {
      if (!caseId) return;
      try {
        const r = await fetchConfidentialReport(caseId);
        if (r.status === 'Submitted') setAlreadySubmitted(true);
        setKnownSince(r.known_proposer_since ?? '');
        setRelationship(r.relationship_to_proposer ?? '');
        setPurpose(r.purpose_of_insurance ?? '');
        setFinancialInterestExplained(r.financial_interest_explained ?? true);
        setAdverseInfoKnown(r.adverse_info_known ?? false);
        setAdverseInfoDetails(r.adverse_info_details ?? '');
        setOccupationVerified(r.occupation_verified ?? true);
        setIncomeSourceVerified(r.income_source_verified ?? true);
        setEstimatedIncome(r.estimated_income_opinion ? String(r.estimated_income_opinion) : '');
        setIncomeNote(r.income_consistency_note ?? '');
        setHealthNote(r.health_appearance_note ?? '');
        setHazardousKnown(r.hazardous_activity_known ?? false);
        setRecommendation(r.recommendation ?? 'Recommend');
        setRemarks(r.remarks ?? '');
      } catch (e) {
        // No draft yet — fine, start blank.
      } finally {
        setLoading(false);
      }
    })();
  }, [caseId]);

  const handleSubmit = async () => {
    if (!caseId) {
      Alert.alert('Error', 'No case selected.');
      return;
    }
    setSubmitting(true);
    try {
      await saveConfidentialReport(caseId, {
        known_proposer_since: knownSince || undefined,
        relationship_to_proposer: relationship || undefined,
        purpose_of_insurance: purpose || undefined,
        financial_interest_explained: financialInterestExplained,
        adverse_info_known: adverseInfoKnown,
        adverse_info_details: adverseInfoDetails || undefined,
        occupation_verified: occupationVerified,
        income_source_verified: incomeSourceVerified,
        estimated_income_opinion: estimatedIncome ? Number(estimatedIncome) : undefined,
        income_consistency_note: incomeNote || undefined,
        health_appearance_note: healthNote || undefined,
        hazardous_activity_known: hazardousKnown,
        recommendation,
        remarks: remarks || undefined,
      });
      await submitConfidentialReport(caseId);
      Alert.alert('Submitted', "Agent's Confidential Report submitted.", [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to submit report');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Text style={styles.subtitle}>Loading…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Agent's Confidential Report</Text>
        <Text style={styles.subtitle}>{applicantName ?? 'Applicant'}</Text>

        {alreadySubmitted && (
          <View style={styles.lockedBanner}>
            <Text style={styles.lockedBannerText}>This report has already been submitted and is locked.</Text>
          </View>
        )}

        <View style={[styles.form, alreadySubmitted && styles.disabledForm]} pointerEvents={alreadySubmitted ? 'none' : 'auto'}>
          <Text style={styles.sectionTitle}>Moral Hazard</Text>
          <Input label="How long have you known the proposer?" placeholder="e.g. 3 years" value={knownSince} onChangeText={setKnownSince} />
          <Input label="Relationship to proposer" placeholder="e.g. Referred client" value={relationship} onChangeText={setRelationship} />
          <Input label="Purpose of insurance" placeholder="e.g. Family protection" value={purpose} onChangeText={setPurpose} />
          <ToggleRow label="Financial interest explained to proposer" value={financialInterestExplained} onChange={setFinancialInterestExplained} />
          <ToggleRow label="Aware of adverse information about proposer" value={adverseInfoKnown} onChange={setAdverseInfoKnown} />
          {adverseInfoKnown && (
            <Input label="Adverse info details" value={adverseInfoDetails} onChangeText={setAdverseInfoDetails} multiline numberOfLines={3} />
          )}

          <Text style={styles.sectionTitle}>Financial Standing</Text>
          <ToggleRow label="Occupation verified in person" value={occupationVerified} onChange={setOccupationVerified} />
          <ToggleRow label="Source of income verified" value={incomeSourceVerified} onChange={setIncomeSourceVerified} />
          <Input label="Your estimate of income (PKR/yr)" keyboardType="numeric" value={estimatedIncome} onChangeText={setEstimatedIncome} />
          <Input label="Income consistency note" value={incomeNote} onChangeText={setIncomeNote} multiline numberOfLines={3} />

          <Text style={styles.sectionTitle}>General Lifestyle</Text>
          <Input label="Health / appearance note" value={healthNote} onChangeText={setHealthNote} multiline numberOfLines={3} />
          <ToggleRow label="Aware of undisclosed hazardous activity" value={hazardousKnown} onChange={setHazardousKnown} />

          <Text style={styles.sectionTitle}>Recommendation</Text>
          <View style={styles.pillRow}>
            {RECOMMENDATIONS.map((r) => (
              <TouchableOpacity
                key={r.value}
                style={[styles.pill, recommendation === r.value && styles.pillActive]}
                onPress={() => setRecommendation(r.value)}
              >
                <Text style={[styles.pillText, recommendation === r.value && styles.pillTextActive]}>{r.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Input label="Remarks" value={remarks} onChangeText={setRemarks} multiline numberOfLines={3} />

          <Button title="Submit ACR" onPress={handleSubmit} loading={submitting} style={{ marginTop: 8 }} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#ffffff' },
  container: { padding: 20 },
  title: { fontSize: 22, fontWeight: '800', color: '#0f172a' },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 16 },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#334155', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12, marginBottom: 8 },
  form: { gap: 4 },
  disabledForm: { opacity: 0.5 },
  lockedBanner: { backgroundColor: '#fef3c7', borderColor: '#fde68a', borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12 },
  lockedBannerText: { fontSize: 12, fontWeight: '600', color: '#78350f' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  toggleLabel: { flex: 1, fontSize: 13, color: '#334155', marginRight: 12 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  pillActive: { backgroundColor: '#1D4ED8', borderColor: '#1D4ED8' },
  pillText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  pillTextActive: { color: '#ffffff' },
});
