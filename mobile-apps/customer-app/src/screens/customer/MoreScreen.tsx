import React from 'react';
import { View } from 'react-native';
import { Card, ListRow, Text } from '../../components/ui';
import Logo from '../../components/Logo';
import Screen from '../../components/ui/Screen';
import ScreenHeader from '../../components/ui/ScreenHeader';
import { useCustomer } from '../../context/CustomerContext';
import { useAuth } from '../../context/AuthContext';
import { t } from '../../i18n/t';

/** Everything that is not a bottom-tab: documents, support, family, notifications, profile, sign out. */
export default function MoreScreen({ navigation }: { navigation: any }) {
  const { hasFamily, unread } = useCustomer();
  const { signOut } = useAuth();
  return (
    <Screen header={<ScreenHeader title="More" leading="none" />} scrollable padded contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
      <Card padding="xs">
        <ListRow icon="notifications-outline" title={t('notifications.title')} value={unread > 0 ? String(unread) : undefined} onPress={() => navigation.navigate('Notifications')} />
        <ListRow icon="download-outline" title={t('nav.documents')} onPress={() => navigation.navigate('Documents')} />
        {hasFamily ? <ListRow icon="people-outline" title={t('nav.family')} onPress={() => navigation.navigate('FamilyList')} /> : null}
        <ListRow icon="chatbubbles-outline" title={t('nav.support')} onPress={() => navigation.navigate('Support')} />
        <ListRow icon="person-outline" title={t('nav.profile')} onPress={() => navigation.navigate('Profile')} />
      </Card>
      <Card padding="xs"><ListRow icon="log-out-outline" title={t('account.signOut')} destructive onPress={signOut} /></Card>
      <View style={{ alignItems: 'center', gap: 10, marginTop: 8 }}>
        <Logo variant="full" width={200} />
        <Text variant="caption" color="subtle" align="center">{t('footer.text')}</Text>
      </View>
    </Screen>
  );
}
