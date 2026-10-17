import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';
import { lightColors, darkColors, ThemeColors as PaletteColors } from './palette';
import { elevation, ElevationStyle } from './tokens';

export type ThemeType = 'light' | 'dark' | 'system';

/**
 * What screens actually consume. Extends the palette with `card`, an alias for
 * `surface` kept so existing screens keep compiling while they migrate.
 */
export interface ThemeColors extends PaletteColors {
  /** @deprecated Use `surface`. Retained for backwards compatibility. */
  card: string;
}

const STORAGE_KEY = 'app_theme';

interface ThemeContextProps {
  theme: ThemeType;
  isDark: boolean;
  colors: ThemeColors;
  setTheme: (theme: ThemeType) => void;
  /**
   * Theme-aware elevation. Always use this rather than `elevation()` directly —
   * it injects the right shadow colour, without which cards are invisible in
   * dark mode.
   */
  shadow: (level: 0 | 1 | 2 | 3 | 4) => ElevationStyle;
}

const withAliases = (palette: PaletteColors): ThemeColors => ({
  ...palette,
  card: palette.surface,
});

const ThemeContext = createContext<ThemeContextProps>({
  theme: 'system',
  isDark: false,
  colors: withAliases(lightColors),
  setTheme: () => {},
  shadow: (level) => elevation(level, lightColors.shadow),
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const systemColorScheme = useColorScheme();
  const [theme, setThemeState] = useState<ThemeType>('system');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (cancelled) return;
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setThemeState(saved);
        }
      })
      // A failed read is not worth blocking launch over — fall back to system.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((next: ThemeType) => {
    setThemeState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const isDark = theme === 'dark' || (theme === 'system' && systemColorScheme === 'dark');

  const value = useMemo<ThemeContextProps>(() => {
    const palette = isDark ? darkColors : lightColors;
    const colors = withAliases(palette);
    return {
      theme,
      isDark,
      colors,
      setTheme,
      shadow: (level: 0 | 1 | 2 | 3 | 4) => elevation(level, palette.shadow),
    };
  }, [theme, isDark, setTheme]);

  // Rendering with the wrong theme and correcting it a frame later produces a
  // visible flash, so hold the tree until the stored preference is known.
  if (!isReady) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

export { spacing, radii, typography, duration, layout, hitSlop, hitTarget } from './tokens';
export type { ToneName, Tone } from './palette';
