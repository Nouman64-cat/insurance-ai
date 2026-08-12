import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeContext';
import { spacing } from '../theme/tokens';
import { entityLabel } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { useLeadSync } from '../sync/LeadSyncProvider';
import {
  createIndividualLead,
  createFamilyLead,
  createCorporateLead,
  fetchBranches,
  fetchInsurancePlans,
  EntityType,
  Branch,
  InsurancePlan,
} from '../api/leads';
import { RootStackParamList } from '../navigation/AppNavigator';
import Accordion from '../components/Accordion';
import CheckboxCard from '../components/CheckboxCard';
import {
  Screen,
  ScreenHeader,
  Text,
  Card,
  Field,
  Select,
  Button,
  Banner,
  Badge,
  Divider,
} from '../components/ui';

type AddLeadNav = NativeStackNavigationProp<RootStackParamList, 'AddLead'>;
type AddLeadRoute = RouteProp<RootStackParamList, 'AddLead'>;
type LeadDepth = 'quick' | 'normal';

const PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Gilgit-Baltistan',
  'Azad Jammu & Kashmir',
  'Islamabad Capital Territory',
].map((p) => ({ label: p, value: p }));

const GENDERS = ['Male', 'Female', 'Other'].map((g) => ({ label: g, value: g }));
const MARITAL = ['Single', 'Married', 'Divorced', 'Widowed'].map((m) => ({ label: m, value: m }));
const SMOKING = ['Non-smoker', 'Former smoker', 'Occasional smoker', 'Regular smoker'].map((s) => ({
  label: s,
  value: s,
}));
const ALCOHOL = ['None', 'Occasional', 'Moderate', 'Frequent'].map((a) => ({ label: a, value: a }));
const EXERCISE = ['Sedentary', 'Light', 'Moderate', 'Active', 'Very active'].map((e) => ({
  label: e,
  value: e,
}));
const RELATIONSHIPS = ['Spouse', 'Child', 'Parent', 'Sibling', 'Other'].map((r) => ({
  label: r,
  value: r,
}));

/** Empty for every field, so `resetForm` and the initial state cannot drift. */
const EMPTY_FORM = {
  // Individual
  firstName: '', lastName: '', phone: '', cnic: '', dob: '', gender: 'Male',
  maritalStatus: 'Single', nationality: 'Pakistani', occupation: '', declaredIncome: '',
  cnicIssueDate: '', cnicExpiryDate: '', employerName: '', industrySector: '',
  yearsOfExperience: '', height: '', weight: '', exerciseFrequency: 'Sedentary',
  smokingStatus: 'Non-smoker', alcoholConsumption: 'None', creditScore: '',
  beneficiaryFirstName: '', beneficiaryLastName: '', beneficiaryCnic: '',
  beneficiaryRelationship: 'Spouse', beneficiaryShare: '100',
  streetAddress: '', postalCode: '', emergencyContactName: '',
  travelDestinations: '', movingViolations: '', extremeSports: '',
  // Family
  familyName: '', householdIncome: '',
  // Corporate
  companyName: '', registrationNumber: '', industry: '',
  // Shared
  contactPerson: '', contactPhone: '', contactEmail: '',
  city: '', province: '', branch: '', insurancePlanId: '',
};

type FormState = typeof EMPTY_FORM;
type FormErrors = Partial<Record<keyof FormState, string>>;

const EMPTY_FLAGS = {
  recreationalDrugUse: false,
  participatesExtremeSports: false,
  privateAviation: false,
  frequentHighRiskTravel: false,
};

