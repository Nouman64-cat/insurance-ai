import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { statusTone, entityTone, statusLabel, entityLabel } from '../theme/palette';
import { UnifiedLead } from '../api/leads';
import { formatRelativeTime } from '../notifications/types';
import { Text, Card, Badge, Avatar, Pressable } from './ui';

export interface LeadCardProps {
  lead: UnifiedLead;
  onPress?: () => void;
  onMenu?: () => void;
  /** Shows who owns the lead — used on the admin/all-leads board. */
  showOwner?: boolean;
  /** Trims the card for dense contexts like the dashboard's recent list. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

const ENTITY_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  INDIVIDUAL: 'person',
  FAMILY: 'people',
  CORPORATE: 'business',
};

/**
 * The primary lead representation.
 *
 * Deliberately carries no status controls: advancing a lead through the
 * pipeline is underwriting's and operations' decision, made in the portal.
 * The agent's job here is to capture the lead and track where it has reached.
 */
export default function LeadCard({
  lead,
  onPress,
  onMenu,
  showOwner = false,
  compact = false,
  style,
}: LeadCardProps) {
  const { colors } = useTheme();

  const tone = statusTone[lead.status] ?? 'neutral';
  const typeTone = entityTone[lead.type] ?? 'neutral';

  return (
    <Card
      onPress={onPress}
      padding="lg"
      style={style}
      accessibilityLabel={`${lead.name}, ${statusLabel[lead.status] ?? lead.status}`}
    >
      <View style={styles.header}>
        <Avatar
          name={lead.name}
          icon={ENTITY_ICON[lead.type]}
          tone={typeTone}
          size={compact ? 40 : 46}
          shape={lead.type === 'INDIVIDUAL' ? 'circle' : 'rounded'}
        />

        <View style={styles.identity}>
          <Text variant="title3" numberOfLines={1}>
            {lead.name || 'Unnamed lead'}
          </Text>
          <View style={styles.metaRow}>
            <Text variant="caption" color="muted">
              {entityLabel[lead.type] ?? lead.type}
            </Text>
            {lead.memberCount ? (
              <>
                <Text variant="caption" color="subtle">
                  ·
                </Text>
                <Text variant="caption" color="muted">
                  {lead.memberCount} {lead.type === 'FAMILY' ? 'members' : 'employees'}
                </Text>
              </>
            ) : null}
          </View>
        </View>

        {onMenu ? (
          <Pressable
            onPress={onMenu}
            pressedScale={0.88}
            accessibilityRole="button"
            accessibilityLabel={`Options for ${lead.name}`}
            style={styles.menu}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={colors.textSubtle} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.details}>
        <Detail icon="call-outline" value={lead.contact_info} />
        {lead.city ? <Detail icon="location-outline" value={lead.city} /> : null}
        {showOwner ? (
          <Detail
            icon="person-circle-outline"
            value={lead.assignedAgentName ?? 'Unassigned'}
            muted={!lead.assignedAgentName}
          />
        ) : null}
      </View>

      <View style={[styles.footer, { borderTopColor: colors.borderSubtle }]}>
        <Badge label={statusLabel[lead.status] ?? lead.status} tone={tone} variant="soft" dot />
        <Text variant="micro" color="subtle">
          {formatRelativeTime(new Date(lead.created_at).getTime())}
        </Text>
      </View>

      {!compact && onPress ? (
        <View style={[styles.viewHint, { borderTopColor: colors.borderSubtle }]}>
          <Text variant="captionStrong" style={{ color: colors.tone.brand.on }}>
            View journey
          </Text>
          <Ionicons name="arrow-forward" size={14} color={colors.tone.brand.on} />
        </View>
      ) : null}
    </Card>
  );
}

function Detail({
  icon,
  value,
  muted,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  muted?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.detail}>
      <Ionicons name={icon} size={14} color={colors.textSubtle} />
      <Text
        variant="caption"
        color={muted ? 'subtle' : 'muted'}
        numberOfLines={1}
        style={styles.detailText}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  identity: {
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xxs,
  },
  menu: {
    padding: spacing.xs,
  },
  details: {
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  detail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  detailText: {
    flex: 1,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  viewHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
