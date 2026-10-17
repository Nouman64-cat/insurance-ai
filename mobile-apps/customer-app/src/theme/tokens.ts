/**
 * Design tokens — the single source of truth for every non-colour visual
 * decision in the app. Screens must never hardcode a spacing/radius/font size;
 * pull it from here so the whole product stays on one rhythm.
 *
 * Scale is a 4pt grid. Type scale is a modular ~1.2 ratio anchored at 15pt body,
 * which is the comfortable reading size on a phone held at arm's length.
 */

import { Platform, TextStyle } from 'react-native';

// ── Spacing ──────────────────────────────────────────────────────────────────
// Named by t-shirt size rather than raw number so intent survives refactors.

export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 56,
} as const;

export type SpacingKey = keyof typeof spacing;

// ── Radii ────────────────────────────────────────────────────────────────────

export const radii = {
  none: 0,
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

export type RadiusKey = keyof typeof radii;

// ── Typography ───────────────────────────────────────────────────────────────
// `fontWeight` is typed as TextStyle['fontWeight'] so these objects can be
// spread straight into a style without a cast.

interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: TextStyle['fontWeight'];
  letterSpacing?: number;
}

export const typography = {
  /** Screen titles — one per screen, never repeated. */
  display: { fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.6 },
  title1: { fontSize: 24, lineHeight: 30, fontWeight: '800', letterSpacing: -0.4 },
  title2: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.2 },
  title3: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  /** Default body copy. */
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  callout: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  calloutStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  captionStrong: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
  /** All-caps section eyebrows. Pair with textTransform: 'uppercase'. */
  overline: { fontSize: 10, lineHeight: 13, fontWeight: '800', letterSpacing: 0.8 },
} as const satisfies Record<string, TypeStyle>;

export type TypographyKey = keyof typeof typography;

// ── Elevation ────────────────────────────────────────────────────────────────
// iOS shadows and Android elevation diverge badly; these presets keep a card
// looking like the same card on both. Shadow colour is injected by the theme
// (dark mode needs a near-black shadow at higher opacity to read at all).

export interface ElevationStyle {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

export const elevation = (level: 0 | 1 | 2 | 3 | 4, shadowColor = '#0f172a'): ElevationStyle => {
  const presets: Record<number, Omit<ElevationStyle, 'shadowColor'>> = {
    0: { shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0, shadowRadius: 0, elevation: 0 },
    // A tight, slightly stronger shadow reads as a crisp edge; the very soft
    // large-radius version it replaced made cards look like flat grey blocks
    // against the app background.
    1: { shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.09, shadowRadius: 2, elevation: 2 },
    2: { shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 4 },
    3: { shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.16, shadowRadius: 14, elevation: 10 },
    4: { shadowOffset: { width: 0, height: 18 }, shadowOpacity: 0.2, shadowRadius: 24, elevation: 18 },
  };
  return { shadowColor, ...presets[level] };
};

// ── Motion ───────────────────────────────────────────────────────────────────

export const duration = {
  /** Micro-feedback: press states, checkbox ticks. */
  instant: 120,
  /** Standard enter/exit for in-place elements. */
  fast: 200,
  /** Sheets, toasts, anything travelling a visible distance. */
  normal: 280,
  slow: 420,
} as const;

// ── Hit targets ──────────────────────────────────────────────────────────────
// 44pt is the Apple HIG minimum and Material's 48dp rounds to the same intent.

export const hitTarget = {
  min: 44,
  comfortable: 48,
} as const;

/** Expands a small icon's touch area to `hitTarget.min` without changing layout. */
export const hitSlop = (visualSize: number) => {
  const pad = Math.max(0, (hitTarget.min - visualSize) / 2);
  return { top: pad, bottom: pad, left: pad, right: pad };
};

// ── Layout ───────────────────────────────────────────────────────────────────

export const layout = {
  /** Content never stretches past this on tablets — long lines hurt scanning. */
  maxContentWidth: 720,
  screenPadding: spacing.lg,
  screenPaddingWide: spacing.xxl,
  /** Bottom padding on scroll views so a FAB never covers the last row. */
  fabClearance: 96,
  headerHeight: 56,
  tabBarHeight: Platform.select({ ios: 84, default: 64 }) as number,
} as const;
