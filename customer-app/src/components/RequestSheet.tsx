import React, { useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Field, Pressable, Select, Sheet, Text } from './ui';
import { CheckRow, DateField } from './common';
import { ApiError } from '../api/client';
import { post } from '../api/portal';
import { errorText } from '../i18n/errorText';
import { t } from '../i18n/t';
import { newIdempotencyKey, tOr } from '../lib/format';
import type { BeneficiariesView, MemberRow } from '../api/portalTypes';

export type RequestKind = 'MEMBER_ADD' | 'MEMBER_REMOVE' | 'MEMBER_CORRECTION' | 'COVERAGE_CHANGE' | 'NOMINEE_CHANGE' | 'CONTACT_CORRECTION' | 'CANCELLATION' | 'REINSTATEMENT';

interface Row { name: string; relationship: string; share_pct: string; date_of_birth: string; guardian_name: string }
const RELATIONSHIPS = ['Spouse', 'Child', 'Parent', 'Sibling', 'Other'];
const CORRECTABLE = ['name', 'dob', 'cnic', 'phone', 'email', 'relationship'];

/**
 * One sheet for every servicing request a family customer can make (same kinds, validation and wording as the web portal's
 * RequestModal). Nothing here changes an issued contract: the request is validated against the policy's state, recorded, and
 * handled by the insurer.
 */
