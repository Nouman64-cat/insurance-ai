import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeContext';
import { spacing } from '../theme/tokens';
import { ToneName } from '../theme/palette';
import { useNotifications } from '../notifications/NotificationContext';
import {
  fetchConfidentialReport,
  saveConfidentialReport,
  submitConfidentialReport,
  ACRRecommendation,
  ConfidentialReportForm,
} from '../api/confidentialReport';
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
  ConfirmDialog,
  Divider,
} from '../components/ui';

type ACRRoute = RouteProp<RootStackParamList, 'AgentConfidentialReport'>;

const RECOMMENDATIONS: { value: ACRRecommendation; label: string; description: string }[] = [
  {
    value: 'Recommend',
    label: 'Recommend',
    description: 'Nothing in the proposal gives you cause for concern.',
  },
  {
    value: 'RecommendWithCaution',
    label: 'Recommend with caution',
    description: 'Proceed, but underwriting should look closely at the noted factors.',
  },
  {
    value: 'DoNotRecommend',
    label: 'Do not recommend',
    description: 'You have material concerns about this proposal.',
  },
];

const RECOMMENDATION_TONE: Record<ACRRecommendation, ToneName> = {
  Recommend: 'success',
  RecommendWithCaution: 'warning',
  DoNotRecommend: 'danger',
};

const EMPTY = {
  knownSince: '',
  relationship: '',
  purpose: '',
  adverseInfoDetails: '',
  estimatedIncome: '',
  incomeNote: '',
  healthNote: '',
  remarks: '',
};

/**
 * The Agent's Confidential Report — the agent's own signed opinion on a
 * proposal, filed alongside the customer's e-application. It locks on submit,
 * which is why the screen confirms before sending and goes read-only after.
 */
