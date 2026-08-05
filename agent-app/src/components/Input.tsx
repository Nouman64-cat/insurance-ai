import React, { forwardRef } from 'react';
import { TextInput, TextInputProps } from 'react-native';
import Field from './ui/Field';

interface LegacyInputProps extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string;
  helperText?: string;
  isPassword?: boolean;
}

/**
 * Compatibility shim over the design-system Field. New code should import
 * `Field` from `components/ui` directly.
 *
 * Callers commonly write `label="First Name *"`; Field renders the asterisk
 * itself via `required`, so that suffix is translated rather than duplicated.
 */
const Input = forwardRef<TextInput, LegacyInputProps>(function Input({ label, ...props }, ref) {
  const required = label.trimEnd().endsWith('*');
  const cleanLabel = required ? label.trimEnd().slice(0, -1).trimEnd() : label;

  return <Field ref={ref} label={cleanLabel} required={required} {...props} />;
});

export default Input;