export default function RequestSheet({ familyId, kind, policy, member, nominees, onClose, onDone }: {
  familyId: string; kind: RequestKind; policy?: { id: string; policy_number: string | null; sum_assured?: number };
  member?: MemberRow | null; nominees?: BeneficiariesView | null; onClose: () => void; onDone: () => void;
}) {
  const key = useRef(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ reference: string } | null>(null);
  const [f, setF] = useState({ reason: '', name: '', relationship: 'Child', dob: '', cnic: '', insured: false, field: 'name', value: '', new_sum_assured: '', rider_note: '', contact_email: '', contact_phone: '' });
  const [rows, setRows] = useState<Row[]>(() => (nominees?.beneficiaries.length
    ? nominees.beneficiaries.map((b) => ({ name: b.name, relationship: b.relationship, share_pct: String(b.share_pct), date_of_birth: b.date_of_birth || '', guardian_name: b.guardian_name || '' }))
    : [{ name: '', relationship: 'Spouse', share_pct: '100', date_of_birth: '', guardian_name: '' }]));
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const total = useMemo(() => Math.round(rows.reduce((a, r) => a + (Number(r.share_pct) || 0), 0) * 100) / 100, [rows]);
  const patchRow = (i: number, p: Partial<Row>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const valid = (() => {
    switch (kind) {
      case 'MEMBER_ADD': return !!f.name.trim() && !!f.dob && (!f.insured || f.relationship === 'Spouse');
      case 'MEMBER_REMOVE': return !!member && f.reason.trim().length >= 5;
      case 'MEMBER_CORRECTION': return !!member && !!f.value.trim() && f.reason.trim().length >= 5;
      case 'COVERAGE_CHANGE': return Number(f.new_sum_assured) > 0 || f.rider_note.trim().length > 3;
      case 'NOMINEE_CHANGE': return rows.length > 0 && Math.abs(total - 100) < 0.01 && rows.every((r) => r.name.trim().length > 1 && r.relationship.trim().length > 1 && Number(r.share_pct) > 0);
      case 'CONTACT_CORRECTION': return !!(f.contact_email.trim() || f.contact_phone.trim());
      case 'CANCELLATION': return f.reason.trim().length >= 5;
      case 'REINSTATEMENT': return true;
    }
  })();

  async function submit() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    const body: Record<string, unknown> = { kind, policy_id: policy?.id, reason: f.reason.trim() || undefined };
    if (kind === 'MEMBER_ADD') Object.assign(body, { name: f.name.trim(), relationship: f.relationship, dob: f.dob, cnic: f.cnic.trim() || undefined, insured: f.insured });
    if (kind === 'MEMBER_REMOVE' || kind === 'MEMBER_CORRECTION') body.member_key = member?.key;
    if (kind === 'MEMBER_CORRECTION') body.changes = { [f.field]: f.value.trim() };
    if (kind === 'COVERAGE_CHANGE') Object.assign(body, { new_sum_assured: Number(f.new_sum_assured) || undefined, rider_note: f.rider_note.trim() || undefined });
    if (kind === 'NOMINEE_CHANGE') body.beneficiaries = rows.map((r) => ({ name: r.name.trim(), relationship: r.relationship.trim(), share_pct: Number(r.share_pct), date_of_birth: r.date_of_birth || undefined, guardian_name: r.guardian_name.trim() || undefined }));
    if (kind === 'CONTACT_CORRECTION') Object.assign(body, { contact_email: f.contact_email.trim() || undefined, contact_phone: f.contact_phone.trim() || undefined });
    try {
      const res = await post<{ reference: string }>(`/family/${encodeURIComponent(familyId)}/requests`, body, { key: key.current });
      setDone({ reference: res.reference }); onDone();
    } catch (e) {
      const er = e as ApiError;
      setError(er);
      if (!['NETWORK', 'SERVICE_UNAVAILABLE', 'DOMAIN_UNAVAILABLE', 'REQUEST_IN_PROGRESS'].includes(er.code)) key.current = newIdempotencyKey();
    } finally { setBusy(false); }
  }

  const reasonRequired = ['MEMBER_REMOVE', 'MEMBER_CORRECTION', 'CANCELLATION'].includes(kind);
  const noteOnly = kind === 'REINSTATEMENT' || kind === 'MEMBER_ADD' || kind === 'CONTACT_CORRECTION';

  return (
    <Sheet visible onClose={busy ? () => undefined : onClose} title={t(`request.kind.${kind}`)} maxHeightRatio={0.92}
      footer={done ? <Button title={t('common.done')} onPress={onClose} fullWidth /> : (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button title={t('common.cancel')} variant="outline" onPress={onClose} disabled={busy} style={{ flex: 1 }} />
          <Button title={t('request.submit')} onPress={submit} loading={busy} disabled={!valid || busy} style={{ flex: 1 }} />
        </View>)}>
      {done ? (
        <View style={{ alignItems: 'center', gap: 8, paddingVertical: 12 }}>
          <Text variant="title2" color="success">✓</Text>
          <Text variant="bodyStrong">{t('request.sent')}</Text>
          <Text variant="callout" color="muted" align="center">{t('request.sentText', { reference: done.reference })}</Text>
        </View>
      ) : (
        <View style={{ gap: 14 }}>
          <Banner tone="info" title={t('request.notice')} />
          {error ? <Banner tone="danger" title={errorText(error)} description={error.code === 'SHARES_MUST_TOTAL_100' ? t('request.sharesTotal', { total: String(error.details?.total ?? '') }) : undefined} /> : null}
          {policy ? <Text variant="caption" color="muted">{t('request.policy')}: {policy.policy_number}</Text> : null}

          {kind === 'MEMBER_ADD' ? (
            <>
              <Field label={t('profile.name')} value={f.name} onChangeText={set('name')} maxLength={255} />
              <Select label={t('policy.relationship')} value={f.relationship} options={RELATIONSHIPS.map((r) => ({ value: r, label: tOr(t, `relationship.${r}`, r) }))} onSelect={set('relationship')} />
              <DateField label={t('profile.dob')} value={f.dob} onChange={set('dob')} maxToday required />
              <Field label={t('profile.cnic')} value={f.cnic} onChangeText={set('cnic')} helperText={t('request.cnicOptional')} maxLength={20} autoCapitalize="none" />
              <CheckRow value={f.insured} onChange={set('insured')} disabled={f.relationship !== 'Spouse'} label={t('request.addInsured')} hint={t('request.addInsuredHint')} />
            </>
          ) : null}

          {(kind === 'MEMBER_REMOVE' || kind === 'MEMBER_CORRECTION') && member ? (
            <Card variant="sunken"><Text variant="callout"><Text variant="callout" color="muted">{t('request.member')}: </Text><Text variant="calloutStrong">{member.name}</Text> · {tOr(t, `relationship.${member.relationship}`, member.relationship)}</Text></Card>
          ) : null}
          {kind === 'MEMBER_REMOVE' ? <Text variant="caption" color="muted">{t('request.removeScope')}</Text> : null}
          {kind === 'MEMBER_CORRECTION' ? (
            <>
              <Select label={t('request.field')} value={f.field} options={CORRECTABLE.map((c) => ({ value: c, label: t(`request.fields.${c}`) }))} onSelect={set('field')} />
              <Field label={t('request.newValue')} value={f.value} onChangeText={set('value')} maxLength={255} />
            </>
          ) : null}

          {kind === 'COVERAGE_CHANGE' ? (
            <>
              <Field label={t('request.newCover')} value={f.new_sum_assured} onChangeText={set('new_sum_assured')} keyboardType="number-pad"
                helperText={policy?.sum_assured ? t('request.currentCover', { amount: policy.sum_assured.toLocaleString('en-PK') }) : undefined} />
              <Field label={t('request.benefitChange')} value={f.rider_note} onChangeText={set('rider_note')} maxLength={500} />
            </>
          ) : null}

          {kind === 'NOMINEE_CHANGE' ? (
            <View style={{ gap: 12 }}>
              {rows.map((r, i) => (
                <Card key={i} variant="sunken">
                  <View style={{ gap: 10 }}>
                    <Field label={t('profile.name')} value={r.name} onChangeText={(v) => patchRow(i, { name: v })} maxLength={255} />
                    <Field label={t('policy.relationship')} value={r.relationship} onChangeText={(v) => patchRow(i, { relationship: v })} maxLength={100} />
                    <Field label={`${t('policy.share')} %`} value={r.share_pct} onChangeText={(v) => patchRow(i, { share_pct: v })} keyboardType="decimal-pad" />
                    <DateField label={t('profile.dob')} value={r.date_of_birth} onChange={(v) => patchRow(i, { date_of_birth: v })} maxToday />
                    <Field label={t('request.guardian')} value={r.guardian_name} onChangeText={(v) => patchRow(i, { guardian_name: v })} maxLength={255} />
                    {rows.length > 1 ? <Pressable onPress={() => setRows(rows.filter((_, j) => j !== i))} accessibilityRole="button"><Text variant="calloutStrong" color="danger">{t('common.remove')}</Text></Pressable> : null}
                  </View>
                </Card>
              ))}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Button size="sm" variant="outline" title={t('request.addNominee')} disabled={rows.length >= 12} onPress={() => setRows([...rows, { name: '', relationship: 'Child', share_pct: '', date_of_birth: '', guardian_name: '' }])} />
                <Text variant="bodyStrong" color={Math.abs(total - 100) < 0.01 ? 'success' : 'danger'}>{t('request.shareTotal', { total })}</Text>
              </View>
              <Text variant="caption" color="muted">{t('request.minorNote')}</Text>
            </View>
          ) : null}

          {kind === 'CONTACT_CORRECTION' ? (
            <>
              <Field label={t('profile.email')} value={f.contact_email} onChangeText={set('contact_email')} keyboardType="email-address" autoCapitalize="none" maxLength={255} />
              <Field label={t('profile.phone')} value={f.contact_phone} onChangeText={set('contact_phone')} keyboardType="phone-pad" maxLength={30} />
            </>
          ) : null}

          <Field label={noteOnly ? t('request.note') : t('request.reason') + (reasonRequired ? ' *' : '')} value={f.reason} onChangeText={set('reason')} multiline maxLength={2000} inputStyle={{ minHeight: 80 }} />
          {kind === 'CANCELLATION' ? <Banner tone="warning" title={t('request.cancelWarning')} /> : null}
        </View>
      )}
    </Sheet>
  );
}
