import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Field, Select, SegmentedControl, Skeleton, Text, Pressable } from '../../components/ui';
import { CheckRow, DateField } from '../../components/common';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import { ApiError } from '../../api/client';
import { post } from '../../api/portal';
import { newIdempotencyKey } from '../../lib/format';
import { DEMO } from '../../config';
import { demoFamily } from '../../lib/demoWalkIn';
import type { WalkInPlan } from '../../api/types';
import {
  FAMILY_TABS, FamilyDetails, FamilyRow, FamilyTab, MemberKind, NOMINEE_RELATIONSHIPS, PROVINCES, blankRow, buildFamily, emptyFamily, familyGaps, isInsured, optionKey, startRows, totalShare,
} from '../../lib/walkinForm';

const CONTACT = ['Any', 'Phone', 'WhatsApp', 'Email'] as const;
const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

/** "For my family": the same three sections, order and fields as the web portal (and the insurer's Add New Family form). */
export default function FamilyApplicationForm({ plans, plansLoading, email, initialPlanId, onDone }: {
  plans: WalkInPlan[]; plansLoading: boolean; email: string; initialPlanId: string; onDone: (reference: string) => void;
}) {
  const [tab, setTab] = useState<FamilyTab>('details');
  const [d, setD] = useState<FamilyDetails>(() => ({ ...emptyFamily(), plan_id: initialPlanId }));
  const [rows, setRows] = useState<FamilyRow[]>(startRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const key = useRef(newIdempotencyKey());
  const set = (patch: Partial<FamilyDetails>) => setD((s) => ({ ...s, ...patch }));
  const patchRow = (i: number, patch: Partial<FamilyRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  useEffect(() => { if (initialPlanId && !d.plan_id) set({ plan_id: initialPlanId }); }, [initialPlanId]); // eslint-disable-line react-hooks/exhaustive-deps

  const gaps = familyGaps(d, rows);
  const valid = FAMILY_TABS.every((k) => gaps[k].length === 0);
  const idx = FAMILY_TABS.indexOf(tab);
  const bundle = d.kind === 'LifeBundle';
  const familyPlans = useMemo(() => plans.filter((p) => p.category === 'Family'), [plans]);
  const chosen = familyPlans.find((p) => p.id === d.plan_id);
  const nominees = rows.filter((r) => r.kind !== 'Self');
  const total = totalShare(rows);
  const base = bundle ? Number(rows.find((r) => r.kind === 'Self')?.coverage_amount) || 0 : Number(d.sum_insured) || 0;
  const miss = (i: number, f: string) => gaps.members.includes(`row.${i}.${f}`) ? t('walkin.apply.required') : undefined;

  function splitEvenly() {
    const n = nominees.length;
    if (!n) return;
    const each = Math.floor((100 / n) * 100) / 100;
    let left = Math.round((100 - each * n) * 100) / 100;
    setRows(rows.map((r) => { if (r.kind === 'Self') return r; const extra = left > 0 ? left : 0; left = 0; return { ...r, share_pct: String(Math.round((each + extra) * 100) / 100) }; }));
  }
  const changeKind = (i: number, kind: MemberKind) => patchRow(i, { kind, relationship: kind === 'Nominee' ? rows[i].relationship || 'Child' : '', insured: kind === 'Spouse' ? rows[i].insured : '' });

  async function submit() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await post<{ reference: string }>('/walk-in/application', {
        applicant_type: 'Family', family: buildFamily(d, rows), plan_id: d.plan_id, preferred_contact: d.preferred_contact, message: d.message.trim() || undefined, consent: d.consent,
      }, { key: key.current });
      onDone(r.reference);
    } catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  }

  const memberCard = (r: FamilyRow, i: number) => {
    const ins = isInsured(r), off = !ins;
    const amount = r.kind === 'Self' ? null : (base * (Number(r.share_pct) || 0)) / 100;
    return (
      <Card key={i} variant="sunken">
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="title3">{r.kind === 'Self' ? t('walkin.fam.head') : r.kind === 'Spouse' ? t('walkin.o.Spouse') : t('walkin.fam.nominee')}</Text>
            {r.kind !== 'Self' ? <Pressable onPress={() => setRows(rows.filter((_, j) => j !== i))} accessibilityRole="button" accessibilityLabel={t('walkin.family.remove')}><Text variant="calloutStrong" color="danger">{t('walkin.family.remove')}</Text></Pressable> : null}
          </View>
          {r.kind !== 'Self' ? (
            <Select label={t('walkin.fam.member')} value={r.kind} options={[{ value: 'Spouse', label: t('walkin.o.Spouse') }, { value: 'Nominee', label: t('walkin.fam.nominee') }]} onSelect={(v) => changeKind(i, v as MemberKind)} />
          ) : null}
          {r.kind === 'Nominee' ? (
            <Select label={t('walkin.fam.relation')} value={r.relationship} options={NOMINEE_RELATIONSHIPS.map((o) => ({ value: o, label: t(`walkin.o.${optionKey(o)}`) }))} onSelect={(v) => patchRow(i, { relationship: v })} />
          ) : null}
          {r.kind === 'Spouse' ? (
            <Select label={t('walkin.fam.insured')} value={r.insured || null} placeholder={t('walkin.fam.select')} error={miss(i, 'insured')}
              options={[{ value: 'yes', label: t('walkin.fam.yes') }, { value: 'no', label: t('walkin.fam.no') }]} onSelect={(v) => patchRow(i, { insured: v as FamilyRow['insured'] })} />
          ) : null}
          <Field label={t('walkin.fam.name')} value={r.name} onChangeText={(v) => patchRow(i, { name: v })} maxLength={255} error={miss(i, 'name')} />
          <Field label={t('walkin.fam.cnic')} value={r.cnic} onChangeText={(v) => patchRow(i, { cnic: v })} maxLength={15} placeholder="35201-1234567-1" editable={!off} autoCapitalize="none" error={miss(i, 'cnic')} />
          <DateField label={t('walkin.fam.dob')} value={r.dob} onChange={(v) => patchRow(i, { dob: v })} maxToday error={miss(i, 'dob')} />
          <Select label={t('walkin.f.gender')} value={r.gender || null} placeholder="—" error={miss(i, 'gender')} options={['Male', 'Female', 'Other'].map((g) => ({ value: g, label: t(`walkin.o.${g}`) }))} onSelect={(v) => patchRow(i, { gender: v })} />
          {ins ? (
            <>
              <Field label={t('walkin.f.occupation')} value={r.occupation} onChangeText={(v) => patchRow(i, { occupation: v })} error={miss(i, 'occupation')} />
              <Field label={t('walkin.fam.income')} value={r.declared_income} onChangeText={(v) => patchRow(i, { declared_income: v })} keyboardType="number-pad" error={miss(i, 'declared_income')} />
              <Select label={t('walkin.fam.smoker')} value={r.is_smoker || null} placeholder="—" options={[{ value: 'false', label: t('walkin.fam.no') }, { value: 'true', label: t('walkin.fam.yes') }]} onSelect={(v) => patchRow(i, { is_smoker: v as FamilyRow['is_smoker'] })} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Field containerStyle={{ flex: 1 }} label={t('walkin.fam.ht')} value={r.height_cm} onChangeText={(v) => patchRow(i, { height_cm: v })} keyboardType="decimal-pad" />
                <Field containerStyle={{ flex: 1 }} label={t('walkin.fam.wt')} value={r.weight_kg} onChangeText={(v) => patchRow(i, { weight_kg: v })} keyboardType="decimal-pad" />
              </View>
              {bundle ? <Field label={t('walkin.fam.cover')} value={r.coverage_amount} onChangeText={(v) => patchRow(i, { coverage_amount: v })} keyboardType="number-pad" error={miss(i, 'coverage_amount')} /> : null}
            </>
          ) : null}
          {r.kind !== 'Self' ? (
            <Field label={t('walkin.fam.share')} value={r.share_pct} onChangeText={(v) => patchRow(i, { share_pct: v })} keyboardType="decimal-pad" error={miss(i, 'share_pct')}
              helperText={amount !== null ? `${t('walkin.fam.amount')}: ${pkr(amount)}` : undefined} />
          ) : null}
        </View>
      </Card>
    );
  };

  const fillDemo = () => { setError(null); const demo = demoFamily(plans, d.plan_id || initialPlanId); setD(demo.details); setRows(demo.rows); };

  return (
    <View style={{ gap: 14 }}>
      {DEMO ? <Button size="sm" variant="outline" icon="flash-outline" title={t('walkin.apply.demo')} onPress={fillDemo} disabled={plansLoading} /> : null}
      <SegmentedControl variant="chips" value={tab} onChange={setTab}
        segments={FAMILY_TABS.map((k) => ({ value: k, label: (k === 'members' ? t('walkin.fam.tab.members', { count: rows.length }) : t(`walkin.fam.tab.${k}`)) + (gaps[k].length ? ' •' : '') }))} />
      {error ? <Banner tone="danger" title={errorText(error)} /> : null}

      {tab === 'details' ? (
        <Card><View style={{ gap: 14 }}>
          <Field label={t('walkin.fam.familyName') + ' *'} value={d.family_name} onChangeText={(v) => set({ family_name: v })} placeholder={t('walkin.fam.familyNamePh')} maxLength={255} />
          <Field label={t('walkin.fam.contactPerson')} value={d.contact_person} onChangeText={(v) => set({ contact_person: v })} placeholder={t('walkin.fam.contactPersonPh')} maxLength={255} />
          <Field label={t('walkin.fam.contactEmail')} value={email} editable={false} helperText={t('walkin.apply.emailVerified')} />
          <Field label={t('walkin.fam.contactPhone') + ' *'} value={d.contact_phone} onChangeText={(v) => set({ contact_phone: v })} keyboardType="phone-pad" placeholder="+92 300 1234567" maxLength={30} />
          <Field label={t('walkin.fam.householdIncome')} value={d.household_income} onChangeText={(v) => set({ household_income: v })} keyboardType="number-pad" helperText={t('walkin.fam.householdIncomeHint')} />
          <Field label={t('walkin.f.city') + ' *'} value={d.city} onChangeText={(v) => set({ city: v })} placeholder={t('walkin.fam.cityPh')} maxLength={100} />
          <Select label={t('walkin.f.province')} value={d.province || null} placeholder={t('walkin.fam.selectProvince')} clearable options={PROVINCES.map((p) => ({ value: p, label: p }))} onSelect={(v) => set({ province: v })} />
        </View></Card>
      ) : null}

      {tab === 'policy' ? (
        <Card><View style={{ gap: 14 }}>
          {plansLoading ? <Skeleton height={48} radius={12} /> : (
            <Select label={t('walkin.apply.plan')} required value={d.plan_id || null} placeholder={t('walkin.apply.choosePlan')} helperText={t('walkin.apply.planHint')}
              options={familyPlans.map((p) => ({ value: p.id, label: p.label }))} onSelect={(v) => set({ plan_id: v })} />
          )}
          {chosen ? <Text variant="caption" color="muted">{t('walkin.apply.planBand', { min: chosen.entry_age_min, max: chosen.entry_age_max, tmin: chosen.term_min_years, tmax: chosen.term_max_years })}</Text> : null}
          <View style={{ gap: 8 }}>
            {(['Floater', 'LifeBundle'] as const).map((k) => (
              <Card key={k} bordered onPress={() => set({ kind: k })} variant={d.kind === k ? 'outline' : 'surface'} accessibilityLabel={t(`walkin.fam.kind.${k}`)}>
                <Text variant="bodyStrong" color={d.kind === k ? 'brand' : 'default'}>{t(`walkin.fam.kind.${k}`)}</Text>
                <Text variant="caption" color="muted">{t(`walkin.fam.kind.${k}Text`)}</Text>
              </Card>
            ))}
          </View>
          {bundle
            ? <Field label={t('walkin.fam.discount')} value={d.discount} onChangeText={(v) => set({ discount: v })} keyboardType="decimal-pad" />
            : <Field label={t('walkin.fam.sumInsured') + ' *'} value={d.sum_insured} onChangeText={(v) => set({ sum_insured: v })} keyboardType="number-pad" />}
          <Field label={t('walkin.fam.term') + ' *'} value={d.term} onChangeText={(v) => set({ term: v })} keyboardType="number-pad" />
          <DateField label={t('walkin.fam.effective')} value={d.effective} onChange={(v) => set({ effective: v })} />
          <Select label={t('walkin.apply.contactPref')} value={d.preferred_contact} options={CONTACT.map((c) => ({ value: c, label: t(`walkin.contact.${c}`) }))} onSelect={(v) => set({ preferred_contact: v })} />
          <Field label={t('walkin.apply.message')} value={d.message} onChangeText={(v) => set({ message: v })} multiline maxLength={1000} inputStyle={{ minHeight: 80 }} />
          <CheckRow value={d.consent} onChange={(v) => set({ consent: v })} label={t('walkin.apply.consent')} />
        </View></Card>
      ) : null}

      {tab === 'members' ? (
        <View style={{ gap: 12 }}>
          <Text variant="caption" color="muted">{t('walkin.fam.membersHelp')}</Text>
          {rows.map(memberCard)}
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            {rows.length < 8 ? <Button size="sm" variant="outline" title={t('walkin.family.addMember')} onPress={() => setRows([...rows, blankRow('Nominee')])} /> : null}
            {nominees.length > 1 ? <Button size="sm" variant="outline" title={t('walkin.family.split')} onPress={splitEvenly} /> : null}
          </View>
          <Text variant="calloutStrong" color={nominees.length === 0 || Math.abs(total - 100) <= 0.01 ? 'muted' : 'warning'}>{t('walkin.family.total', { total })}</Text>
          {gaps.members.filter((g) => !g.startsWith('row.')).map((g) => <Text key={g} variant="caption" color="warning">{t(`walkin.fam.gap.${g}`)}</Text>)}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title={t('common.back')} variant="outline" disabled={idx === 0} onPress={() => setTab(FAMILY_TABS[idx - 1])} style={{ flex: 1 }} />
        {idx < FAMILY_TABS.length - 1
          ? <Button title={t('walkin.apply.next')} onPress={() => setTab(FAMILY_TABS[idx + 1])} style={{ flex: 1 }} />
          : <Button title={t('walkin.apply.submit')} loading={busy} disabled={!valid || busy} onPress={submit} style={{ flex: 1 }} />}
      </View>
      {!valid ? <Text variant="caption" color="muted">{t('walkin.apply.completeRequired')}</Text> : null}
    </View>
  );
}
