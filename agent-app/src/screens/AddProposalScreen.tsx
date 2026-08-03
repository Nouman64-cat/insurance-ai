import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Input from '../components/Input';
import Button from '../components/Button';
import { createProposal } from '../api/proposals';
import { useNavigation } from '@react-navigation/native';

export default function AddProposalScreen() {
  const [customerName, setCustomerName] = useState('');
  const [cnic, setCnic] = useState('');
  const [productName, setProductName] = useState('Term Life Plus');
  const [coverageAmount, setCoverageAmount] = useState('5000000');
  const [termYears, setTermYears] = useState('20');
  const [loading, setLoading] = useState(false);
  const navigation = useNavigation<any>();

  const handleSubmit = async () => {
    if (!customerName || !coverageAmount) {
      Alert.alert('Error', 'Please fill in Customer Name and Coverage Amount');
      return;
    }

    setLoading(true);
    try {
      await createProposal({
        customer_name: customerName,
        customer_cnic: cnic || undefined,
        product_name: productName,
        coverage_amount: Number(coverageAmount),
        term_years: Number(termYears),
      });
      Alert.alert('Success', 'Proposal created successfully', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to create proposal');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Create Proposal</Text>
        <Text style={styles.subtitle}>Define insurance terms for applicant</Text>

        <View style={styles.form}>
          <Input
            label="Customer Name"
            placeholder="e.g. Ahmed Khan"
            value={customerName}
            onChangeText={setCustomerName}
          />
          <Input
            label="CNIC (Optional)"
            placeholder="35201-1234567-1"
            value={cnic}
            onChangeText={setCnic}
          />
          <Input
            label="Product Name"
            placeholder="e.g. Term Life Plus"
            value={productName}
            onChangeText={setProductName}
          />
          <Input
            label="Coverage Amount (PKR)"
            placeholder="5000000"
            keyboardType="numeric"
            value={coverageAmount}
            onChangeText={setCoverageAmount}
          />
          <Input
            label="Term Duration (Years)"
            placeholder="20"
            keyboardType="numeric"
            value={termYears}
            onChangeText={setTermYears}
          />

          <Button
            title="Create Proposal"
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
