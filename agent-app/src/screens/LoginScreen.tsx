import React, { useState, useRef } from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { Text, Field, Button, Banner, Card } from '../components/ui';
import ConstellationBackground from '../components/ui/ConstellationBackground';

export default function LoginScreen() {
  const { colors, isDark, shadow } = useTheme();
  const { isCompact, height } = useResponsive();
  const { signIn } = useSession();
  const { toast } = useNotifications();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  const validate = () => {
    const next: typeof errors = {};
    const trimmed = email.trim();
    if (!trimmed) next.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) next.email = 'That does not look like a valid email.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleLogin = async () => {
    setFormError(null);
    if (!validate()) return;

    setLoading(true);
    try {
      await signIn(email.trim(), password);
      toast('Signed in', { tone: 'success', icon: 'checkmark-circle' });
    } catch (err: any) {
      setFormError(err?.message ?? 'We could not sign you in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      {/* Futuristic Constellation Network Background */}
      <ConstellationBackground />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { minHeight: height * 0.9 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.column, !isCompact ? styles.columnWide : null]}>
            {/* Perfectly Aligned Brand Header */}
            <View style={styles.brand}>
              <Text align="center" style={[styles.brandTitle, { color: colors.text }]}>
                RIZVIZ
              </Text>
              <Text
                align="center"
                style={[styles.subtitle, { color: colors.tone.brand.solid }]}
              >
                AGENT PORTAL
              </Text>
              <Text variant="caption" color="muted" align="center" style={styles.description}>
                Sign in to manage your leads, proposals and cases.
              </Text>
            </View>

            {formError ? (
              <Banner
                tone="danger"
                title="Sign-in failed"
                description={formError}
                onDismiss={() => setFormError(null)}
                style={styles.banner}
              />
            ) : null}

            {/* Clean Form Card */}
            <Card padding="xl" style={[styles.formCard, shadow(1)]}>
              <Field
                label="Email address"
                placeholder="agent@rizviz.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
                autoCorrect={false}
                leftIcon="mail-outline"
                value={email}
                onChangeText={(text) => {
                  setEmail(text);
                  if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
                }}
                error={errors.email}
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                editable={!loading}
              />

              <Field
                ref={passwordRef}
                label="Password"
                placeholder="••••••••"
                isPassword
                autoComplete="password"
                textContentType="password"
                leftIcon="lock-closed-outline"
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
                }}
                error={errors.password}
                returnKeyType="go"
                onSubmitEditing={handleLogin}
                editable={!loading}
              />

              <Button
                title="Sign in"
                onPress={handleLogin}
                loading={loading}
                size="lg"
                fullWidth
                icon="arrow-forward"
                iconPosition="right"
                style={styles.submit}
              />
            </Card>

            <View style={styles.footer}>
              <View style={[styles.secureNote, { backgroundColor: colors.surfaceSunken, borderColor: colors.border }]}>
                <Ionicons name="shield-checkmark-outline" size={15} color={colors.tone.success.solid} />
                <Text variant="caption" color="muted">
                  Secure, encrypted connection
                </Text>
              </View>
              <Text variant="micro" color="subtle" align="center">
                RIZVIZ Insurance · Agent Portal
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxxl,
  },
  column: {
    width: '100%',
  },
  columnWide: {
    maxWidth: 420,
    alignSelf: 'center',
  },
  brand: {
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  brandTitle: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '900',
    letterSpacing: 5,
    textAlign: 'center',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  description: {
    maxWidth: 290,
    lineHeight: 20,
  },
  banner: {
    marginBottom: spacing.xl,
  },
  formCard: {
    borderRadius: radii.xl,
  },
  submit: {
    marginTop: spacing.md,
  },
  footer: {
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xxxl,
  },
  secureNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
});
