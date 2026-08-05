import { Ionicons } from '@expo/vector-icons';
import { ToneName } from '../theme/palette';

/**
 * Every notification the app can raise. The kind drives the icon, tone and
 * where tapping it navigates, so adding a new event type means adding a case
 * to `NOTIFICATION_PRESETS` rather than threading styling through call sites.
 */
export type NotificationKind =
  | 'lead.created'
  | 'lead.updated'
  | 'lead.assigned'
  | 'lead.deleted'
  | 'proposal.created'
  | 'case.updated'
  | 'sync.error'
  | 'generic';

/** Where tapping the notification should take the user. */
export interface NotificationTarget {
  screen: string;
  params?: Record<string, unknown>;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Epoch milliseconds. Stored as a number so it survives JSON round-trips. */
  createdAt: number;
  read: boolean;
  target?: NotificationTarget;
  /** Name of the agent who caused the event, when the backend reports one. */
  actorName?: string;
  /** Free-form payload carried through to the screen the target opens. */
  data?: Record<string, unknown>;
}

/** A transient message. Toasts are ephemeral and never persisted. */
export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone: ToneName;
  icon: keyof typeof Ionicons.glyphMap;
  /** Milliseconds before auto-dismiss. 0 keeps it up until tapped. */
  durationMs: number;
  onPress?: () => void;
  actionLabel?: string;
}

export interface NotificationPreset {
  tone: ToneName;
  icon: keyof typeof Ionicons.glyphMap;
}

export const NOTIFICATION_PRESETS: Record<NotificationKind, NotificationPreset> = {
  'lead.created': { tone: 'success', icon: 'person-add-outline' },
  'lead.updated': { tone: 'brand', icon: 'swap-horizontal-outline' },
  'lead.assigned': { tone: 'accent', icon: 'person-circle-outline' },
  'lead.deleted': { tone: 'neutral', icon: 'trash-outline' },
  'proposal.created': { tone: 'info', icon: 'document-text-outline' },
  'case.updated': { tone: 'warning', icon: 'folder-open-outline' },
  'sync.error': { tone: 'danger', icon: 'cloud-offline-outline' },
  generic: { tone: 'neutral', icon: 'notifications-outline' },
};

/** "just now" / "12m ago" / "3h ago" / "5 Aug" — matches how agents scan a feed. */
export const formatRelativeTime = (timestamp: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