/** `YYYY-MM-DD`, and a real calendar date rather than just the right shape. */
const isValidDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && value === parsed.toISOString().slice(0, 10);
};

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
/** Pakistani mobile numbers, tolerating spaces, dashes and a +92 prefix. */
const isValidPhone = (value: string) => /^\+?[\d\s-]{10,15}$/.test(value.trim());
const isValidCnic = (value: string) => /^\d{5}-\d{7}-\d{1}$/.test(value.trim());
/** Auto-inserts the CNIC's dashes as the agent types digits. */
const formatCnic = (val: string) => {
  const digits = val.replace(/\D/g, '');
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12, 13)}`;
};

export default function AddLeadScreen() {
  const route = useRoute<AddLeadRoute>();
  const navigation = useNavigation<AddLeadNav>();
  const { colors } = useTheme();
  const { isCompact } = useResponsive();
  const { user } = useSession();
  const { toast } = useNotifications();
  const { refresh } = useLeadSync();

  const type: EntityType = route.params?.type ?? 'INDIVIDUAL';
  const depth: LeadDepth = route.params?.category ?? 'quick';
  const isFull = depth === 'normal';

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [flags, setFlags] = useState(EMPTY_FLAGS);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [plans, setPlans] = useState<InsurancePlan[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Both helpers swallow their own errors and resolve to [], so the form
    // still works when the lookup endpoints are unavailable.
    fetchBranches().then((data) => !cancelled && setBranches(data));
    fetchInsurancePlans().then((data) => !cancelled && setPlans(data));
    return () => {
      cancelled = true;
    };
  }, []);

  const set = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      // Clearing on edit means the user sees the error resolve as they fix it,
      // rather than only after another submit.
      setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    },
    []
  );

  const toggleFlag = useCallback((key: keyof typeof EMPTY_FLAGS) => {
    setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // ── Validation ─────────────────────────────────────────────────────────────

  const validate = useCallback((): boolean => {
    const next: FormErrors = {};

    if (type === 'INDIVIDUAL') {
      if (!form.firstName.trim()) next.firstName = 'First name is required.';
      if (form.phone && !isValidPhone(form.phone)) next.phone = 'Enter a valid phone number.';
      if (!form.cnic.trim()) next.cnic = 'CNIC is required.';
      else if (!isValidCnic(form.cnic)) next.cnic = 'Use the format XXXXX-XXXXXXX-X.';
      if (isFull) {
        if (!form.lastName.trim()) next.lastName = 'Last name is required.';
        if (!form.dob.trim()) next.dob = 'Date of birth is required.';
        else if (!isValidDate(form.dob)) next.dob = 'Use the format YYYY-MM-DD.';
        if (!form.occupation.trim()) next.occupation = 'Occupation is required.';
        if (!form.declaredIncome.trim()) next.declaredIncome = 'Declared income is required.';
        else if (Number(form.declaredIncome) <= 0) next.declaredIncome = 'Enter an amount above zero.';
        if (form.cnicIssueDate && !isValidDate(form.cnicIssueDate))
          next.cnicIssueDate = 'Use the format YYYY-MM-DD.';
        if (form.cnicExpiryDate && !isValidDate(form.cnicExpiryDate))
          next.cnicExpiryDate = 'Use the format YYYY-MM-DD.';
        const share = Number(form.beneficiaryShare);
        if (form.beneficiaryShare && (Number.isNaN(share) || share <= 0 || share > 100))
          next.beneficiaryShare = 'Share must be between 1 and 100.';
      }
    } else if (type === 'FAMILY') {
      if (!form.familyName.trim()) next.familyName = 'Family name is required.';
      if (form.contactPhone && !isValidPhone(form.contactPhone))
        next.contactPhone = 'Enter a valid phone number.';
    } else {
      if (!form.companyName.trim()) next.companyName = 'Company name is required.';
      if (form.contactPhone && !isValidPhone(form.contactPhone))
        next.contactPhone = 'Enter a valid phone number.';
    }

    if (form.contactEmail && !isValidEmail(form.contactEmail))
      next.contactEmail = 'Enter a valid email address.';

    setErrors(next);
    return Object.keys(next).length === 0;
  }, [form, type, isFull]);

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSubmitError(null);
    if (!validate()) {
      toast('Check the highlighted fields', { tone: 'warning', icon: 'alert-circle' });
      return;
    }

    setSaving(true);
    try {
      const shared = { leadCategory: depth, ...form, ...flags };

      let res;
      if (type === 'INDIVIDUAL') {
        res = await createIndividualLead(shared);
      } else if (type === 'FAMILY') {
        res = await createFamilyLead({ ...shared, name: form.familyName });
      } else {
        res = await createCorporateLead({ ...shared, name: form.companyName });
      }

      // Pull the new row in immediately so the Leads board is already correct
      // when the user lands back on it, rather than after the next poll tick.
      await refresh();

      const newLeadId = res?.data?.id;

      navigation.goBack();

      toast('Lead created', {
        body: 'It is now visible in the portal too.',
        tone: 'success',
        icon: 'checkmark-circle',
        actionLabel: newLeadId ? 'VIEW detail' : undefined,
        onPress: newLeadId ? () => navigation.navigate('LeadDetail', { leadId: newLeadId }) : undefined,
      });
    } catch (err: any) {
      setSubmitError(err?.message ?? 'Could not create the lead. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [validate, depth, form, flags, type, refresh, toast, navigation]);

  // ── Field groups ───────────────────────────────────────────────────────────

  const branchOptions = useMemo(
    () => branches.map((b) => ({ label: b.name, value: b.id, description: b.branch_code })),
    [branches]
  );
  const planOptions = useMemo(
    () => plans.map((p) => ({ label: p.label, value: p.id, description: p.description })),
    [plans]
  );

  /** Owner, branch and plan — identical across all three entity types. */
  const administrative = (
    <>
      <Select
        label="Branch"
        placeholder="Select a branch"
        value={form.branch}
        onSelect={(v) => set('branch', v)}
        options={branchOptions}
        leftIcon="business-outline"
        clearable
        helperText={branchOptions.length === 0 ? 'No branches configured for this tenant.' : undefined}
      />
      <Field
        label="Assigned agent"
        value={user?.fullName ?? ''}
        editable={false}
        leftIcon="person-outline"
        helperText="New leads are assigned to you automatically."
      />
    </>
  );

  const addressFields = (
    <>
      <Field label="City" placeholder="Lahore" value={form.city} onChangeText={(v) => set('city', v)} leftIcon="location-outline" />
      <Select
        label="Province"
        placeholder="Select a province"
        value={form.province}
        onSelect={(v) => set('province', v)}
        options={PROVINCES}
        clearable
      />
    </>
  );

  return (
    <Screen
      keyboardAvoiding
      fabClearance
      header={
        <ScreenHeader
          title={`New ${entityLabel[type] ?? type} Lead`}
          subtitle={isFull ? 'Full underwriting profile' : 'Quick capture'}
          leading="back"
        />
      }
      footer={
        <Button
          title={saving ? 'Creating…' : `Create ${isFull ? 'full' : 'quick'} lead`}
          onPress={handleSave}
          loading={saving}
          size="lg"
          fullWidth
          icon="checkmark"
        />
      }
    >
      <View style={styles.intro}>
        <Badge
          label={isFull ? 'Full profile' : 'Quick lead'}
          tone={isFull ? 'brand' : 'warning'}
          variant="soft"
          icon={isFull ? 'document-text-outline' : 'timer-outline'}
        />
        <Text variant="caption" color="muted" style={styles.introText}>
          {isFull
            ? 'Everything underwriting needs. You can still edit any of it later.'
            : 'Capture the essentials now — you can complete the full profile at any time.'}
        </Text>
      </View>

      {submitError ? (
        <Banner
          tone="danger"
          title="Could not create the lead"
          description={submitError}
          onDismiss={() => setSubmitError(null)}
          style={styles.banner}
        />
      ) : null}

      {/* ── Individual ────────────────────────────────────────────────────── */}

      {type === 'INDIVIDUAL' && !isFull ? (
        <Card padding="lg" style={styles.card}>
          <View style={isCompact ? undefined : styles.nameRow}>
            <Field
              label="First name"
              required
              placeholder="Ali"
              value={form.firstName}
              onChangeText={(v) => set('firstName', v)}
              error={errors.firstName}
              containerStyle={isCompact ? undefined : styles.half}
              autoCapitalize="words"
            />
            <Field
              label="Last name"
              placeholder="Khan"
              value={form.lastName}
              onChangeText={(v) => set('lastName', v)}
              error={errors.lastName}
              containerStyle={isCompact ? undefined : styles.half}
              autoCapitalize="words"
            />
          </View>
          <Field
            label="Phone number"
            placeholder="0300 1234567"
            keyboardType="phone-pad"
            leftIcon="call-outline"
            value={form.phone}
            onChangeText={(v) => set('phone', v)}
            error={errors.phone}
          />
          <Field
            label="CNIC number"
            required
            placeholder="35201-1234567-8"
            keyboardType="numbers-and-punctuation"
            leftIcon="card-outline"
            value={form.cnic}
            onChangeText={(v) => set('cnic', formatCnic(v))}
            error={errors.cnic}
            maxLength={15}
            helperText="Required — identifies this lead uniquely and prevents duplicate profiles."
          />
        </Card>
      ) : null}

      {type === 'INDIVIDUAL' && isFull ? (
        <>
          <Accordion title="Identity & contact" icon="person-outline" tone="brand" defaultExpanded>
            <View style={isCompact ? undefined : styles.nameRow}>
              <Field
                label="First name"
                required
                placeholder="Ali"
                value={form.firstName}
                onChangeText={(v) => set('firstName', v)}
                error={errors.firstName}
                containerStyle={isCompact ? undefined : styles.half}
                autoCapitalize="words"
              />
              <Field
                label="Last name"
                required
                placeholder="Khan"
                value={form.lastName}
                onChangeText={(v) => set('lastName', v)}
                error={errors.lastName}
                containerStyle={isCompact ? undefined : styles.half}
                autoCapitalize="words"
              />
            </View>
            <Field
              label="Date of birth"
              required
              placeholder="1990-05-21"
              value={form.dob}
              onChangeText={(v) => set('dob', v)}
              error={errors.dob}
              helperText="Format: YYYY-MM-DD"
              leftIcon="calendar-outline"
              keyboardType="numbers-and-punctuation"
            />
            <Select label="Gender" value={form.gender} onSelect={(v) => set('gender', v)} options={GENDERS} required />
            <Select
              label="Marital status"
              value={form.maritalStatus}
              onSelect={(v) => set('maritalStatus', v)}
              options={MARITAL}
            />
            <Field
              label="Nationality"
              value={form.nationality}
              onChangeText={(v) => set('nationality', v)}
              leftIcon="flag-outline"
            />

            <Divider label="Contact" />

            <Field
              label="Mobile number"
              placeholder="0300 1234567"
              keyboardType="phone-pad"
              leftIcon="call-outline"
              value={form.phone}
              onChangeText={(v) => set('phone', v)}
              error={errors.phone}
            />
            <Field
              label="Email address"
              placeholder="ali@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              leftIcon="mail-outline"
              value={form.contactEmail}
              onChangeText={(v) => set('contactEmail', v)}
              error={errors.contactEmail}
            />
            <Field
              label="Emergency contact name"
              placeholder="Ayesha Khan"
              value={form.emergencyContactName}
              onChangeText={(v) => set('emergencyContactName', v)}
              autoCapitalize="words"
            />

            <Divider label="Address" />

            <Field
              label="Street address"
              placeholder="123 Main Street"
              value={form.streetAddress}
              onChangeText={(v) => set('streetAddress', v)}
            />
            {addressFields}
            <Field
              label="Postal code"
              placeholder="54000"
              keyboardType="number-pad"
              value={form.postalCode}
              onChangeText={(v) => set('postalCode', v)}
            />

            <Divider label="Administrative" />
            {administrative}
          </Accordion>

          <Accordion title="CNIC & documents" icon="card-outline" tone="accent">
            <Field
              label="CNIC number"
              required
              placeholder="35201-1234567-8"
              keyboardType="numbers-and-punctuation"
              leftIcon="card-outline"
              value={form.cnic}
              onChangeText={(v) => set('cnic', formatCnic(v))}
              error={errors.cnic}
              maxLength={15}
              helperText="Required — identifies this lead uniquely and prevents duplicate profiles."
            />
            <Field
              label="CNIC issue date"
              placeholder="2015-03-10"
              value={form.cnicIssueDate}
              onChangeText={(v) => set('cnicIssueDate', v)}
              error={errors.cnicIssueDate}
              keyboardType="numbers-and-punctuation"
            />
            <Field
              label="CNIC expiry date"
              placeholder="2025-03-10"
              value={form.cnicExpiryDate}
              onChangeText={(v) => set('cnicExpiryDate', v)}
              error={errors.cnicExpiryDate}
              keyboardType="numbers-and-punctuation"
            />
            <Banner
              tone="info"
              title="Document upload"
              description="CNIC scans are captured during the e-application step, once the lead becomes a case."
              icon="cloud-upload-outline"
            />
          </Accordion>

          <Accordion title="Occupation & income" icon="briefcase-outline" tone="success">
            <Field
              label="Occupation"
              required
              placeholder="Software Engineer"
              value={form.occupation}
              onChangeText={(v) => set('occupation', v)}
              error={errors.occupation}
              autoCapitalize="words"
            />
            <Field
              label="Employer name"
              placeholder="TechCorp"
              value={form.employerName}
              onChangeText={(v) => set('employerName', v)}
              autoCapitalize="words"
            />
            <Field
              label="Industry sector"
              placeholder="Information Technology"
              value={form.industrySector}
              onChangeText={(v) => set('industrySector', v)}
              autoCapitalize="words"
            />
            <Field
              label="Years of experience"
              placeholder="5"
              keyboardType="number-pad"
              value={form.yearsOfExperience}
              onChangeText={(v) => set('yearsOfExperience', v)}
            />
            <Field
              label="Declared annual income (PKR)"
              required
              placeholder="1200000"
              keyboardType="number-pad"
              leftIcon="cash-outline"
              value={form.declaredIncome}
              onChangeText={(v) => set('declaredIncome', v)}
              error={errors.declaredIncome}
              helperText="Drives the sum-assured eligibility check."
            />
          </Accordion>

          <Accordion title="Medical & lifestyle" icon="fitness-outline" tone="info">
            <View style={isCompact ? undefined : styles.nameRow}>
              <Field
                label="Height (cm)"
                placeholder="175"
                keyboardType="decimal-pad"
                value={form.height}
                onChangeText={(v) => set('height', v)}
                containerStyle={isCompact ? undefined : styles.half}
              />
              <Field
                label="Weight (kg)"
                placeholder="70"
                keyboardType="decimal-pad"
                value={form.weight}
                onChangeText={(v) => set('weight', v)}
                containerStyle={isCompact ? undefined : styles.half}
              />
            </View>
            <Select
              label="Exercise frequency"
              value={form.exerciseFrequency}
              onSelect={(v) => set('exerciseFrequency', v)}
              options={EXERCISE}
            />
          </Accordion>

          <Accordion title="Habit check" icon="warning-outline" tone="warning">
            <Banner
              tone="danger"
              title="Substance consumption"
              description="These answers feed directly into mortality pricing, so accuracy matters."
              icon="flame-outline"
              style={styles.groupBanner}
            />
            <Select
              label="Smoking status"
              value={form.smokingStatus}
              onSelect={(v) => set('smokingStatus', v)}
              options={SMOKING}
            />
            <Select
              label="Alcohol consumption"
              value={form.alcoholConsumption}
              onSelect={(v) => set('alcoholConsumption', v)}
              options={ALCOHOL}
            />
            <CheckboxCard
              title="Recreational drug use in the past 3–5 years"
              subtitle="Includes illegal and non-prescribed substances."
              checked={flags.recreationalDrugUse}
              onPress={() => toggleFlag('recreationalDrugUse')}
            />

            <Banner
              tone="warning"
              title="High-risk hobbies"
              description="Activities with materially elevated fatality rates."
              icon="timer-outline"
              style={styles.groupBanner}
            />
            <CheckboxCard
              title="Participates in extreme sports"
              subtitle="Skydiving, mountaineering, motorsport and similar."
              checked={flags.participatesExtremeSports}
              onPress={() => toggleFlag('participatesExtremeSports')}
            />
            <CheckboxCard
              title="Private aviation"
              subtitle="Flies private or experimental aircraft. Commercial passengers are exempt."
              checked={flags.privateAviation}
              onPress={() => toggleFlag('privateAviation')}
            />
            <Field
              label="Extreme sports details"
              placeholder="Skydiving, scuba diving"
              value={form.extremeSports}
              onChangeText={(v) => set('extremeSports', v)}
              editable={flags.participatesExtremeSports}
              helperText={
                flags.participatesExtremeSports ? undefined : 'Tick the box above to fill this in.'
              }
            />

            <Banner
              tone="info"
              title="Travel risk"
              description="Travel to politically unstable regions or outbreak zones."
              icon="airplane-outline"
              style={styles.groupBanner}
            />
            <CheckboxCard
              title="Frequent high-risk travel"
              subtitle="Active war zones, severe outbreak areas, or politically unstable regions."
              checked={flags.frequentHighRiskTravel}
              onPress={() => toggleFlag('frequentHighRiskTravel')}
            />
            <Field
              label="Travel destinations (past or next 12 months)"
              placeholder="Dubai, London"
              value={form.travelDestinations}
              onChangeText={(v) => set('travelDestinations', v)}
            />
            <Field
              label="Moving violations (past 3 years)"
              placeholder="0"
              keyboardType="number-pad"
              value={form.movingViolations}
              onChangeText={(v) => set('movingViolations', v)}
            />
          </Accordion>

          <Accordion title="Financial profile" icon="stats-chart-outline" tone="success">
            <Field
              label="Credit score"
              placeholder="750"
              keyboardType="number-pad"
              value={form.creditScore}
              onChangeText={(v) => set('creditScore', v)}
              helperText="Optional. Used as a secondary risk signal."
            />
          </Accordion>

          <Accordion title="Nominee details" icon="people-outline" tone="accent">
            <View style={isCompact ? undefined : styles.nameRow}>
              <Field
                label="First name"
                placeholder="Ayesha"
                value={form.beneficiaryFirstName}
                onChangeText={(v) => set('beneficiaryFirstName', v)}
                containerStyle={isCompact ? undefined : styles.half}
                autoCapitalize="words"
              />
              <Field
                label="Last name"
                placeholder="Khan"
                value={form.beneficiaryLastName}
                onChangeText={(v) => set('beneficiaryLastName', v)}
                containerStyle={isCompact ? undefined : styles.half}
                autoCapitalize="words"
              />
            </View>
            <Field
              label="CNIC number"
              placeholder="35201-1234567-8"
              keyboardType="numbers-and-punctuation"
              value={form.beneficiaryCnic}
              onChangeText={(v) => set('beneficiaryCnic', v)}
            />
            <Select
              label="Relationship"
              value={form.beneficiaryRelationship}
              onSelect={(v) => set('beneficiaryRelationship', v)}
              options={RELATIONSHIPS}
            />
            <Field
              label="Share percentage"
              placeholder="100"
              keyboardType="number-pad"
              value={form.beneficiaryShare}
              onChangeText={(v) => set('beneficiaryShare', v)}
              error={errors.beneficiaryShare}
            />
          </Accordion>

          <Accordion title="Insurance plan" icon="shield-checkmark-outline" tone="brand">
            <Select
              label="Preferred plan"
              placeholder="Choose a plan"
              value={form.insurancePlanId}
              onSelect={(v) => set('insurancePlanId', v)}
              options={planOptions}
              clearable
              helperText={
                planOptions.length === 0
                  ? 'No plans configured for this tenant.'
                  : 'Optional at lead stage.'
              }
            />
          </Accordion>
        </>
      ) : null}

      {/* ── Family ────────────────────────────────────────────────────────── */}

      {type === 'FAMILY' ? (
        <Card padding="lg" style={styles.card}>
          <Field
            label="Family name"
            required
            placeholder="Rehman Family"
            value={form.familyName}
            onChangeText={(v) => set('familyName', v)}
            error={errors.familyName}
            leftIcon="people-outline"
            autoCapitalize="words"
          />
          <Field
            label="Contact person (proposer)"
            placeholder="Asad Rehman"
            value={form.contactPerson}
            onChangeText={(v) => set('contactPerson', v)}
            autoCapitalize="words"
          />
          <Field
            label="Contact phone"
            placeholder="0300 1234567"
            keyboardType="phone-pad"
            leftIcon="call-outline"
            value={form.contactPhone}
            onChangeText={(v) => set('contactPhone', v)}
            error={errors.contactPhone}
          />
          <Field
            label="Contact email"
            placeholder="family@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon="mail-outline"
            value={form.contactEmail}
            onChangeText={(v) => set('contactEmail', v)}
            error={errors.contactEmail}
          />

          {isFull ? (
            <>
              <Divider label="Household" />
              <Field
                label="Household annual income (PKR)"
                placeholder="2400000"
                keyboardType="number-pad"
                leftIcon="cash-outline"
                value={form.householdIncome}
                onChangeText={(v) => set('householdIncome', v)}
                helperText="Used for the floater's income-eligibility check — children and non-earning members have no income of their own."
              />
              {addressFields}
              <Divider label="Administrative" />
              {administrative}
            </>
          ) : null}
        </Card>
      ) : null}

      {/* ── Corporate ─────────────────────────────────────────────────────── */}

      {type === 'CORPORATE' ? (
        <Card padding="lg" style={styles.card}>
          <Field
            label="Company name"
            required
            placeholder="TechPak Solutions"
            value={form.companyName}
            onChangeText={(v) => set('companyName', v)}
            error={errors.companyName}
            leftIcon="business-outline"
            autoCapitalize="words"
          />
          <Field
            label="Contact person"
            placeholder="Ali Raza (HR)"
            value={form.contactPerson}
            onChangeText={(v) => set('contactPerson', v)}
            autoCapitalize="words"
          />
          <Field
            label="Contact phone"
            placeholder="0300 1234567"
            keyboardType="phone-pad"
            leftIcon="call-outline"
            value={form.contactPhone}
            onChangeText={(v) => set('contactPhone', v)}
            error={errors.contactPhone}
          />

          {isFull ? (
            <>
              <Divider label="Company details" />
              <Field
                label="Registration number"
                placeholder="XX-12345"
                value={form.registrationNumber}
                onChangeText={(v) => set('registrationNumber', v)}
                leftIcon="document-text-outline"
              />
              <Field
                label="Industry"
                placeholder="Software Development"
                value={form.industry}
                onChangeText={(v) => set('industry', v)}
                autoCapitalize="words"
              />
              <Field
                label="Contact email"
                placeholder="hr@company.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                leftIcon="mail-outline"
                value={form.contactEmail}
                onChangeText={(v) => set('contactEmail', v)}
                error={errors.contactEmail}
              />
              {addressFields}
              <Divider label="Administrative" />
              {administrative}
            </>
          ) : null}
        </Card>
      ) : null}

      <Text variant="caption" color="subtle" align="center" style={styles.footnote}>
        Created leads appear in the web portal immediately.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  introText: {
    flex: 1,
  },
  banner: {
    marginBottom: spacing.lg,
  },
  card: {
    marginBottom: spacing.lg,
  },
  nameRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  half: {
    flex: 1,
  },
  groupBanner: {
    marginBottom: spacing.lg,
  },
  footnote: {
    marginTop: spacing.md,
    marginBottom: spacing.xl,
  },
});
