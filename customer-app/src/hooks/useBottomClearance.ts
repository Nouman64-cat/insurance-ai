import { useContext } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { spacing } from '../theme/tokens';

/** Height of the extended (labelled) FAB, from `components/ui/Fab`. */
const FAB_HEIGHT = 52;

export interface BottomClearance {
  /** Height of the bottom tab bar, or 0 on screens without one. */
  tabBarHeight: number;
  /** Padding that clears the tab bar only — for lists with no FAB. */
  listPadding: number;
  /** Padding that clears the tab bar *and* a floating action button. */
  fabPadding: number;
}

/**
 * Bottom spacing derived from the actual chrome on screen, rather than the
 * hardcoded magic numbers that leave the last list row stuck under a tab bar on
 * some devices and floating in dead space on others.
 *
 * Safe on screens with no tab bar: the context is undefined there, and the
 * safe-area inset takes over.
 */
export function useBottomClearance(): BottomClearance {
  const insets = useSafeAreaInsets();
  // The hook form of this throws outside a tab navigator; the context does not.
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;

  // React Navigation's default tab bar does not overlay the screen content;
  // it sits below it. Therefore, if we are inside a tab navigator, we do NOT
  // need to clear the tab bar height. We only need the safe area inset on screens
  // without a tab bar.
  const base = tabBarHeight > 0 ? 0 : insets.bottom;

  return {
    tabBarHeight,
    listPadding: base + spacing.xl,
    fabPadding: base + FAB_HEIGHT + spacing.xxl,
  };
}
