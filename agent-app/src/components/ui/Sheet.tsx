import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  View,
  StyleSheet,
  Pressable as RNPressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, duration } from '../../theme/tokens';
import { useResponsive } from '../../hooks/useResponsive';
import Text from './Text';
import IconButton from './IconButton';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  /** Fraction of screen height the sheet may grow to. */
  maxHeightRatio?: number;
  /** Wraps children in a ScrollView. Turn off when the child scrolls itself. */
  scrollable?: boolean;
  /** Pinned to the bottom, outside the scroll area — for confirm/cancel rows. */
  footer?: React.ReactNode;
  /** Tapping the scrim closes by default; disable for destructive confirms. */
  dismissOnBackdropPress?: boolean;
}

/**
 * Bottom sheet — the app's primary way of presenting secondary content.
 * Sheets beat full-screen modals on mobile because they keep the originating
 * context visible behind the scrim.
 *
 * On tablets it centres as a dialog instead, where a full-width sheet would
 * span an uncomfortable distance.
 */
export default function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  maxHeightRatio = 0.85,
  scrollable = true,
  footer,
  dismissOnBackdropPress = true,
}: SheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height, isCompact } = useResponsive();

  // `Modal` unmounts its children instantly, which would kill the exit
  // animation. Keep it mounted until the animation has actually finished.
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: duration.normal,
        useNativeDriver: true,
      }).start();
    } else if (mounted) {
      Animated.timing(progress, {
        toValue: 0,
        duration: duration.fast,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, progress]);

  // Android hardware back should close the sheet, not the whole screen.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  if (!mounted) return null;

  const maxHeight = height * maxHeightRatio;
  const asDialog = !isCompact;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [asDialog ? 24 : maxHeight, 0],
  });

  const body = (
    <Animated.View
      style={[
        asDialog ? styles.dialog : styles.sheet,
        {
          backgroundColor: colors.surfaceElevated,
          maxHeight,
          paddingBottom: asDialog ? spacing.xl : Math.max(insets.bottom, spacing.xl),
          opacity: asDialog ? progress : 1,
          transform: [{ translateY }],
        },
      ]}
    >
      {!asDialog && <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />}

      {(title || subtitle) && (
        <View style={[styles.header, { borderBottomColor: colors.borderSubtle }]}>
          <View style={styles.headerText}>
            {title ? <Text variant="title2">{title}</Text> : null}
            {subtitle ? (
              <Text variant="callout" color="muted" style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <IconButton icon="close" onPress={onClose} accessibilityLabel="Close" size={20} />
        </View>
      )}

      {scrollable ? (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.content}>{children}</View>
      )}

      {footer ? (
        <View style={[styles.footer, { borderTopColor: colors.borderSubtle }]}>{footer}</View>
      ) : null}
    </Animated.View>
  );

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[styles.root, asDialog ? styles.rootCentered : styles.rootBottom]}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <RNPressable
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
            onPress={dismissOnBackdropPress ? onClose : undefined}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
        </Animated.View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={asDialog ? styles.dialogWrap : styles.sheetWrap}
          pointerEvents="box-none"
        >
          {body}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  rootBottom: {
    justifyContent: 'flex-end',
  },
  rootCentered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheetWrap: {
    width: '100%',
  },
  dialogWrap: {
    width: '100%',
    alignItems: 'center',
  },
  sheet: {
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    overflow: 'hidden',
  },
  dialog: {
    width: '92%',
    maxWidth: 520,
    borderRadius: radii.xl,
    overflow: 'hidden',
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
  },
  headerText: {
    flex: 1,
  },
  subtitle: {
    marginTop: spacing.xxs,
  },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
  },
});
