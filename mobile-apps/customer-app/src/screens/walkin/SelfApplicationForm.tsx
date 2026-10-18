import React, { useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Field, Select, SegmentedControl, Skeleton, Text } from '../../components/ui';
import { CheckRow, DateField } from '../../components/common';
import { errorText } from '../../i18n/errorText';
import { t } from '../../i18n/t';
import { ApiError } from '../../api/client';
import { post } from '../../api/portal';
import { newIdempotencyKey } from '../../lib/format';
import type { WalkInPlan } from '../../api/types';
import { DEMO } from '../../config';
import { demoApplication } from '../../lib/demoWalkIn';
import { FIELDS, FieldDef, FormState, TABS, TabId, buildProfile, emptyForm, missing, optionKey } from '../../lib/walkinForm';

const CONTACT = ['Any', 'Phone', 'WhatsApp', 'Email'] as const;

/** "For myself": the same eight sections, fields and required rules as the web portal (and the insurer's Add New Customer form). */
export default function SelfApplicationForm({ plans, plansLoading, email, initialPlanId, onDone }: {
  plans: WalkInPlan[]; plansLoading: boolean; email: string; initialPlanId: string; onDone: (reference: string) => void;
}) {
  const [f, setF] = useState<FormState>(() => ({ ...emptyForm(), plan_id: initialPlanId }));
  const [tab, setTab] = useState<TabId>('demographics');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const key = useRef(newIdempotencyKey()); // one key per form: a double tap or retry can never create a second request
  const set = (k: string, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  const individualPlans = useMemo(() => plans.filter((p) => p.category === 'Individual'), [plans]);
  const chosen = plans.find((p) => p.id === f.plan_id);
  const gaps = missing(f);
  const valid = TABS.every((k) => gaps[k].length === 0);
  const idx = Math.max(TABS.indexOf(tab), 0);

  async function submit() {
    if (!valid || busy || chosen?.category !== 'Individual') return;
    setBusy(true); setError(null);
    try {
      const r = await post<{ reference: string }>('/walk-in/application', {
        applicant_type: 'Self', profile: buildProfile(f), plan_id: f.plan_id, preferred_contact: f.preferred_contact,
        message: String(f.message).trim() || undefined, consent: f.consent,
      }, { key: key.current });
      onDone(r.reference);
    } catch (e) {
      const err = e as ApiError;
      setError(err);
      const bad = Array.isArray(err.details?.fields) ? String(err.details.fields[0]?.field ?? '') : '';
      const hit = FIELDS.find((d) => bad.includes(d.name));
      if (hit) setTab(hit.tab);
    } finally { setBusy(false); }
  }

  function control(d: FieldDef) {
    const label = t(`walkin.f.${d.name}`);
    const miss = d.required && !String(f[d.name] ?? '').trim();
    if (d.kind === 'bool') return <CheckRow key={d.name} value={!!f[d.name]} onChange={(v) => set(d.name, v)} label={label} />;
    if (d.kind === 'date') return <DateField key={d.name} label={label} required={d.required} value={String(f[d.name])} onChange={(v) => set(d.name, v)} maxToday={d.name === 'date_of_birth'} />;
    if (d.kind === 'select') {
      return (
        <Select key={d.name} label={label} required={d.required} value={String(f[d.name]) || null} placeholder={t('walkin.apply.optional')} clearable={!d.required}
          options={d.options!.map((o) => ({ value: o, label: d.name === 'province' ? o : t(`walkin.o.${optionKey(o)}`) }))} onSelect={(v) => set(d.name, v)} />
      );
    }
    return (
      <Field key={d.name} label={label + (d.required ? ' *' : '')} value={String(f[d.name])} onChangeText={(v) => set(d.name, v)} maxLength={d.max} placeholder={d.placeholder}
        keyboardType={d.kind === 'number' ? 'decimal-pad' : d.kind === 'tel' ? 'phone-pad' : 'default'} autoCapitalize={d.dir === 'ltr' ? 'none' : 'sentences'} autoCorrect={false}
        multiline={!!d.wide && d.name === 'street_address'} accessibilityLabel={label} />
    );
  }

  const tabFields = FIELDS.filter((d) => d.tab === tab);
  const fillDemo = () => { setError(null); setF(demoApplication(plans, String(f.plan_id || initialPlanId))); };

  return (
    <View style={{ gap: 14 }}>
      {DEMO ? <Button size="sm" variant="outline" icon="flash-outline" title={t('walkin.apply.demo')} onPress={fillDemo} disabled={plansLoading} /> : null}
      <SegmentedControl variant="chips" value={tab} onChange={setTab}
        segments={TABS.map((k) => ({ value: k, label: t(`walkin.tab.${k}`) + (gaps[k].length ? ' •' : '') }))} />
      <Card>
        <View style={{ gap: 14 }}>
          {error ? <Banner tone="danger" title={errorText(error)} /> : null}
          {tab === 'demographics' ? <Field label={t('walkin.apply.email')} value={email} editable={false} helperText={t('walkin.apply.emailVerified')} /> : null}
          {tabFields.map(control)}

          {tab === 'plan' ? (
            <View style={{ gap: 14 }}>
              {plansLoading ? <Skeleton height={48} radius={12} /> : (
                <Select label={t('walkin.apply.plan')} required value={String(f.plan_id) || null} placeholder={t('walkin.apply.choosePlan')} helperText={t('walkin.apply.planHint')}
                  options={individualPlans.map((p) => ({ value: p.id, label: p.label, description: t(`walkin.category.${p.category}`) }))} onSelect={(v) => set('plan_id', v)} />
              )}
              {chosen && chosen.category !== 'Individual' ? <Banner tone="info" title={t('walkin.apply.groupNote', { category: t(`walkin.category.${chosen.category}`) })} /> : null}
              {chosen ? <Text variant="caption" color="muted">{t('walkin.apply.planBand', { min: chosen.entry_age_min, max: chosen.entry_age_max, tmin: chosen.term_min_years, tmax: chosen.term_max_years })}</Text> : null}
              <Select label={t('walkin.apply.contactPref')} value={String(f.preferred_contact)} options={CONTACT.map((c) => ({ value: c, label: t(`walkin.contact.${c}`) }))} onSelect={(v) => set('preferred_contact', v)} />
              <Field label={t('walkin.apply.message')} value={String(f.message)} onChangeText={(v) => set('message', v)} multiline maxLength={1000} inputStyle={{ minHeight: 90 }} />
              <CheckRow value={!!f.consent} onChange={(v) => set('consent', v)} label={t('walkin.apply.consent')} />
            </View>
          ) : null}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title={t('common.back')} variant="outline" disabled={idx === 0} onPress={() => setTab(TABS[idx - 1])} style={{ flex: 1 }} />
        {idx < TABS.length - 1
          ? <Button title={t('walkin.apply.next')} onPress={() => setTab(TABS[idx + 1])} style={{ flex: 1 }} />
          : <Button title={t('walkin.apply.submit')} loading={busy} disabled={!valid || busy} onPress={submit} style={{ flex: 1 }} />}
      </View>
      {!valid ? <Text variant="caption" color="muted">{t('walkin.apply.completeRequired')}</Text> : null}
    </View>
  );
}

