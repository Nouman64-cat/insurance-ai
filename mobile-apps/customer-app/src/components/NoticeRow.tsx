import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Pressable, Text } from './ui';
import { useTheme } from '../theme/ThemeContext';
import { date, money } from '../lib/format';
import { t } from '../i18n/t';
import type { Notice } from '../api/portalTypes';

const TONE = { critical: 'danger', warning: 'warning', success: 'success', info: 'info' } as const;
const ICON: Record<Notice['severity'], keyof typeof Ionicons.glyphMap> = { critical: 'alert-circle', warning: 'alert-circle', success: 'checkmark-circle', info: 'notifications' };

/** A notification, worded from its kind and parameters (same templates as the web portal). Tapping opens the policy or claim. */
export default function NoticeRow({ n, compact, onMarkRead }: { n: Notice; compact?: boolean; onMarkRead?: () => void }) {
  const { colors } = useTheme();
  const nav = useNavigation<any>();
  const p = n.params;
  const vars = {
    policy: p.policy_number ?? '', amount: typeof p.amount === 'number' ? money(p.amount) : '',
    date: p.due_date ? date(String(p.due_date)) : p.date ? date(String(p.date)) : '',
    graceUntil: p.grace_until ? date(String(p.grace_until)) : '', days: p.days ?? p.days_left ?? '', claim: p.claim_number ?? '',
  } as Record<string, string | number>;
  const tone = colors.tone[TONE[n.severity]];
  const open = () => {
    if (n.claim_id) nav.navigate('ClaimDetail', { id: n.claim_id });
    else if (n.policy_id) nav.navigate('PolicyDetail', { id: n.policy_id });
  };
  return (
    <Pressable onPress={open} accessibilityRole="button" style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', opacity: n.read ? 0.7 : 1, paddingVertical: 8 }}>
      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: tone.soft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={ICON[n.severity]} size={18} color={tone.on} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">{t(`notice.${n.kind}.title`, vars)}</Text>
        {!compact ? <Text variant="callout" color="muted">{t(`notice.${n.kind}.text`, vars)}</Text> : null}
        {!n.read && onMarkRead ? <Pressable onPress={onMarkRead} accessibilityRole="button"><Text variant="captionStrong" color="muted" style={{ marginTop: 4 }}>{t('notifications.markRead')}</Text></Pressable> : null}
      </View>
      {!n.read ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginTop: 6 }} accessibilityLabel={t('notifications.unread')} /> : null}
    </Pressable>
  );
}
