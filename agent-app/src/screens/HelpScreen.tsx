import React, { useState } from 'react';
import { StyleSheet, Linking } from 'react-native';
import { spacing } from '../theme/tokens';
import { useNotifications } from '../notifications/NotificationContext';
import {
  Screen,
  ScreenHeader,
  Card,
  Text,
  ListRow,
  Divider,
  SectionHeader,
  Banner,
} from '../components/ui';
import Accordion from '../components/Accordion';

const SUPPORT_EMAIL = 'support@rizviz.com';
const SUPPORT_PHONE = '+92 800 123 4567';

const FAQS: { question: string; answer: string }[] = [
  {
    question: 'A lead I added is not showing in the web portal',
    answer:
      'The app and the portal read the same database, so a saved lead is there immediately — but the portal only refetches when you reload the page or change a filter. Refresh the portal first. If it is still missing, check the Leads screen here: if a warning banner is showing, the save did not reach the server and you should try again.',
  },
  {
    question: 'Why can I only see my own leads?',
    answer:
      'Agents see the leads assigned to them; admins and underwriters see every lead in the tenant. Your current visibility is shown under Settings → Account. If you believe it is wrong, your role needs changing in the portal.',
  },
  {
    question: 'What is the difference between a quick lead and a full profile?',
    answer:
      'A quick lead captures just a name and phone number so you never lose a contact. A full profile captures everything underwriting needs — identity, income, medical and lifestyle. You can start with a quick lead and complete the rest later; nothing is lost.',
  },
  {
    question: 'I am not getting notifications',
    answer:
      'Notifications arrive while the app is open and refresh as soon as you bring it back to the foreground. If the Leads screen shows a "Sync paused" banner, the app cannot reach the server — check your connection, then tap Retry.',
  },
  {
    question: 'How do I send an e-application to a customer?',
    answer:
      'Open the Cases tab, find the case, and tap E-Application. The app generates a secure link and opens your share sheet so you can send it by WhatsApp, SMS or email. The customer does not need an account.',
  },
];

export default function HelpScreen() {
  const { toast } = useNotifications();
  const [linkError, setLinkError] = useState<string | null>(null);

  const open = async (url: string, failureMessage: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      setLinkError(failureMessage);
      toast('Could not open that app', { tone: 'warning', icon: 'alert-circle' });
    }
  };

  return (
    <Screen header={<ScreenHeader title="Help & Support" leading="menu" />}>
      {linkError ? (
        <Banner
          tone="warning"
          title="Nothing available to handle that"
          description={linkError}
          onDismiss={() => setLinkError(null)}
          style={styles.banner}
        />
      ) : null}

      <SectionHeader title="Contact IT support" icon="headset-outline" />
      <Card padding="md" style={styles.section}>
        <ListRow
          title="Email support"
          subtitle={SUPPORT_EMAIL}
          icon="mail-outline"
          tone="brand"
          onPress={() =>
            open(`mailto:${SUPPORT_EMAIL}`, 'No mail app is set up on this device.')
          }
        />
        <Divider spacingY="none" />
        <ListRow
          title="Call support"
          subtitle={SUPPORT_PHONE}
          icon="call-outline"
          tone="success"
          onPress={() =>
            open(`tel:${SUPPORT_PHONE.replace(/[^\d+]/g, '')}`, 'No dialler is available on this device.')
          }
        />
      </Card>

      <Text variant="caption" color="muted" style={styles.hint}>
        When reporting a problem, include what you were doing, the lead or case number, and the exact
        wording of any error. It makes the fix much faster.
      </Text>

      <SectionHeader title="Common questions" icon="help-circle-outline" />
      {FAQS.map((faq) => (
        <Accordion key={faq.question} title={faq.question} icon="chatbubble-ellipses-outline" tone="info">
          <Text variant="callout" color="muted" style={styles.answer}>
            {faq.answer}
          </Text>
        </Accordion>
      ))}

      <Text variant="caption" color="subtle" align="center" style={styles.footer}>
        RIZVIZ Agent Portal · v1.0.0
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: spacing.lg,
  },
  section: {
    marginBottom: spacing.md,
  },
  hint: {
    marginBottom: spacing.xxl,
  },
  answer: {
    marginBottom: spacing.lg,
  },
  footer: {
    marginTop: spacing.lg,
    marginBottom: spacing.xxl,
  },
});
