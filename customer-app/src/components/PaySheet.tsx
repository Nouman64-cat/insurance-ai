import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Select, Sheet, Text } from './ui';
import { KeyValue } from './common';
import DownloadButton from './DownloadButton';
import { ApiError } from '../api/client';
import { post } from '../api/portal';
import { errorText } from '../i18n/errorText';
import { t } from '../i18n/t';
import { date, money, newIdempotencyKey } from '../lib/format';
import type { Installment, PolicyCard, Receipt } from '../api/portalTypes';

const METHODS = ['JazzCash', 'Easypaisa', 'Card', 'BankTransfer'] as const;
type Stage = 'review' | 'working' | 'done' | 'failed';

/**
 * Pays one instalment through the platform's payment gateway (currently the SIMULATED one, as the web portal says). The amount shown
 * is what the ledger says is payable now and the server re-checks it. One Idempotency-Key per attempt, reused for retries of an
 * unknown outcome so a repeat can never charge twice, and replaced only after a definite refusal.
 */
export default function PaySheet({ policy, installment, onClose, onPaid }: { policy: PolicyCard; installment: Installment; onClose: () => void; onPaid: () => void }) {
  const [method, setMethod] = useState<(typeof METHODS)[number]>('JazzCash');
  const [stage, setStage] = useState<Stage>('review');
  const [error, setError] = useState<ApiError | null>(null);
  const [receipt, setReceipt] = useState<Partial<Receipt> | null>(null);
  const [amount, setAmount] = useState(installment.payable);
  const key = useRef(newIdempotencyKey());

  async function pay() {
    setStage('working'); setError(null);
    try {
      const res = await post<{ receipt: Partial<Receipt> | null; duplicate?: boolean }>(`/policies/${policy.id}/premiums/${installment.id}/pay`, { method, expected_amount: amount }, { key: key.current });
      setReceipt(res.receipt); setStage('done'); onPaid();
    } catch (e) {
      const err = e as ApiError;
      setError(err); setStage('failed');
      if (err.code === 'AMOUNT_CHANGED' && typeof err.details?.payable === 'number') { setAmount(err.details.payable); key.current = newIdempotencyKey(); }
      else if (!['NETWORK', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'DOMAIN_UNAVAILABLE', 'PAYMENT_IN_PROGRESS'].includes(err.code)) key.current = newIdempotencyKey();
      if (['ALREADY_PAID', 'PAY_OLDEST_FIRST', 'AMOUNT_CHANGED'].includes(err.code)) onPaid(); // refresh what the screen shows
    }
  }

  const handle = receipt?.id ? `receipt:${policy.id}:${receipt.id}` : null;
  const blocked = stage === 'failed' && ['ALREADY_PAID', 'PAY_OLDEST_FIRST', 'POLICY_NOT_PAYABLE'].includes(error?.code || '');
  return (
    <Sheet visible onClose={stage === 'working' ? () => undefined : onClose} title={t('pay.title')} dismissOnBackdropPress={stage !== 'working'}
      footer={stage === 'done' ? <Button title={t('common.done')} onPress={onClose} fullWidth /> : (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button title={t('common.cancel')} variant="outline" onPress={onClose} disabled={stage === 'working'} style={{ flex: 1 }} />
          <Button title={stage === 'failed' ? t('pay.tryAgain') : t('pay.confirm', { amount: money(amount) })} onPress={pay} loading={stage === 'working'} disabled={stage === 'working' || blocked} style={{ flex: 1.4 }} />
        </View>)}>
      <View style={{ gap: 14 }}>
        {stage !== 'done' ? (
          <>
            <View>
              <KeyValue label={t('pay.policy')}>{policy.policy_number}</KeyValue>
              <KeyValue label={t('pay.installment')}>{`#${installment.installment_no} · ${date(installment.due_date)}`}</KeyValue>
              {installment.surcharge > 0 ? <KeyValue label={t('pay.surcharge')}><Text variant="calloutStrong" color="warning">{money(installment.surcharge)}</Text></KeyValue> : null}
              <KeyValue label={t('pay.total')} last><Text variant="title3">{money(amount)}</Text></KeyValue>
            </View>
            <Select label={t('pay.method')} value={method} options={METHODS.map((m) => ({ value: m, label: t(`pay.methods.${m}`) }))} onSelect={(v) => setMethod(v as (typeof METHODS)[number])} disabled={stage === 'working'} />
          </>
        ) : null}
        {stage === 'failed' && error ? <Banner tone="danger" title={errorText(error)} description={error.code === 'AMOUNT_CHANGED' ? t('pay.amountChanged', { amount: money(amount) }) : undefined} /> : null}
        {stage === 'done' ? (
          <View style={{ alignItems: 'center', gap: 8, paddingVertical: 8 }}>
            <Text variant="display" color="success">✓</Text>
            <Text variant="title3">{t('pay.success')}</Text>
            <Text variant="callout" color="muted" align="center">{t('pay.successText', { amount: money(amount), receipt: receipt?.receipt_no || '' })}</Text>
            <Banner tone="warning" title={t('pay.simulatedReceipt')} />
            {handle ? <DownloadButton handle={handle} fallbackName={`${receipt?.receipt_no || 'receipt'}.pdf`} label={t('payments.downloadReceipt')} /> : null}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}
