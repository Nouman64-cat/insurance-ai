import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeContext';
import { spacing } from '../theme/tokens';
import { useNotifications } from '../notifications/NotificationContext';
import { fetchEApplication, verifyEApplication, EApplication } from '../api/eApplication';
import { RootStackParamList } from '../navigation/AppNavigator';
import Accordion from '../components/Accordion';
import { Screen, ScreenHeader, Text, Card, Badge, Button, Banner, Divider, ConfirmDialog } from '../components/ui';

type ReviewRoute = RouteProp<RootStackParamList, 'ReviewEApplication'>;

const Field = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <View style={styles.field}>
    <Text variant="caption" color="muted">
      {label}
    </Text>
    <Text variant="callout">{value}</Text>
  </View>
);

/**
 * Gate 1's other half — inviting the customer is only step one. Once they
 * submit, the agent has to actually read the answers and approve or send it
 * back before the gate clears. The mobile app previously had no way to do
 * this at all, so a submitted e-application had no path forward here.
 */
export default function ReviewEApplicationScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<ReviewRoute>();
  const { caseId, applicantName } = route.params ?? ({} as ReviewRoute['params']);
  const { toast } = useNotifications();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eApp, setEApp] = useState<EApplication | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);

  useEffect(() => {
    if (!caseId) {
      setLoadError('No case was selected, so there is nothing to review.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchEApplication(caseId)
      .then((data) => {
        if (!cancelled) setEApp(data);
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err?.message ?? 'Could not load the application.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const approve = useCallback(async () => {
    if (!caseId) return;
    setVerifying(true);
    try {
      await verifyEApplication(caseId, 'approve');
      toast('E-Application verified', {
        body: 'Gate 1 is clear.',
        tone: 'success',
        icon: 'checkmark-circle',
      });
      navigation.goBack();
    } catch (err: any) {
      toast('Could not verify the application', {
        body: err?.message ?? 'Please try again.',
        tone: 'danger',
        icon: 'alert-circle',
      });
    } finally {
      setVerifying(false);
    }
  }, [caseId, toast, navigation]);

  const reject = useCallback(async () => {
    if (!caseId) return;
    setConfirmReject(false);
    setVerifying(true);
    try {
      await verifyEApplication(caseId, 'reject');
      toast('Sent back to the customer', {
        body: 'They can amend and resubmit the form.',
        tone: 'warning',
        icon: 'arrow-undo-circle',
      });
      navigation.goBack();
    } catch (err: any) {
      toast('Could not reopen the application', {
        body: err?.message ?? 'Please try again.',
        tone: 'danger',
        icon: 'alert-circle',
      });
    } finally {
      setVerifying(false);
    }
  }, [caseId, toast, navigation]);

  if (loading) {
    return (
      <Screen header={<ScreenHeader title="Review E-Application" leading="back" />}>
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text variant="callout" color="muted">
            Loading the application…
          </Text>
        </View>
      </Screen>
    );
  }

  if (loadError || !eApp) {
    return (
      <Screen header={<ScreenHeader title="Review E-Application" leading="back" />}>
        <Banner
          tone="danger"
          title="Cannot open this application"
          description={loadError ?? 'Nothing has been submitted yet.'}
          style={styles.banner}
        />
      </Screen>
    );
  }

  const medical = eApp.medical_questionnaire || {};
  const conditions = (medical.conditions || []).filter((c: any) => c.checked);
  const customQuestions = medical.custom_questions || [];
  const family = eApp.family_history?.entries || [];
  const lifestyle = eApp.lifestyle_habits || {};
  const existingPolicies = (eApp.existing_insurance || {}).policies || [];
  const declaration = eApp.declaration || {};

  const reviewable = eApp.status === 'Submitted';

  return (
    <Screen
      header={
        <ScreenHeader title="Review E-Application" subtitle={applicantName ?? 'Applicant'} leading="back" />
      }
      footer={
        reviewable ? (
          <View style={styles.footer}>
            <Button
              title="Request revision"
              onPress={() => setConfirmReject(true)}
              variant="outline"
              tone="warning"
              disabled={verifying}
              style={styles.footerButton}
            />
            <Button
              title="Approve & verify"
              onPress={approve}
              loading={verifying}
              disabled={verifying}
              icon="checkmark-circle"
              style={styles.footerButton}
            />
          </View>
        ) : undefined
      }
    >
      {reviewable ? (
        <Banner
          tone="info"
          title="Submitted by the customer"
          description="Read through their answers, then approve to clear Gate 1 or send it back for changes."
          icon="document-text-outline"
          style={styles.banner}
        />
      ) : (
        <Banner
          tone={eApp.status === 'Verified' ? 'success' : 'neutral'}
          title={`Status: ${eApp.status}`}
          description={
            eApp.status === 'Verified'
              ? 'Already verified — Gate 1 is clear.'
              : 'The customer has not submitted the form yet, so there is nothing to review.'
          }
          icon={eApp.status === 'Verified' ? 'checkmark-circle' : 'time-outline'}
          style={styles.banner}
        />
      )}

      <Accordion title="Medical & health" icon="medkit-outline" tone="brand" defaultExpanded>
        <Field label="Height" value={medical.height_cm ? `${medical.height_cm} cm` : 'Not specified'} />
        <Field label="Weight" value={medical.weight_kg ? `${medical.weight_kg} kg` : 'Not specified'} />
        <Field
          label="Tobacco / nicotine"
          value={medical.tobacco_use ? `Yes (${medical.tobacco_frequency || 'no frequency given'})` : 'No'}
        />

        <Divider spacingY="md" label="Conditions declared" />
        {conditions.length === 0 ? (
          <Text variant="callout" color="muted">
            No medical conditions declared by the applicant.
          </Text>
        ) : (
          conditions.map((c: any) => (
            <Card key={c.key} padding="md" style={styles.subCard}>
              <Text variant="calloutStrong">⚠️ {c.label}</Text>
              <Text variant="caption" color="muted">
                Diagnosed {c.year_of_diagnosis || 'N/A'} · {c.under_treatment ? 'Under treatment' : 'Not under treatment'}
              </Text>
              {c.medications ? (
                <Text variant="caption" color="muted">
                  Medications: {c.medications}
                </Text>
              ) : null}
              {c.physician_name ? (
                <Text variant="caption" color="muted">
                  Physician: {c.physician_name} {c.physician_clinic ? `(${c.physician_clinic})` : ''}
                </Text>
              ) : null}
            </Card>
          ))
        )}

        {customQuestions.length > 0 ? (
          <>
            <Divider spacingY="md" label="Custom questions" />
            {customQuestions.map((cq: any, idx: number) => (
              <Card key={cq.id || idx} padding="md" style={styles.subCard}>
                <Text variant="calloutStrong">{cq.question}</Text>
                <Text variant="callout">Answer: {cq.answer || 'No response'}</Text>
                {cq.details ? (
                  <Text variant="caption" color="muted">
                    {cq.details}
                  </Text>
                ) : null}
              </Card>
            ))}
          </>
        ) : null}
      </Accordion>

      <Accordion title="Family history" icon="people-outline" tone="success">
        {family.length === 0 ? (
          <Text variant="callout" color="muted">
            No family medical history recorded.
          </Text>
        ) : (
          family.map((f, idx) => (
            <Card key={idx} padding="md" style={styles.subCard}>
              <Text variant="calloutStrong">
                {f.relation} {f.name ? `(${f.name})` : ''}
              </Text>
              <Text variant="caption" color="muted">
                Age {f.age ?? 'N/A'} · {f.is_alive ? 'Living' : 'Deceased'}
              </Text>
              <Text variant="callout">
                {f.condition || 'Healthy'}
                {f.age_at_onset ? ` (onset at age ${f.age_at_onset})` : ''}
              </Text>
            </Card>
          ))
        )}
      </Accordion>

      <Accordion title="Lifestyle & travel" icon="airplane-outline" tone="info">
        <Field
          label="Hazardous hobbies"
          value={lifestyle.has_hazardous_hobby ? `Yes (${lifestyle.hazardous_hobby_details || ''})` : 'No'}
        />
        <Field label="Occupation hazard level" value={lifestyle.occupation_hazard_level || 'Low'} />
        <Field
          label="Frequent foreign travel"
          value={
            lifestyle.frequent_foreign_travel ? `Yes (${lifestyle.foreign_travel_details || ''})` : 'No'
          }
        />
        <Field label="Traffic violations (3 yrs)" value={lifestyle.moving_violations_past_3_years ?? '0'} />
      </Accordion>

      <Accordion title="Existing insurance" icon="shield-outline" tone="warning">
        {existingPolicies.length === 0 ? (
          <Text variant="callout" color="muted">
            No existing insurance policies declared.
          </Text>
        ) : (
          existingPolicies.map((p: any, idx: number) => (
            <Card key={idx} padding="md" style={styles.subCard}>
              <Text variant="calloutStrong">
                {p.insurer_name} (#{p.policy_number})
              </Text>
              <Text variant="callout">Sum assured: PKR {Number(p.sum_assured || 0).toLocaleString()}</Text>
              <Badge label={p.status} tone="info" variant="soft" style={styles.policyBadge} />
            </Card>
          ))
        )}
      </Accordion>

      <Accordion title="Declaration & signature" icon="create-outline" tone="accent">
        <Text variant="callout">✓ Information accuracy confirmed by customer</Text>
        <Text variant="callout">✓ Medical & record access authorized</Text>
        <Text variant="callout">✓ Policy terms & free-look period understood</Text>
        <Divider spacingY="md" />
        <Field label="Typed legal signature" value={declaration.signature_name || 'N/A'} />
        <Field
          label="Submitted"
          value={eApp.submitted_at ? new Date(eApp.submitted_at).toLocaleString() : 'Recently'}
        />
      </Accordion>

      <ConfirmDialog
        visible={confirmReject}
        title="Send back for revision?"
        message="This reopens the form for the customer to amend and resubmit."
        confirmLabel="Send back"
        tone="warning"
        icon="arrow-undo-circle"
        loading={verifying}
        onConfirm={reject}
        onCancel={() => setConfirmReject(false)}
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
  field: {
    marginBottom: spacing.md,
  },
  subCard: {
    marginBottom: spacing.sm,
  },
  policyBadge: {
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  footerButton: {
    flex: 1,
  },
});
