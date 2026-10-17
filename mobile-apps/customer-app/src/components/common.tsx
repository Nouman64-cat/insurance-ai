import React, { useState } from 'react';
import { Platform, View, StyleProp, ViewStyle } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { Badge, Banner, Button, Card, EmptyState, Pressable, Sheet, Skeleton, Text } from './ui';
import { ToneName } from '../theme/palette';
import { useTheme } from '../theme/ThemeContext';
import { ApiError } from '../api/client';
import { errorText } from '../i18n/errorText';
import { t } from '../i18n/t';
import { date as fmtDate, localISO } from '../lib/format';

// ── status badges: semantic only, same mapping as customer-portal/components/ui.tsx ──
const POLICY_TONE: Record<string, ToneName> = {
  active: 'success', reinstated: 'success', grace_period: 'warning', lapsed: 'danger', cancelled: 'danger',
  pending_issuance: 'info', issued: 'info', expired: 'neutral', matured: 'neutral', surrendered: 'neutral', unknown: 'neutral',
};
const CLAIM_TONE: Record<string, ToneName> = {
  submitted: 'info', in_review: 'info', assessment: 'info', documents_needed: 'warning', approved: 'success', partially_approved: 'success',
  settled: 'success', declined: 'danger', closed: 'neutral',
};
const INSTALLMENT_TONE: Record<string, ToneName> = { paid: 'success', waived: 'neutral', upcoming: 'neutral', due_soon: 'info', due_today: 'warning', grace: 'warning', past_grace: 'danger' };
const TICKET_TONE: Record<string, ToneName> = { OPEN: 'info', IN_PROGRESS: 'accent', WAITING_CUSTOMER: 'warning', RESOLVED: 'success', CLOSED: 'neutral', CANCELLED: 'neutral' };

export const PolicyStatus = ({ statusKey }: { statusKey: string }) => <Badge label={t(`policyStatus.${statusKey}`)} tone={POLICY_TONE[statusKey] ?? 'neutral'} size="sm" />;
export const ClaimStatus = ({ statusKey }: { statusKey: string }) => <Badge label={t(`claimStatus.${statusKey}`)} tone={CLAIM_TONE[statusKey] ?? 'neutral'} size="sm" />;
export const InstallmentState = ({ state }: { state: string }) => <Badge label={t(`installment.${state}`)} tone={INSTALLMENT_TONE[state] ?? 'neutral'} size="sm" />;
export const TicketStatus = ({ status }: { status: string }) => <Badge label={t(`ticket.status.${status}`)} tone={TICKET_TONE[status] ?? 'neutral'} size="sm" />;

/** A label/value line inside a card (the portal's KeyValue). */
export function KeyValue({ label, children, last }: { label: string; children?: React.ReactNode; last?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 16, paddingVertical: 9, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.borderSubtle }}>
      <Text variant="callout" color="muted" style={{ flexShrink: 0, maxWidth: '45%' }}>{label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        {typeof children === 'string' || typeof children === 'number' || children == null
          ? <Text variant="calloutStrong" align="right" selectable>{children ?? '—'}</Text> : children}
      </View>
    </View>
  );
}

/** A titled card, like the portal's <Card title>. */
export function Panel({ title, action, children, style }: { title?: string; action?: React.ReactNode; children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Card style={style}>
      {title || action ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
          <Text variant="title3" style={{ flex: 1 }}>{title}</Text>{action}
        </View>
      ) : null}
      {children}
    </Card>
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <EmptyState tone="danger" icon="alert-circle" title={t('error.title')} description={errorText(error)} actionLabel={onRetry ? t('common.retry') : undefined} onAction={onRetry} />;
}

export function LoadingCards({ count = 3, height = 120 }: { count?: number; height?: number }) {
  return <View style={{ gap: 12 }}>{Array.from({ length: count }).map((_, i) => <Skeleton key={i} height={height} radius={16} />)}</View>;
}

/** A tappable row with a leading checkbox-style control. */
export function CheckRow({ value, onChange, label, hint, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={() => !disabled && onChange(!value)} accessibilityRole="checkbox" accessibilityState={{ checked: value, disabled }}
      style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', opacity: disabled ? 0.5 : 1 }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: value ? colors.primary : colors.border, backgroundColor: value ? colors.primary : 'transparent', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        {value ? <Ionicons name="checkmark" size={15} color="#fff" /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="callout">{label}</Text>
        {hint ? <Text variant="caption" color="muted">{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

/** Date input using the platform picker. Value is YYYY-MM-DD. */
export function DateField({ label, value, onChange, maxToday, min, max, error, required }: {
  label: string; value: string; onChange: (v: string) => void; maxToday?: boolean; min?: string; max?: string; error?: string; required?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const current = value ? new Date(`${value}T00:00:00`) : new Date();
  const maxDate = maxToday ? new Date() : max ? new Date(`${max}T00:00:00`) : undefined;
  const minDate = min ? new Date(`${min}T00:00:00`) : undefined;
  const pick = (_: any, d?: Date) => { if (Platform.OS === 'android') setOpen(false); if (d) onChange(localISO(d)); };
  return (
    <View style={{ gap: 6 }}>
      <Text variant="calloutStrong">{label}{required ? ' *' : ''}</Text>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={label}
        style={{ minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: error ? colors.danger : colors.border, backgroundColor: colors.surfaceSunken, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="body" color={value ? 'default' : 'subtle'}>{value ? fmtDate(value) : 'Select date'}</Text>
        <Ionicons name="calendar-outline" size={18} color={colors.textMuted} />
      </Pressable>
      {error ? <Text variant="caption" color="danger">{error}</Text> : null}
      {open && Platform.OS === 'android' ? <DateTimePicker value={current} mode="date" maximumDate={maxDate} minimumDate={minDate} onChange={pick} /> : null}
      {Platform.OS === 'ios' ? (
        <Sheet visible={open} onClose={() => setOpen(false)} title={label} footer={<Button title={t('common.done')} onPress={() => setOpen(false)} fullWidth />}>
          <DateTimePicker value={current} mode="date" display="spinner" maximumDate={maxDate} minimumDate={minDate} onChange={pick} />
        </Sheet>
      ) : null}
    </View>
  );
}

/** Inline stepper for multi-step forms ("1 · 2 · 3"). */
export function Stepper({ steps, index }: { steps: string[]; index: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} accessibilityLabel={`Step ${index + 1} of ${steps.length}`}>
      {steps.map((s, i) => (
        <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: i < index ? colors.success : i === index ? colors.primary : 'transparent', borderWidth: i > index ? 1 : 0, borderColor: colors.border }}>
            <Text variant="captionStrong" style={{ color: i <= index ? '#fff' : colors.textMuted }}>{i < index ? '✓' : i + 1}</Text>
          </View>
          <Text variant="captionStrong" color={i === index ? 'brand' : 'muted'}>{s}</Text>
          {i < steps.length - 1 ? <View style={{ width: 14, height: 1, backgroundColor: colors.border }} /> : null}
        </View>
      ))}
    </View>
  );
}

export { Banner };
export type { ApiError };