export default function AgentConfidentialReportScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<ACRRoute>();
  const { caseId, applicantName } = route.params ?? ({} as ACRRoute['params']);
  const { toast } = useNotifications();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const [text, setText] = useState(EMPTY);
  const [flags, setFlags] = useState({
    financialInterestExplained: true,
    adverseInfoKnown: false,
    occupationVerified: true,
    incomeSourceVerified: true,
    hazardousKnown: false,
  });
  const [recommendation, setRecommendation] = useState<ACRRecommendation>('Recommend');
  const [errors, setErrors] = useState<{ estimatedIncome?: string; adverseInfoDetails?: string }>({});

  const setField = useCallback(<K extends keyof typeof EMPTY>(key: K, value: string) => {
    setText((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key as keyof typeof prev] ? { ...prev, [key]: undefined } : prev));
  }, []);

  const toggle = useCallback((key: keyof typeof flags) => {
    setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  useEffect(() => {
    if (!caseId) {
      setLoadError('No case was selected, so there is nothing to report on.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetchConfidentialReport(caseId)
      .then((report) => {
        if (cancelled) return;
        setSubmitted(report.status === 'Submitted');
        setText({
          knownSince: report.known_proposer_since ?? '',
          relationship: report.relationship_to_proposer ?? '',
          purpose: report.purpose_of_insurance ?? '',
          adverseInfoDetails: report.adverse_info_details ?? '',
          estimatedIncome: report.estimated_income_opinion
            ? String(report.estimated_income_opinion)
            : '',
          incomeNote: report.income_consistency_note ?? '',
          healthNote: report.health_appearance_note ?? '',
          remarks: report.remarks ?? '',
        });
        setFlags({
          financialInterestExplained: report.financial_interest_explained ?? true,
          adverseInfoKnown: report.adverse_info_known ?? false,
          occupationVerified: report.occupation_verified ?? true,
          incomeSourceVerified: report.income_source_verified ?? true,
          hazardousKnown: report.hazardous_activity_known ?? false,
        });
        setRecommendation(report.recommendation ?? 'Recommend');
      })
      // A 404 simply means no draft exists yet, which is the normal first visit.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const buildPayload = (): ConfidentialReportForm => ({
    known_proposer_since: text.knownSince || undefined,
    relationship_to_proposer: text.relationship || undefined,
    purpose_of_insurance: text.purpose || undefined,
    financial_interest_explained: flags.financialInterestExplained,
    adverse_info_known: flags.adverseInfoKnown,
    adverse_info_details: text.adverseInfoDetails || undefined,
    occupation_verified: flags.occupationVerified,
    income_source_verified: flags.incomeSourceVerified,
    estimated_income_opinion: text.estimatedIncome ? Number(text.estimatedIncome) : undefined,
    income_consistency_note: text.incomeNote || undefined,
    health_appearance_note: text.healthNote || undefined,
    hazardous_activity_known: flags.hazardousKnown,
    recommendation,
    remarks: text.remarks || undefined,
  });

  const validate = (): boolean => {
    const next: typeof errors = {};
    if (text.estimatedIncome && !(Number(text.estimatedIncome) > 0)) {
      next.estimatedIncome = 'Enter an amount above zero, or leave it blank.';
    }
    // An adverse-information flag with no explanation is useless to underwriting.
    if (flags.adverseInfoKnown && !text.adverseInfoDetails.trim()) {
      next.adverseInfoDetails = 'Describe the adverse information you are aware of.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const saveDraft = useCallback(async () => {
    if (!caseId || !validate()) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await saveConfidentialReport(caseId, buildPayload());
      toast('Draft saved', { tone: 'success', icon: 'save-outline' });
    } catch (err: any) {
      setSubmitError(err?.message ?? 'Could not save the draft.');
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, text, flags, recommendation, toast]);

  const submit = useCallback(async () => {
    if (!caseId) return;
    setConfirmSubmit(false);
    setSaving(true);
    setSubmitError(null);
    try {
      // Save first: submit locks whatever the server currently holds, so an
      // unsaved edit would be silently dropped.
      await saveConfidentialReport(caseId, buildPayload());
      await submitConfidentialReport(caseId);
      setSubmitted(true);
      toast('Report submitted', {
        body: 'It is now locked and visible to underwriting.',
        tone: 'success',
        icon: 'checkmark-circle',
      });
      navigation.goBack();
    } catch (err: any) {
      setSubmitError(err?.message ?? 'Could not submit the report.');
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, text, flags, recommendation, toast, navigation]);

  const editable = !submitted && !saving;

  if (loading) {
    return (
      <Screen header={<ScreenHeader title="Confidential Report" leading="back" />}>
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text variant="callout" color="muted">
            Loading the report…
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      keyboardAvoiding
      header={
        <ScreenHeader
          title="Confidential Report"
          subtitle={applicantName ?? 'Agent’s own assessment'}
          leading="back"
        />
      }
      footer={
        submitted ? undefined : (
          <View style={styles.footer}>
            <Button
              title="Save draft"
              onPress={saveDraft}
              variant="outline"
              tone="neutral"
              disabled={!editable}
              style={styles.footerButton}
            />
            <Button
              title="Submit"
              onPress={() => validate() && setConfirmSubmit(true)}
              loading={saving}
              disabled={!editable}
              icon="lock-closed"
              style={styles.footerButton}
            />
          </View>
        )
      }
    >
      {loadError ? (
        <Banner tone="danger" title="Cannot open this report" description={loadError} style={styles.banner} />
      ) : null}

      {submitted ? (
        <Banner
          tone="success"
          title="Submitted and locked"
          description="This report has been filed with underwriting and can no longer be edited."
          icon="lock-closed"
          style={styles.banner}
        />
      ) : (
        <Banner
          tone="info"
          title="Your confidential assessment"
          description="Underwriting reads this alongside the customer's own application. It locks once submitted."
          icon="eye-off-outline"
          style={styles.banner}
        />
      )}

      {submitError ? (
        <Banner
          tone="danger"
          title="Could not save"
          description={submitError}
          onDismiss={() => setSubmitError(null)}
          style={styles.banner}
        />
      ) : null}

      <Accordion title="The proposer" icon="person-outline" tone="brand" defaultExpanded>
        <Field
          label="Known the proposer since"
          placeholder="2019"
          value={text.knownSince}
          onChangeText={(v) => setField('knownSince', v)}
          editable={editable}
          leftIcon="calendar-outline"
        />
        <Field
          label="Your relationship to them"
          placeholder="Existing client, referral, family friend"
          value={text.relationship}
          onChangeText={(v) => setField('relationship', v)}
          editable={editable}
        />
        <Field
          label="Purpose of the insurance"
          placeholder="Family protection, loan cover, estate planning"
          value={text.purpose}
          onChangeText={(v) => setField('purpose', v)}
          editable={editable}
          multiline
        />
        <CheckboxCard
          title="Insurable financial interest explained"
          subtitle="You confirmed the proposer understands why cover is being taken."
          checked={flags.financialInterestExplained}
          onPress={() => toggle('financialInterestExplained')}
          disabled={!editable}
        />
        <CheckboxCard
          title="Aware of adverse information"
          subtitle="Anything that could materially affect the risk."
          checked={flags.adverseInfoKnown}
          onPress={() => toggle('adverseInfoKnown')}
          disabled={!editable}
        />
        {flags.adverseInfoKnown ? (
          <Field
            label="Details of the adverse information"
            required
            placeholder="Describe what you know."
            value={text.adverseInfoDetails}
            onChangeText={(v) => setField('adverseInfoDetails', v)}
            error={errors.adverseInfoDetails}
            editable={editable}
            multiline
          />
        ) : null}
      </Accordion>

      <Accordion title="Occupation & income" icon="briefcase-outline" tone="success">
        <CheckboxCard
          title="Occupation verified"
          subtitle="You have seen evidence of the stated occupation."
          checked={flags.occupationVerified}
          onPress={() => toggle('occupationVerified')}
          disabled={!editable}
        />
        <CheckboxCard
          title="Income source verified"
          subtitle="You are satisfied the declared income is genuine."
          checked={flags.incomeSourceVerified}
          onPress={() => toggle('incomeSourceVerified')}
          disabled={!editable}
        />
        <Field
          label="Your estimate of their annual income (PKR)"
          placeholder="1200000"
          keyboardType="number-pad"
          leftIcon="cash-outline"
          value={text.estimatedIncome}
          onChangeText={(v) => setField('estimatedIncome', v)}
          error={errors.estimatedIncome}
          editable={editable}
          helperText="Your own opinion, which may differ from the declared figure."
        />
        <Field
          label="Notes on income consistency"
          placeholder="Lifestyle and stated income are consistent."
          value={text.incomeNote}
          onChangeText={(v) => setField('incomeNote', v)}
          editable={editable}
          multiline
        />
      </Accordion>

      <Accordion title="Health & activities" icon="fitness-outline" tone="info">
        <Field
          label="Notes on general appearance and health"
          placeholder="Appears in good health; no visible impairment."
          value={text.healthNote}
          onChangeText={(v) => setField('healthNote', v)}
          editable={editable}
          multiline
        />
        <CheckboxCard
          title="Aware of hazardous activities"
          subtitle="Occupation or hobbies with elevated risk."
          checked={flags.hazardousKnown}
          onPress={() => toggle('hazardousKnown')}
          disabled={!editable}
        />
      </Accordion>

      <Card padding="lg" style={styles.recommendation}>
        <Text variant="title3" style={styles.recommendationTitle}>
          Your recommendation
        </Text>
        <Divider spacingY="md" />
        <Select
          label="Recommendation"
          value={recommendation}
          onSelect={(v) => setRecommendation(v as ACRRecommendation)}
          options={RECOMMENDATIONS}
          disabled={!editable}
          required
        />
        <Badge
          label={RECOMMENDATIONS.find((r) => r.value === recommendation)?.label ?? recommendation}
          tone={RECOMMENDATION_TONE[recommendation]}
          variant="soft"
          icon="ribbon-outline"
          style={styles.recommendationBadge}
        />
        <Field
          label="Remarks"
          placeholder="Anything else underwriting should know."
          value={text.remarks}
          onChangeText={(v) => setField('remarks', v)}
          editable={editable}
          multiline
        />
      </Card>

      <ConfirmDialog
        visible={confirmSubmit}
        title="Submit this report?"
        message="Once submitted, the report is locked and cannot be edited. Underwriting will see it immediately."
        confirmLabel="Submit and lock"
        icon="lock-closed"
        loading={saving}
        onConfirm={submit}
        onCancel={() => setConfirmSubmit(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  banner: {
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
  },
  recommendation: {
    marginTop: spacing.md,
    marginBottom: spacing.xxl,
  },
  recommendationTitle: {
    marginBottom: spacing.xxs,
  },
  recommendationBadge: {
    marginBottom: spacing.lg,
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  footerButton: {
    flex: 1,
  },
});
