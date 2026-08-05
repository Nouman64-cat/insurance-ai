import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AppNotification,
  NotificationKind,
  NotificationTarget,
  NOTIFICATION_PRESETS,
  Toast,
} from './types';
import { ToneName } from '../theme/palette';
import { Ionicons } from '@expo/vector-icons';

/** Keeping the persisted feed bounded stops storage growing without limit. */
const MAX_STORED = 100;
const STORAGE_KEY = 'app_notifications_v1';
const DEFAULT_TOAST_MS = 4200;

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  target?: NotificationTarget;
  actorName?: string;
  data?: Record<string, unknown>;
  /** Suppresses the toast while still recording it in the feed. */
  silent?: boolean;
  /** Raises the interrupting popup as well as the toast. */
  popup?: boolean;
}

interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  toasts: Toast[];
  /** The notification currently held in the interrupting popup, if any. */
  popup: AppNotification | null;

  /** Records a notification in the feed and (unless silent) shows a toast. */
  notify: (input: NotifyInput) => AppNotification;
  /** Fire-and-forget toast with no feed entry — for local action confirmations. */
  toast: (
    title: string,
    options?: { body?: string; tone?: ToneName; icon?: keyof typeof Ionicons.glyphMap; durationMs?: number }
  ) => void;

  dismissToast: (id: string) => void;
  dismissPopup: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clearAll: () => void;
}

const noop = () => {};

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unreadCount: 0,
  toasts: [],
  popup: null,
  notify: () => {
    throw new Error('NotificationProvider is missing from the tree');
  },
  toast: noop,
  dismissToast: noop,
  dismissPopup: noop,
  markRead: noop,
  markAllRead: noop,
  remove: noop,
  clearAll: noop,
});

const TONE_ICONS: Record<ToneName, keyof typeof Ionicons.glyphMap> = {
  brand: 'information-circle',
  info: 'information-circle',
  success: 'checkmark-circle',
  warning: 'warning',
  danger: 'alert-circle',
  neutral: 'information-circle',
  accent: 'information-circle-outline',
};

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [popup, setPopup] = useState<AppNotification | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // A monotonic counter guarantees unique ids even when several notifications
  // are raised inside the same millisecond, which a timestamp alone would not.
  const seq = useRef(0);
  const nextId = useCallback((prefix: string) => {
    seq.current += 1;
    return `${prefix}_${Date.now()}_${seq.current}`;
  }, []);

  // ── Persistence ────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setNotifications(parsed as AppNotification[]);
      })
      // Corrupt stored JSON must not take the app down — start from empty.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Skip the write triggered by the initial empty state, which would clobber
    // the stored feed before hydration has finished reading it.
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(notifications)).catch(() => undefined);
  }, [notifications, hydrated]);

  // ── Toasts ─────────────────────────────────────────────────────────────────

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((toastItem: Toast) => {
    // Cap the stack at three; beyond that they cover the screen and the oldest
    // is the least relevant.
    setToasts((prev) => [...prev.slice(-2), toastItem]);
  }, []);

  const toast = useCallback<NotificationContextValue['toast']>(
    (title, options) => {
      const tone = options?.tone ?? 'neutral';
      pushToast({
        id: nextId('toast'),
        title,
        body: options?.body,
        tone,
        icon: options?.icon ?? TONE_ICONS[tone],
        durationMs: options?.durationMs ?? DEFAULT_TOAST_MS,
      });
    },
    [nextId, pushToast]
  );

  // ── Feed ───────────────────────────────────────────────────────────────────

  const notify = useCallback(
    (input: NotifyInput): AppNotification => {
      const preset = NOTIFICATION_PRESETS[input.kind] ?? NOTIFICATION_PRESETS.generic;
      const entry: AppNotification = {
        id: nextId('ntf'),
        kind: input.kind,
        title: input.title,
        body: input.body,
        createdAt: Date.now(),
        read: false,
        target: input.target,
        actorName: input.actorName,
        data: input.data,
      };

      setNotifications((prev) => [entry, ...prev].slice(0, MAX_STORED));

      if (!input.silent) {
        pushToast({
          id: nextId('toast'),
          title: input.title,
          body: input.body,
          tone: preset.tone,
          icon: preset.icon,
          durationMs: DEFAULT_TOAST_MS,
        });
      }

      // The popup is a single slot. A second event while one is open would
      // replace it mid-read, so the newer one only queues into the feed.
      if (input.popup) {
        setPopup((current) => current ?? entry);
      }

      return entry;
    },
    [nextId, pushToast]
  );

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) =>
      // Returning the same array when nothing changed avoids a pointless
      // re-render and storage write on every visit to the notifications screen.
      prev.some((n) => !n.read) ? prev.map((n) => ({ ...n, read: true })) : prev
    );
  }, []);

  const remove = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);

  const dismissPopup = useCallback(() => setPopup(null), []);

  const unreadCount = useMemo(
    () => notifications.reduce((count, n) => (n.read ? count : count + 1), 0),
    [notifications]
  );

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount,
      toasts,
      popup,
      notify,
      toast,
      dismissToast,
      dismissPopup,
      markRead,
      markAllRead,
      remove,
      clearAll,
    }),
    [
      notifications,
      unreadCount,
      toasts,
      popup,
      notify,
      toast,
      dismissToast,
      dismissPopup,
      markRead,
      markAllRead,
      remove,
      clearAll,
    ]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
};

export const useNotifications = () => useContext(NotificationContext);
