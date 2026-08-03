import React from 'react';
import { View, TextInput, Text, StyleSheet, TextInputProps } from 'react-native';

interface InputProps extends TextInputProps {
  label: string;
  error?: string;
}

export default function Input({ label, error, ...props }: InputProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, error ? styles.inputError : null]}
        placeholderTextColor="#94a3b8"
        {...props}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
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
    color: '#475569', // slate-600
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#f8fafc', // slate-50
    borderWidth: 1,
    borderColor: '#e2e8f0', // slate-200
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a', // slate-900
  },
  inputError: {
    borderColor: '#f87171', // red-400
  },
  errorText: {
    fontSize: 10,
    color: '#ef4444', // red-500
    marginTop: 4,
  },
});
