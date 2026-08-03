import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, ViewStyle, TextStyle } from 'react-native';

interface ButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  type?: 'primary' | 'secondary' | 'danger';
}

export default function Button({ title, onPress, loading, disabled, style, textStyle, type = 'primary' }: ButtonProps) {
  const isPrimary = type === 'primary';
  const isDanger = type === 'danger';
  const isSecondary = type === 'secondary';

  return (
    <TouchableOpacity
      style={[
        styles.button,
        isPrimary && styles.primary,
        isSecondary && styles.secondary,
        isDanger && styles.danger,
        (disabled || loading) && styles.disabled,
        style
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
    >
      {loading ? (
        <ActivityIndicator color={isSecondary ? '#1D4ED8' : '#ffffff'} />
      ) : (
        <Text style={[
          styles.text, 
          isSecondary ? styles.textSecondary : styles.textPrimary,
          isDanger && styles.textPrimary,
          textStyle
        ]}>
          {title}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  primary: {
    backgroundColor: '#1D4ED8',
  },
  secondary: {
    backgroundColor: '#DBEAFE',
  },
  danger: {
    backgroundColor: '#EF4444',
  },
  disabled: {
    opacity: 0.6,
  },
  text: {
    fontSize: 16,
    fontWeight: '600',
  },
  textPrimary: {
    color: '#ffffff',
  },
  textSecondary: {
    color: '#1D4ED8',
  },
});
