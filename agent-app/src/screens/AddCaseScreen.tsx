import React, { useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { spacing } from '../theme/tokens';
import { useNotifications } from '../notifications/NotificationContext';
import { createCase } from '../api/cases';
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
  Badge,
} from '../components/ui';

const CASE_TYPES = [
  { label: 'Underwriting', value: 'Underwriting', description: 'Standard new-business assessment' },
  { label: 'Renewal', value: 'Renewal', description: 'Re-underwriting an existing policy' },
  { label: 'Reinstatement', value: 'Reinstatement', description: 'Bringing a lapsed policy back' },
  { label: 'Endorsement', value: 'Endorsement', description: 'Changing an in-force policy' },
];

const PRIORITIES = [
  { label: 'Low', value: 'Low', description: 'No particular time pressure' },
  { label: 'Normal', value: 'Normal', description: 'Standard turnaround' },
  { label: 'High', value: 'High', description: 'Ahead of the standard queue' },
  { label: 'Critical', value: 'Critical', description: 'Escalate immediately' },
];

const PRIORITY_TONE = {
  Low: 'neutral',
  Normal: 'brand',
  High: 'warning',
  Critical: 'danger',
} as const;

const formatCnic = (val: string) => {
  const digits = val.replace(/\D/g, '');
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12, 13)}`;
};

export default function AddCaseScreen() {
  const navigation = useNavigation<any>();
  const { toast } = useNotifications();

  const [applicantName, setApplicantName] = useState('');
  const [cnic, setCnic] = useState('');
  const [caseType, setCaseType] = useState(CASE_TYPES[0].value);
  const [priority, setPriority] = useState('Normal');

  const [errors, setErrors] = useState<{ applicantName?: string; cnic?: string }>({});
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
      setApplicantName('');
      setCnic('');
      return;
    }
    const lead = leads.find((l) => l.id === val);
    if (lead) {
      setApplicantName(lead.name);
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
    
    if (!applicantName.trim()) {
      next.applicantName = 'Applicant name is required.';
    }

    const trimmedCnic = cnic.trim();
    if (trimmedCnic && !/^\d{5}-\d{7}-\d{1}$/.test(trimmedCnic)) {
      next.cnic = 'CNIC must be in XXXXX-XXXXXXX-X format.';
    }

    setErrors(next);
    if (Object.keys(next).length > 0) {
      toast('Check the highlighted fields', { tone: 'warning', icon: 'alert-circle' });
      return;
    }

    setSaving(true);
    setSubmitError(null);
    try {
      await createCase({
        applicant_name: applicantName.trim(),
        customer_cnic: cnic.trim() || undefined,
        case_type: caseType,
        priority,
        customer_id: selectedLeadId || undefined,
      });
      toast('Case created', { tone: 'success', icon: 'checkmark-circle' });
      // The Cases screen refetches on focus, so going back is enough.
      navigation.goBack();
    } catch (err: any) {
      setSubmitError(err?.message ?? 'Could not create the case.');
    } finally {
      setSaving(false);
    }
  }, [applicantName, cnic, caseType, priority, selectedLeadId, toast, navigation]);

  return (
    <Screen
      keyboardAvoiding
      header={
        <ScreenHeader
          title="New Case"
          subtitle="Open an underwriting application"
          leading="back"
        />
      }
      footer={
        <Button
          title={saving ? 'Creating…' : 'Create case'}
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
          title="Could not create the case"
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
          label="Applicant name"
          required
          placeholder="Fatima Ahmed"
          value={applicantName}
          onChangeText={(v) => {
            setApplicantName(v);
            if (errors.applicantName) setErrors({});
          }}
          error={errors.applicantName}
          leftIcon="person-outline"
          autoCapitalize="words"
        />
        <Field
          label="CNIC"
          placeholder="35201-1234567-1"
          value={cnic}
          onChangeText={(v) => {
            const formatted = formatCnic(v);
            setCnic(formatted);
            if (errors.cnic) setErrors((e) => ({ ...e, cnic: undefined }));
          }}
          error={errors.cnic}
          maxLength={15}
          leftIcon="card-outline"
          keyboardType="numbers-and-punctuation"
          helperText="Optional — links the case to an existing customer record."
        />
        <Select
          label="Case type"
          value={caseType}
          onSelect={setCaseType}
          options={CASE_TYPES}
          required
          leftIcon="albums-outline"
        />
        <Select
          label="Priority"
          value={priority}
          onSelect={setPriority}
          options={PRIORITIES}
          required
          leftIcon="flag-outline"
        />
        <Badge
          label={`${priority} priority`}
          tone={PRIORITY_TONE[priority as keyof typeof PRIORITY_TONE] ?? 'neutral'}
          variant="soft"
          icon="flag-outline"
        />
      </Card>

      <View style={styles.note}>
        <Text variant="caption" color="subtle" align="center">
          The case is assigned to you and appears in the web portal immediately.
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
