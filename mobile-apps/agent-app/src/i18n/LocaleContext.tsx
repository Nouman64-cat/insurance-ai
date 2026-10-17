import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DevSettings, I18nManager } from 'react-native';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, Locale, isLocale } from './config';
import en from './messages/en';
import ur from './messages/ur';

const MESSAGES = { en, ur };

type Vars = Record<string, string | number>;

interface LocaleContextProps {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /**
   * True once the language was switched to one with the other reading direction. React Native only flips the
   * layout (RTL for Urdu) when the app starts, so the app must be restarted; in development it reloads itself.
   */
  restartRequired: boolean;
  /** Text for a dotted key ('settings.title'), with {name} placeholders filled from `vars`. Falls back to English. */
  t: (key: string, vars?: Vars) => string;
}

function lookup(messages: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), messages);
  return typeof value === 'string' ? value : undefined;
}

function translate(locale: Locale, key: string, vars?: Vars): string {
  const text = lookup(MESSAGES[locale], key) ?? lookup(en, key) ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
}

const LocaleContext = createContext<LocaleContextProps>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  restartRequired: false,
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
});

/** Ask React Native for the direction `locale` needs. Returns true when that differs from the running layout. */
function applyDirection(locale: Locale): boolean {
  const rtl = locale === 'ur';
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  return I18nManager.isRTL !== rtl;
}

export const LocaleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [restartRequired, setRestartRequired] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(LOCALE_STORAGE_KEY)
      .then((saved) => {
        if (cancelled || !isLocale(saved)) return;
        setLocaleState(saved);
        // Keeps the stored direction for the next launch even if the last switch was never followed by a restart.
        applyDirection(saved);
      })
      // A failed read is not worth blocking launch over — fall back to English.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    AsyncStorage.setItem(LOCALE_STORAGE_KEY, next)
      .catch(() => undefined)
      .finally(() => {
        if (!applyDirection(next)) return;
        if (__DEV__) DevSettings.reload();
        else setRestartRequired(true);
      });
  }, []);

  const value = useMemo<LocaleContextProps>(
    () => ({ locale, setLocale, restartRequired, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale, restartRequired],
  );

  // Rendering in English and switching a frame later would flash, so hold the tree until the stored choice is known.
  if (!isReady) return null;

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};

export const useLocale = () => useContext(LocaleContext);
