import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Input from '../components/Input';
import Button from '../components/Button';
import { createCase } from '../api/cases';
import { useNavigation } from '@react-navigation/native';

export default function AddCaseScreen() {
  const [applicantName, setApplicantName] = useState('');
  const [cnic, setCnic] = useState('');
  const [caseType, setCaseType] = useState('Underwriting');
  const [priority, setPriority] = useState('Normal');
  const [loading, setLoading] = useState(false);
  const navigation = useNavigation<any>();

  const handleSubmit = async () => {
    if (!applicantName) {
      Alert.alert('Error', 'Please enter Applicant Name');
      return;
    }

    setLoading(true);
    try {
      await createCase({
        applicant_name: applicantName,
        customer_cnic: cnic || undefined,
        case_type: caseType,
        priority: priority,
      });
      Alert.alert('Success', 'Case created successfully', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to create case');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Create Case</Text>
        <Text style={styles.subtitle}>Open a new underwriting application case</Text>

        <View style={styles.form}>
          <Input
            label="Applicant Name"
            placeholder="e.g. Fatima Ahmed"
            value={applicantName}
            onChangeText={setApplicantName}
          />
          <Input
            label="CNIC"
            placeholder="35201-1234567-1"
            value={cnic}
            onChangeText={setCnic}
          />
          <Input
            label="Case Type"
            placeholder="Underwriting"
            value={caseType}
            onChangeText={setCaseType}
          />
          <Input
            label="Priority (Low, Normal, High, Critical)"
            placeholder="Normal"
            value={priority}
            onChangeText={setPriority}
          />

          <Button
            title="Open Case"
            onPress={handleSubmit}
            loading={loading}
            style={{ marginTop: 16 }}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 20,
  },
  form: {
    gap: 12,
  },
});
