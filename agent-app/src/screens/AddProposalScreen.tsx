import React, { useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { spacing } from '../theme/tokens';
import { useNotifications } from '../notifications/NotificationContext';
import { createProposal } from '../api/proposals';
import { fetchLeads, UnifiedLead } from '../api/leads';
import {
  Screen,
  ScreenHeader,
  Card,
  Text,
  Field,
  Select,
  Button,
  Banner,
} from '../components/ui';

const PRODUCTS = [
  { label: 'Term Life Plus', value: 'Term Life Plus', description: 'Pure protection, fixed term' },
  { label: 'Whole Life', value: 'Whole Life', description: 'Lifetime cover with cash value' },
  { label: 'Endowment', value: 'Endowment', description: 'Protection plus savings at maturity' },
  { label: 'Family Floater Health', value: 'Family Floater Health', description: 'One sum insured for the household' },
  { label: 'Group Health', value: 'Group Health', description: 'Employer-sponsored corporate cover' },
];

const TERMS = [5, 10, 15, 20, 25, 30].map((y) => ({
  label: `${y} years`,
  value: String(y),
}));

/** Renders 5000000 as "50.00 Lac" so an agent can sanity-check the zeros. */
const describeAmount = (raw: string): string | undefined => {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) return undefined;
  if (value >= 10_000_000) return `${(value / 10_000_000).toFixed(2)} Crore`;
  if (value >= 100_000) return `${(value / 100_000).toFixed(2)} Lac`;
  return value.toLocaleString();
};

const formatCnic = (val: string) => {
  const digits = val.replace(/\D/g, '');
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12, 13)}`;
};

export default function AddProposalScreen() {
  const navigation = useNavigation<any>();
  const { toast } = useNotifications();

  const [customerName, setCustomerName] = useState('');
  const [cnic, setCnic] = useState('');
  const [productName, setProductName] = useState(PRODUCTS[0].value);
  const [coverageAmount, setCoverageAmount] = useState('5000000');
  const [termYears, setTermYears] = useState('20');

  const [errors, setErrors] = useState<{ customerName?: string; coverageAmount?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState<string>('');

  React.useEffect(() => {
    fetchLeads().then(setLeads).catch(console.error);
  }, []);

  const leadOptions = React.useMemo(() => {
    return leads
      .filter((l) => l.type === 'INDIVIDUAL')
      .map((l) => ({
        label: l.name,
        value: l.id,
        description: l.primaryIdentifier ? `CNIC: ${l.primaryIdentifier}` : 'No CNIC',
        icon: 'person-outline' as any,
      }));
  }, [leads]);

  const handleLeadSelect = (val: string) => {
    setSelectedLeadId(val);
    if (!val) {
      setCustomerName('');
      setCnic('');
      return;
    }
    const lead = leads.find((l) => l.id === val);
    if (lead) {
      setCustomerName(lead.name);
      if (lead.primaryIdentifier) {
        setCnic(formatCnic(lead.primaryIdentifier));
      } else {
        setCnic('');
      }
      setErrors({});
    }
  };

  const submit = useCallback(async () => {
    const next: typeof errors = {};
    if (!customerName.trim()) next.customerName = 'Customer name is required.';
    const coverage = Number(coverageAmount);
    if (!coverageAmount.trim()) next.coverageAmount = 'Coverage amount is required.';
    else if (!Number.isFinite(coverage) || coverage <= 0)
      next.coverageAmount = 'Enter an amount above zero.';

    setErrors(next);
    if (Object.keys(next).length > 0) {
      toast('Check the highlighted fields', { tone: 'warning', icon: 'alert-circle' });
      return;
    }

    setSaving(true);
    setSubmitError(null);
    try {
      await createProposal({
        customer_name: customerName.trim(),
        customer_cnic: cnic.trim() || undefined,
        product_name: productName,
        coverage_amount: coverage,
        term_years: Number(termYears),
      });
      toast('Proposal created', { tone: 'success', icon: 'checkmark-circle' });
      // The Proposals screen refetches on focus, so going back is enough.
      navigation.goBack();
    } catch (err: any) {
      setSubmitError(err?.message ?? 'Could not create the proposal.');
    } finally {
      setSaving(false);
    }
  }, [customerName, cnic, productName, coverageAmount, termYears, toast, navigation]);

  const amountHint = describeAmount(coverageAmount);

  return (
    <Screen
      keyboardAvoiding
      header={
        <ScreenHeader
          title="New Proposal"
          subtitle="Quote coverage for an applicant"
          leading="back"
        />
      }
      footer={
        <Button
          title={saving ? 'Creating…' : 'Create proposal'}
          onPress={submit}
          loading={saving}
          size="lg"
          fullWidth
          icon="checkmark"
        />
      }
    >
      {submitError ? (
        <Banner
          tone="danger"
          title="Could not create the proposal"
          description={submitError}
          onDismiss={() => setSubmitError(null)}
          style={styles.banner}
        />
      ) : null}

      <Card padding="lg" style={styles.card}>
        <Select
          label="Existing Lead (Optional)"
          placeholder="Select to auto-fill..."
          value={selectedLeadId}
          onSelect={handleLeadSelect}
          options={leadOptions}
          searchable
          clearable
          leftIcon="people-outline"
          helperText="Pick a lead to quickly populate applicant details."
        />
        <Field
          label="Customer name"
          required
          placeholder="Ahmed Khan"
          value={customerName}
          onChangeText={(v) => {
            setCustomerName(v);
            if (errors.customerName) setErrors((e) => ({ ...e, customerName: undefined }));
          }}
          error={errors.customerName}
          leftIcon="person-outline"
          autoCapitalize="words"
        />
        <Field
          label="CNIC"
          placeholder="35201-1234567-1"
          value={cnic}
          onChangeText={(v) => setCnic(formatCnic(v))}
          maxLength={15}
          leftIcon="card-outline"
          keyboardType="numbers-and-punctuation"
          helperText="Optional — helps match the proposal to an existing customer."
        />
        <Select
          label="Product"
          value={productName}
          onSelect={setProductName}
          options={PRODUCTS}
          required
          leftIcon="shield-checkmark-outline"
        />
        <Field
          label="Coverage amount (PKR)"
          required
          placeholder="5000000"
          keyboardType="number-pad"
          leftIcon="cash-outline"
          value={coverageAmount}
          onChangeText={(v) => {
            setCoverageAmount(v);
            if (errors.coverageAmount) setErrors((e) => ({ ...e, coverageAmount: undefined }));
          }}
          error={errors.coverageAmount}
          helperText={amountHint ? `PKR ${amountHint}` : undefined}
        />
        <Select label="Policy term" value={termYears} onSelect={setTermYears} options={TERMS} required />
      </Card>

      <View style={styles.note}>
        <Text variant="caption" color="subtle" align="center">
          The premium is calculated by the pricing engine once the proposal is created.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: spacing.lg,
  },
  card: {
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
  },
  note: {
    marginBottom: spacing.xxl,
  },
});
