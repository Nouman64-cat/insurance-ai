import React, { useState, forwardRef } from 'react';
import {
  View,
  TextInput,
  TextInputProps,
  StyleSheet,
  ViewStyle,
  StyleProp,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, typography, hitTarget } from '../../theme/tokens';
import Text from './Text';
import Pressable from './Pressable';

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  helperText?: string;
  /** Marks the label with an asterisk and sets the a11y required state. */
  required?: boolean;
  isPassword?: boolean;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  /** Trailing affordance — e.g. a "scan" or "clear" action. */
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<ViewStyle>;
}

/**
 * Text field with a focus ring, inline validation and an optional reveal toggle.
 * The visible focus state matters more on mobile than desktop — without it,
 * a user tapping through a long form loses track of where the caret is.
 */
const Field = forwardRef<TextInput, FieldProps>(function Field(
  {
    label,
    error,
    helperText,
    required,
    isPassword,
    leftIcon,
    rightIcon,
    onRightIconPress,
    containerStyle,
    inputStyle,
    secureTextEntry,
    editable = true,
    multiline,
    onFocus,
    onBlur,
    ...props
  },
  ref
) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const borderColor = error
    ? colors.tone.danger.solid
    : focused
      ? colors.tone.brand.solid
      : colors.border;

  const trailingIcon = isPassword
    ? ((revealed ? 'eye-off-outline' : 'eye-outline') as keyof typeof Ionicons.glyphMap)
    : rightIcon;

  const onTrailingPress = isPassword ? () => setRevealed((v) => !v) : onRightIconPress;

  return (
    <View style={[styles.container, containerStyle]}>
      {label ? (
        <Text variant="captionStrong" color="muted" style={styles.label}>
          {label}
          {required ? <Text style={{ color: colors.tone.danger.solid }}> *</Text> : null}
        </Text>
      ) : null}

      <View
        style={[
          styles.inputWrap,
          {
            backgroundColor: editable ? colors.surface : colors.surfaceSunken,
            borderColor,
            // The ring is drawn as an extra border rather than a shadow so it
            // renders identically on both platforms.
            borderWidth: focused || error ? 2 : 1,
            // Compensate for the thicker border so the field does not jump.
            paddingHorizontal: focused || error ? spacing.md - 1 : spacing.md,
          },
          multiline ? styles.inputWrapMultiline : null,
          !editable ? styles.disabled : null,
          inputStyle,
        ]}
      >
        {leftIcon ? (
          <Ionicons
            name={leftIcon}
            size={18}
            color={focused ? colors.tone.brand.solid : colors.textSubtle}
          />
        ) : null}

        <TextInput
          ref={ref}
          style={[
            styles.input,
            typography.body,
            { color: editable ? colors.text : colors.textMuted },
            multiline ? styles.inputMultiline : null,
          ]}
          placeholderTextColor={colors.textSubtle}
          secureTextEntry={isPassword ? !revealed : secureTextEntry}
          editable={editable}
          multiline={multiline}
          accessibilityLabel={label}
          accessibilityState={{ disabled: !editable }}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...props}
        />

        {trailingIcon ? (
          <Pressable
            onPress={onTrailingPress}
            disabled={!onTrailingPress}
            pressedScale={0.9}
            accessibilityRole="button"
            accessibilityLabel={isPassword ? (revealed ? 'Hide password' : 'Show password') : 'Field action'}
            style={styles.trailing}
          >
            <Ionicons name={trailingIcon} size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <View style={styles.messageRow}>
          <Ionicons name="alert-circle" size={13} color={colors.tone.danger.solid} />
          <Text variant="caption" style={{ color: colors.tone.danger.on, flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : helperText ? (
        <Text variant="caption" color="subtle" style={styles.helper}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
});

export default Field;

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: hitTarget.comfortable,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  inputWrapMultiline: {
    alignItems: 'flex-start',
    paddingVertical: spacing.md,
    minHeight: 104,
  },
  input: {
    flex: 1,
    paddingVertical: Platform.OS === 'ios' ? spacing.xs : 0,
    paddingHorizontal: 0,
    marginHorizontal: 0,
    minWidth: 0,
  },
  inputMultiline: {
    textAlignVertical: 'top',
    paddingVertical: 0,
  },
  trailing: {
    padding: spacing.xs,
  },
  disabled: {
    opacity: 0.7,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  helper: {
    marginTop: spacing.xs,
  },
});
