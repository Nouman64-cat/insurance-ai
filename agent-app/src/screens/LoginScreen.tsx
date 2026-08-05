import React, { useState, useRef } from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
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
import { Text, Field, Button, Banner } from '../components/ui';

// 220×79 wordmark. Rendered with a fixed height and `resizeMode="contain"` so
// the aspect ratio holds on every screen density.
const LOGO = require('../assets/rizvi.png');
const LOGO_ASPECT = 220 / 79;

export default function LoginScreen() {
  const { colors, isDark } = useTheme();
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
      // The navigator swaps to the app stack off `isAuthenticated`, so there is
      // deliberately no navigation call here — one source of truth for routing.
      toast('Signed in', { tone: 'success', icon: 'checkmark-circle' });
    } catch (err: any) {
      setFormError(err?.message ?? 'We could not sign you in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const logoWidth = isCompact ? 176 : 208;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            // Centres the form on tall screens, but lets it scroll normally once
            // the keyboard shrinks the viewport.
            { minHeight: height * 0.9 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.column, !isCompact ? styles.columnWide : null]}>
            <View style={styles.brand}>
              <View
                style={[
                  styles.logoPlate,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                ]}
              >
                <Image
                  source={LOGO}
                  style={{ width: logoWidth, height: logoWidth / LOGO_ASPECT }}
                  resizeMode="contain"
                  accessibilityRole="image"
                  accessibilityLabel="Rizvi"
                />
              </View>

              <Text variant="display" align="center" style={styles.title}>
                Agent Portal
              </Text>
              <Text variant="callout" color="muted" align="center" style={styles.subtitle}>
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

            <View style={styles.form}>
              <Field
                label="Email address"
                placeholder="agent@rizvi.com"
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
            </View>

            <View style={styles.footer}>
              <View style={[styles.secureNote, { backgroundColor: colors.surfaceSunken }]}>
                <Ionicons name="shield-checkmark-outline" size={15} color={colors.tone.success.solid} />
                <Text variant="caption" color="muted">
                  Secure, encrypted connection
                </Text>
              </View>
              <Text variant="micro" color="subtle" align="center">
                Rizvi Insurance · Agent Portal
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
    maxWidth: 460,
    alignSelf: 'center',
  },
  brand: {
    alignItems: 'center',
    marginBottom: spacing.xxxl,
  },
  logoPlate: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
    borderRadius: radii.xl,
    borderWidth: 1,
    marginBottom: spacing.xxl,
  },
  title: {
    marginBottom: spacing.sm,
  },
  subtitle: {
    maxWidth: 300,
  },
  banner: {
    marginBottom: spacing.xl,
  },
  form: {
    width: '100%',
  },
  submit: {
    marginTop: spacing.sm,
  },
  footer: {
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.huge,
  },
  secureNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
  },
});
