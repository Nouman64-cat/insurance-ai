import { useWindowDimensions } from 'react-native';
import { layout, spacing } from '../theme/tokens';

export type Breakpoint = 'compact' | 'medium' | 'expanded';

/**
 * Breakpoints follow Material 3's window size classes, which map cleanly onto
 * the real device split: phones portrait, phones landscape / small tablets,
 * tablets landscape.
 */
const COMPACT_MAX = 600;
const MEDIUM_MAX = 840;

export interface Responsive {
  width: number;
  height: number;
  breakpoint: Breakpoint;
  /** Phone in portrait — the design baseline. */
  isCompact: boolean;
  /** Tablet or landscape phone; enough room for two columns. */
  isMedium: boolean;
  /** Large tablet; enough room for three columns and wider gutters. */
  isExpanded: boolean;
  isLandscape: boolean;
  /** Horizontal screen padding, widened on larger windows. */
  gutter: number;
  /**
   * Column count for a card grid. Pass the minimum comfortable card width;
   * returns how many fit inside the content area.
   */
  columns: (minCardWidth?: number) => number;
  /** Content width, capped so text lines stay scannable on tablets. */
  contentWidth: number;
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();

  const breakpoint: Breakpoint =
    width < COMPACT_MAX ? 'compact' : width < MEDIUM_MAX ? 'medium' : 'expanded';

  const gutter = breakpoint === 'compact' ? layout.screenPadding : layout.screenPaddingWide;
  const contentWidth = Math.min(width - gutter * 2, layout.maxContentWidth);

  const columns = (minCardWidth = 260) => {
    const available = Math.min(width - gutter * 2, layout.maxContentWidth);
    // +gap accounts for the space between columns when solving for fit.
    const fit = Math.floor((available + spacing.md) / (minCardWidth + spacing.md));
    return Math.max(1, fit);
  };

  return {
    width,
    height,
    breakpoint,
    isCompact: breakpoint === 'compact',
    isMedium: breakpoint === 'medium',
    isExpanded: breakpoint === 'expanded',
    isLandscape: width > height,
    gutter,
    columns,
    contentWidth,
  };
}
