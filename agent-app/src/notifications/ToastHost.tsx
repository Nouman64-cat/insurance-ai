import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, PanResponder, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { radii, spacing, duration } from '../theme/tokens';
import { useResponsive } from '../hooks/useResponsive';
import { Toast } from './types';
import { useNotifications } from './NotificationContext';
import Text from '../components/ui/Text';
import Pressable from '../components/ui/Pressable';

/**
 * Renders above every screen — mount once, at the root of the navigation tree.
 * Toasts drop from the top rather than rising from the bottom so they never
 * collide with the tab bar or a FAB.
 */
export default function ToastHost() {
  const { toasts } = useNotifications();
  const insets = useSafeAreaInsets();

  if (toasts.length === 0) return null;

  return (
    <View
      style={[styles.host, { paddingTop: insets.top + spacing.sm }]}
      // The wrapper must not swallow taps meant for the screen underneath;
      // only the toast cards themselves are interactive.
      pointerEvents="box-none"
    >
      {toasts.map((toast, index) => (
        <ToastCard key={toast.id} toast={toast} index={index} />
      ))}
    </View>
  );
}

function ToastCard({ toast, index }: { toast: Toast; index: number }) {
  const { colors, shadow } = useTheme();
  const { dismissToast } = useNotifications();
  const { isCompact } = useResponsive();
  const t = colors.tone[toast.tone];

  const translateY = useRef(new Animated.Value(-120)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  // Held in a ref so the pan handlers and the auto-dismiss timer can't both
  // run the exit animation and double-remove the toast.
  const dismissed = useRef(false);

  const dismiss = useRef((direction: 'up' | 'left' | 'right' = 'up') => {
    if (dismissed.current) return;
    dismissed.current = true;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: duration.fast, useNativeDriver: true }),
      direction === 'up'
        ? Animated.timing(translateY, { toValue: -120, duration: duration.fast, useNativeDriver: true })
        : Animated.timing(translateX, {
            toValue: direction === 'left' ? -400 : 400,
            duration: duration.fast,
            useNativeDriver: true,
          }),
    ]).start(() => dismissToast(toast.id));
  }).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        speed: 14,
        bounciness: 6,
      }),
      Animated.timing(opacity, { toValue: 1, duration: duration.fast, useNativeDriver: true }),
    ]).start();

    if (toast.durationMs <= 0) return;
    const timer = setTimeout(() => dismiss('up'), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast.durationMs, dismiss, translateY, opacity]);

  // Swipe to dismiss — horizontally, matching the platform convention for
  // dismissible banners. Vertical drags are left to the screen beneath.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => translateX.setValue(g.dx),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 80) {
          dismiss(g.dx < 0 ? 'left' : 'right');
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, speed: 20 }).start();
        }
      },
    })
  ).current;

  const handlePress = () => {
    toast.onPress?.();
    dismiss('up');
  };

  return (
    <Animated.View
      {...pan.panHandlers}
      style={[
        styles.cardWrap,
        !isCompact ? styles.cardWrapWide : null,
        {
          opacity,
          transform: [{ translateY }, { translateX }],
          // Stacked toasts step back slightly so the newest reads as on top.
          zIndex: 100 - index,
        },
      ]}
    >
      <Pressable
        onPress={handlePress}
        pressedScale={0.985}
        accessibilityRole="button"
        accessibilityLabel={`${toast.title}. ${toast.body ?? ''}`}
        style={[
          styles.card,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          shadow(3),
        ]}
      >
        <View style={[styles.iconWrap, { backgroundColor: t.soft, borderColor: t.softBorder }]}>
          <Ionicons name={toast.icon} size={19} color={t.on} />
        </View>

        <View style={styles.body}>
          <Text variant="calloutStrong" numberOfLines={1}>
            {toast.title}
          </Text>
          {toast.body ? (
            <Text variant="caption" color="muted" numberOfLines={2} style={styles.bodyText}>
              {toast.body}
            </Text>
          ) : null}
          {toast.actionLabel ? (
            <Text variant="captionStrong" style={[styles.action, { color: t.solid }]}>
              {toast.actionLabel}
            </Text>
          ) : null}
        </View>

        <Pressable
          onPress={() => dismiss('up')}
          pressedScale={0.88}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          style={styles.close}
        >
          <Ionicons name="close" size={16} color={colors.textSubtle} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    // Toasts must sit above modals raised by screens beneath them.
    zIndex: 9999,
    elevation: Platform.OS === 'android' ? 24 : 0,
  },
  cardWrap: {
    width: '100%',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  cardWrapWide: {
    maxWidth: 460,
    alignSelf: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    paddingTop: spacing.xxs,
  },
  bodyText: {
    marginTop: 1,
  },
  action: {
    marginTop: spacing.xs,
  },
  close: {
    padding: spacing.xs,
  },
});
