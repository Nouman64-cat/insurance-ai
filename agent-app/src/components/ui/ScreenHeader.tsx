import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, DrawerActions } from '@react-navigation/native';
import { useTheme } from '../../theme/ThemeContext';
import { spacing, layout } from '../../theme/tokens';
import { useResponsive } from '../../hooks/useResponsive';
import Text from './Text';
import IconButton from './IconButton';

export interface HeaderAction {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  accessibilityLabel: string;
  badgeCount?: number;
  tone?: 'neutral' | 'brand' | 'danger';
}

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  /**
   * Leading affordance. `auto` picks `back` when the navigator can go back and
   * `menu` at the root of a drawer screen — which is the behaviour users
   * expect and the reason a screen should rarely set this explicitly.
   */
  leading?: 'auto' | 'back' | 'menu' | 'close' | 'none';
  /** Overrides the default pop/openDrawer behaviour. */
  onLeadingPress?: () => void;
  actions?: HeaderAction[];
  /** Rendered under the title row — filter chips, a search bar, tabs. */
  children?: React.ReactNode;
  /** Drops the bottom hairline, for headers that sit flush on a scroll view. */
  borderless?: boolean;
  style?: StyleProp<ViewStyle>;
}

const LEADING_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  // Platform-correct chevron: iOS users expect `chevron-back`, Android `arrow-back`.
  back: Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back',
  menu: 'menu',
  close: 'close',
};

/**
 * The single header used by every screen. Consolidating it here is what makes
 * back navigation behave consistently — screens no longer each hand-roll a
 * title row and forget the back button.
 */
export default function ScreenHeader({
  title,
  subtitle,
  leading = 'auto',
  onLeadingPress,
  actions = [],
  children,
  borderless = false,
  style,
}: ScreenHeaderProps) {
  const { colors } = useTheme();
  const { gutter } = useResponsive();
  const navigation = useNavigation();

  const canGoBack = navigation.canGoBack();
  const resolved = leading === 'auto' ? (canGoBack ? 'back' : 'menu') : leading;

  const handleLeadingPress = () => {
    if (onLeadingPress) return onLeadingPress();
    if (resolved === 'menu') return navigation.dispatch(DrawerActions.openDrawer());
    if (canGoBack) navigation.goBack();
  };

  const leadingLabel =
    resolved === 'menu' ? 'Open menu' : resolved === 'close' ? 'Close' : 'Go back';

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingHorizontal: gutter,
          borderBottomWidth: borderless ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        style,
      ]}
    >
      <View style={styles.row}>
        {resolved !== 'none' ? (
          <IconButton
            icon={LEADING_ICON[resolved]}
            onPress={handleLeadingPress}
            accessibilityLabel={leadingLabel}
            size={24}
            // Pull the glyph back to the gutter — icon buttons carry padding
            // that would otherwise make the header look inset by too much.
            style={styles.leading}
          />
        ) : null}

        <View style={styles.titleBlock}>
          <Text variant="title1" numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" color="muted" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {actions.length > 0 ? (
          <View style={styles.actions}>
            {actions.map((action) => (
              <IconButton
                key={action.accessibilityLabel}
                icon={action.icon}
                onPress={action.onPress}
                accessibilityLabel={action.accessibilityLabel}
                badgeCount={action.badgeCount}
                tone={action.tone ?? 'neutral'}
                size={22}
              />
            ))}
          </View>
        ) : null}
      </View>

      {children ? <View style={styles.slot}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: layout.headerHeight,
  },
  leading: {
    marginLeft: -spacing.md,
  },
  titleBlock: {
    flex: 1,
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    // Same rationale as `leading`, mirrored to the trailing edge.
    marginRight: -spacing.md,
  },
  slot: {
    marginTop: spacing.md,
  },
});
