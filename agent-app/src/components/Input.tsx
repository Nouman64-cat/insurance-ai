import React from 'react';
import { View, TextInput, Text, StyleSheet, TextInputProps } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

interface InputProps extends TextInputProps {
  label: string;
  error?: string;
  helperText?: string;
}

export default function Input({ label, error, helperText, style, ...props }: InputProps) {
  const { colors, isDark } = useTheme();

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          { 
            backgroundColor: isDark ? colors.surface : '#f8fafc',
            borderColor: error ? colors.danger : colors.border,
            color: colors.text
          },
          style
        ]}
        placeholderTextColor={colors.textMuted}
        {...props}
      />
      {helperText ? <Text style={[styles.helperText, { color: colors.textMuted }]}>{helperText}</Text> : null}
      {error ? <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  inputError: {},
  errorText: {
    fontSize: 10,
    marginTop: 4,
  },
  helperText: {
    fontSize: 11,
    marginTop: 4,
    lineHeight: 16,
  },
});
