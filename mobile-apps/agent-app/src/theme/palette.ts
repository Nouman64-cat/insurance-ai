/**
 * Colour palette — raw ramps plus the two semantic themes built from them.
 *
 * Screens should never import from the ramps directly. Use `useTheme().colors`,
 * which resolves to the right semantic set for the active appearance. That is
 * what makes dark mode work without a single `isDark ? ... : ...` in a screen.
 */

// ── Raw ramps ────────────────────────────────────────────────────────────────

const slate = {
  50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8',
  500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a',
  950: '#020617',
};

const blue = {
  50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa',
  500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a',
};

const emerald = {
  50: '#ecfdf5', 100: '#d1fae5', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981',
  600: '#059669', 700: '#047857',
};

const amber = {
  50: '#fffbeb', 100: '#fef3c7', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b',
  600: '#d97706', 700: '#b45309',
};

const red = {
  50: '#fef2f2', 100: '#fee2e2', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444',
  600: '#dc2626', 700: '#b91c1c',
};

const violet = {
  50: '#f5f3ff', 100: '#ede9fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6',
  600: '#7c3aed', 700: '#6d28d9',
};

const cyan = {
  50: '#ecfeff', 100: '#cffafe', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4',
  600: '#0891b2', 700: '#0e7490',
};

/**
 * A tone is a full accent treatment: the strong colour for text/icons, a soft
 * background for chips and badges, and the border that pairs with that soft fill.
 * Bundling them prevents the classic bug where a chip's text and background
 * drift out of contrast in one theme but not the other.
 */
export interface Tone {
  /** Saturated — for icons, text on a soft background, and progress fills. */
  solid: string;
  /** Text/icon colour placed on top of `soft`. Contrast-checked against it. */
  on: string;
  /** Low-saturation background for chips, badges, icon tiles. */
  soft: string;
  /** Border that pairs with `soft`. */
  softBorder: string;
  /** Text/icon colour placed on top of `solid`. */
  onSolid: string;
}

export type ToneName =
  | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

export interface ThemeColors {
  // Surfaces, back to front.
  background: string;
  /** Cards, sheets, headers — one step above the background. */
  surface: string;
  /** Nested surfaces (a row inside a card), and input fills. */
  surfaceSunken: string;
  /** Menus and popovers that float above a card. */
  surfaceElevated: string;
  /** Scrim behind modals and sheets. */
  overlay: string;

  // Text.
  text: string;
  textMuted: string;
  /** Placeholders and disabled labels. Do not use for meaningful content. */
  textSubtle: string;
  textInverse: string;

  // Lines.
  border: string;
  /** For dividers inside a card, where the full border weight is too loud. */
  borderSubtle: string;
  /** Focus rings and selected-state outlines. */
  borderStrong: string;

  // Kept flat for the most common accents so `colors.primary` still reads well.
  primary: string;
  primaryHover: string;
  danger: string;
  success: string;
  warning: string;

  /** Shadow colour — dark themes need a deeper one to be visible at all. */
  shadow: string;

  /** Full tone sets, keyed by semantic name. */
  tone: Record<ToneName, Tone>;
}

// ── Light ────────────────────────────────────────────────────────────────────

export const lightColors: ThemeColors = {
  background: slate[50],
  surface: '#ffffff',
  surfaceSunken: slate[100],
  surfaceElevated: '#ffffff',
  overlay: 'rgba(15, 23, 42, 0.45)',

  text: slate[900],
  textMuted: slate[500],
  textSubtle: slate[400],
  textInverse: '#ffffff',

  border: slate[200],
  borderSubtle: slate[100],
  borderStrong: slate[300],

  primary: blue[700],
  primaryHover: blue[800],
  danger: red[500],
  success: emerald[600],
  warning: amber[600],

  shadow: slate[900],

  tone: {
    brand:   { solid: blue[600],    on: blue[800],    soft: blue[50],    softBorder: blue[100],    onSolid: '#ffffff' },
    success: { solid: emerald[600], on: emerald[700], soft: emerald[50], softBorder: emerald[100], onSolid: '#ffffff' },
    warning: { solid: amber[500],   on: amber[700],   soft: amber[50],   softBorder: amber[100],   onSolid: '#ffffff' },
    danger:  { solid: red[500],     on: red[700],     soft: red[50],     softBorder: red[100],     onSolid: '#ffffff' },
    info:    { solid: cyan[600],    on: cyan[700],    soft: cyan[50],    softBorder: cyan[100],    onSolid: '#ffffff' },
    neutral: { solid: slate[500],   on: slate[700],   soft: slate[100],  softBorder: slate[200],   onSolid: '#ffffff' },
    accent:  { solid: violet[600],  on: violet[700],  soft: violet[50],  softBorder: violet[100],  onSolid: '#ffffff' },
  },
};

