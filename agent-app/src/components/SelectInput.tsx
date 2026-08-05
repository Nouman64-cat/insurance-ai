import React from 'react';
import Select from './ui/Select';

export interface Option {
  label: string;
  value: string;
  /** Extra explanatory copy — rendered as the option's description line. */
  info?: string;
}

interface SelectInputProps {
  label: string;
  value: string;
  options: Option[];
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Compatibility shim over the design-system Select. New code should import
 * `Select` from `components/ui` directly.
 *
 * The old component hid `info` behind an eye button that opened a native alert;
 * Select shows it inline as a description, which is both calmer and readable
 * without an extra tap.
 */
export default function SelectInput({ label, options, ...props }: SelectInputProps) {
  const required = label.trimEnd().endsWith('*');
  const cleanLabel = required ? label.trimEnd().slice(0, -1).trimEnd() : label;

  return (
    <Select
      label={cleanLabel}
      required={required}
      options={options.map((o) => ({ label: o.label, value: o.value, description: o.info }))}
      {...props}
    />
  );
}
