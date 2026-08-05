import React from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  ViewStyle,
  StyleProp,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  ScrollViewProps,
} from 'react-native';
import { SafeAreaView, Edge } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeContext';
import { spacing, layout } from '../../theme/tokens';
import { useResponsive } from '../../hooks/useResponsive';

export interface ScreenProps {
  children?: React.ReactNode;
  /** Rendered outside the scroll area, above it — normally a `ScreenHeader`. */
  header?: React.ReactNode;
  /** Pinned above the tab bar — a submit button row, for example. */
  footer?: React.ReactNode;
  /**
   * Wraps children in a ScrollView. Turn off when the screen owns a FlatList,
   * since nesting a virtualised list inside a ScrollView breaks recycling.
   */
  scrollable?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Applies the responsive gutter to the content. */
  padded?: boolean;
  /** Extra bottom padding so a floating action button never covers content. */
  fabClearance?: boolean;
  /** Lifts content above the keyboard. Enable on any screen with inputs. */
  keyboardAvoiding?: boolean;
  edges?: Edge[];
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  scrollViewProps?: Partial<ScrollViewProps>;
}

/**
 * Screen scaffold: safe-area insets, themed background, responsive gutters and
 * a capped content column on tablets. Every screen renders through this so
 * padding and safe areas stop being re-derived per screen.
 */
export default function Screen({
  children,
  header,
  footer,
  scrollable = true,
  refreshing,
  onRefresh,
  padded = true,
  fabClearance = false,
  keyboardAvoiding = false,
  // The header supplies its own top padding, and the tab bar handles the
  // bottom, so only the top edge is claimed by default.
  edges = ['top'],
  contentContainerStyle,
  style,
  scrollViewProps,
}: ScreenProps) {
  const { colors } = useTheme();
  const { gutter, isCompact } = useResponsive();

  const contentStyle: StyleProp<ViewStyle> = [
    padded ? { paddingHorizontal: gutter } : null,
    // On tablets, cap and centre the column instead of stretching text lines.
    !isCompact ? styles.capped : null,
    fabClearance ? { paddingBottom: layout.fabClearance } : { paddingBottom: spacing.xxl },
    contentContainerStyle,
  ];

  const body = scrollable ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.grow, contentStyle]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={!!refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        ) : undefined
      }
      {...scrollViewProps}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, contentStyle]}>{children}</View>
  );

  const inner = (
    <>
      {header}
      {body}
      {footer ? (
        <View
          style={[
            styles.footer,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              paddingHorizontal: gutter,
            },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </>
  );

  return (
    <SafeAreaView
      style={[styles.flex, { backgroundColor: colors.background }, style]}
      edges={edges}
    >
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {inner}
        </KeyboardAvoidingView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  grow: {
    flexGrow: 1,
  },
  capped: {
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.screenPaddingWide * 2,
    alignSelf: 'center',
  },
  footer: {
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
