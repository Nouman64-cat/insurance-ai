import React from 'react';
import { SegmentedControl } from './ui';
import { useCustomer } from '../context/CustomerContext';
import { t } from '../i18n/t';

export type Segment = 'individual' | 'family';

/** Individual / Family switch for the lists that exist for both. Renders nothing for a customer with no family policies. */
export default function SegmentSwitch({ value, onChange }: { value: Segment; onChange: (s: Segment) => void }) {
  const { hasFamily } = useCustomer();
  if (!hasFamily) return null;
  return <SegmentedControl value={value} onChange={onChange} segments={[{ value: 'individual', label: t('segment.individual') }, { value: 'family', label: t('segment.family') }]} />;
}

export const segmentQuery = (s: Segment) => (s === 'family' ? '?segment=family' : '');
