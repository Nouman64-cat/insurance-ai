import React, { useState } from 'react';
import { View, TextInput, Text, StyleSheet, TextInputProps, TouchableOpacity } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Ionicons } from '@expo/vector-icons';

interface InputProps extends TextInputProps {
  label: string;
  error?: string;
  helperText?: string;
  isPassword?: boolean;
}

export default function Input({ label, error, helperText, isPassword, style, secureTextEntry, ...props }: InputProps) {
  const { colors, isDark } = useTheme();
  const [showPassword, setShowPassword] = useState(false);

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
      <View style={styles.inputWrapper}>
        <TextInput
          style={[
            styles.input,
            { 
              backgroundColor: isDark ? colors.surface : '#f8fafc',
              borderColor: error ? colors.danger : colors.border,
              color: colors.text
            },
            isPassword && { paddingRight: 40 },
            style
          ]}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={isPassword ? !showPassword : secureTextEntry}
          {...props}
        />
        {isPassword && (
          <TouchableOpacity 
            style={styles.eyeIcon} 
            onPress={() => setShowPassword(!showPassword)}
          >
            <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>
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
  inputWrapper: {
    position: 'relative',
    justifyContent: 'center',
  },
  eyeIcon: {
    position: 'absolute',
    right: 12,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
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