// ── Dark ─────────────────────────────────────────────────────────────────────
// Not a mechanical inversion. Dark surfaces step *up* in lightness with
// elevation (matching how light falls), soft tone fills become translucent
// tints of the solid colour, and `on` colours shift to the 300–400 band so
// they clear 4.5:1 against those tints.

export const darkColors: ThemeColors = {
  background: slate[950],
  surface: slate[900],
  surfaceSunken: '#0b1220',
  surfaceElevated: slate[800],
  overlay: 'rgba(2, 6, 23, 0.7)',

  text: slate[50],
  textMuted: slate[400],
  textSubtle: slate[500],
  textInverse: slate[900],

  border: '#1e293b',
  borderSubtle: '#172033',
  borderStrong: slate[700],

  primary: blue[400],
  primaryHover: blue[300],
  danger: red[400],
  success: emerald[400],
  warning: amber[400],

  shadow: '#000000',

  tone: {
    brand:   { solid: blue[400],    on: blue[300],    soft: 'rgba(59, 130, 246, 0.16)',  softBorder: 'rgba(59, 130, 246, 0.28)',  onSolid: slate[950] },
    success: { solid: emerald[400], on: emerald[300], soft: 'rgba(16, 185, 129, 0.16)',  softBorder: 'rgba(16, 185, 129, 0.28)',  onSolid: slate[950] },
    warning: { solid: amber[400],   on: amber[300],   soft: 'rgba(245, 158, 11, 0.16)',  softBorder: 'rgba(245, 158, 11, 0.28)',  onSolid: slate[950] },
    danger:  { solid: red[400],     on: red[300],     soft: 'rgba(239, 68, 68, 0.16)',   softBorder: 'rgba(239, 68, 68, 0.28)',   onSolid: slate[950] },
    info:    { solid: cyan[400],    on: cyan[300],    soft: 'rgba(6, 182, 212, 0.16)',   softBorder: 'rgba(6, 182, 212, 0.28)',   onSolid: slate[950] },
    neutral: { solid: slate[400],   on: slate[300],   soft: 'rgba(148, 163, 184, 0.14)', softBorder: 'rgba(148, 163, 184, 0.24)', onSolid: slate[950] },
    accent:  { solid: violet[400],  on: violet[300],  soft: 'rgba(139, 92, 246, 0.16)',  softBorder: 'rgba(139, 92, 246, 0.28)',  onSolid: slate[950] },
  },
};

// ── Domain mappings ──────────────────────────────────────────────────────────
// Business concepts map to tones in exactly one place, so a status has the same
// colour on the dashboard, the leads list, and the notification toast.

export const statusTone: Record<string, ToneName> = {
  LEAD: 'brand',
  PROSPECT: 'warning',
  UNDERWRITING_READY: 'accent',
  POLICYHOLDER: 'success',
  NOT_INTERESTED: 'neutral',
  DRAFT: 'neutral',
};

export const entityTone: Record<string, ToneName> = {
  INDIVIDUAL: 'brand',
  FAMILY: 'accent',
  CORPORATE: 'info',
};

/** Human-readable labels for the raw enum values the API returns. */
export const statusLabel: Record<string, string> = {
  LEAD: 'New Lead',
  PROSPECT: 'In Progress',
  UNDERWRITING_READY: 'Underwriting',
  POLICYHOLDER: 'Policyholder',
  NOT_INTERESTED: 'Not Interested',
  DRAFT: 'Draft',
};

export const entityLabel: Record<string, string> = {
  INDIVIDUAL: 'Individual',
  FAMILY: 'Family',
  CORPORATE: 'Corporate',
};
