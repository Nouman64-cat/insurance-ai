import React, { useMemo, useState } from 'react';
import { View, StyleSheet, ViewStyle, StyleProp, FlatList, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import { radii, spacing, typography, hitTarget } from '../../theme/tokens';
import Text from './Text';
import Pressable from './Pressable';
import Sheet from './Sheet';
import EmptyState from './EmptyState';

export interface SelectOption {
  label: string;
  value: string;
  /** Secondary line under the label — plan details, agent email, and so on. */
  description?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
}

export interface SelectProps {
  label?: string;
  value: string | null | undefined;
  options: SelectOption[];
  onSelect: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helperText?: string;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  /** Shows a filter box in the sheet. Auto-enables past 8 options. */
  searchable?: boolean;
  /** Adds a "Clear selection" row so an optional field can be unset. */
  clearable?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Picker backed by a bottom sheet rather than a dropdown. On mobile a sheet
 * gives every option a full-width tap target and room for a description line,
 * which a native dropdown cannot.
 */
export default function Select({
  label,
  value,
  options,
  onSelect,
  placeholder = 'Select…',
  required,
  disabled,
  error,
  helperText,
  leftIcon,
  searchable,
  clearable,
  style,
}: SelectProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = options.find((o) => o.value === value);
  const showSearch = searchable ?? options.length > 8;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q)
    );
  }, [options, query]);

  const close = () => {
    setOpen(false);
    // Reset the filter so the next open starts from the full list.
    setQuery('');
  };

  return (
    <View style={[styles.container, style]}>
      {label ? (
        <Text variant="captionStrong" color="muted" style={styles.label}>
          {label}
          {required ? <Text style={{ color: colors.tone.danger.solid }}> *</Text> : null}
        </Text>
      ) : null}

      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${selected?.label ?? placeholder}` : placeholder}
        accessibilityState={{ disabled: !!disabled, expanded: open }}
        pressedScale={0.99}
        style={[
          styles.trigger,
          {
            backgroundColor: disabled ? colors.surfaceSunken : colors.surface,
            borderColor: error ? colors.tone.danger.solid : colors.border,
            borderWidth: error ? 2 : 1,
          },
          disabled ? styles.disabled : null,
        ]}
      >
        {leftIcon ? <Ionicons name={leftIcon} size={18} color={colors.textSubtle} /> : null}
        <Text
          variant="body"
          numberOfLines={1}
          style={[styles.triggerText, { color: selected ? colors.text : colors.textSubtle }]}
        >
          {selected?.label ?? placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </Pressable>

      {error ? (
        <View style={styles.messageRow}>
          <Ionicons name="alert-circle" size={13} color={colors.tone.danger.solid} />
          <Text variant="caption" style={{ color: colors.tone.danger.on, flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : helperText ? (
        <Text variant="caption" color="subtle" style={styles.helper}>
          {helperText}
        </Text>
      ) : null}

      <Sheet visible={open} onClose={close} title={label ?? 'Select an option'} scrollable={false}>
        {showSearch ? (
          <View
            style={[
              styles.search,
              { backgroundColor: colors.surfaceSunken, borderColor: colors.border },
            ]}
          >
            <Ionicons name="search" size={18} color={colors.textSubtle} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search…"
              placeholderTextColor={colors.textSubtle}
              style={[styles.searchInput, typography.body, { color: colors.text }]}
              autoCorrect={false}
              accessibilityLabel="Filter options"
            />
            {query.length > 0 ? (
              <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear search" pressedScale={0.9}>
                <Ionicons name="close-circle" size={18} color={colors.textSubtle} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <FlatList
          data={filtered}
          keyExtractor={(item) => item.value}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: colors.borderSubtle }]} />
          )}
          ListHeaderComponent={
            clearable && value ? (
              <Pressable
                onPress={() => {
                  onSelect('');
                  close();
                }}
                style={styles.option}
                accessibilityRole="button"
                accessibilityLabel="Clear selection"
              >
                <Ionicons name="close-circle-outline" size={20} color={colors.textMuted} />
                <Text variant="body" color="muted" style={styles.optionLabel}>
                  Clear selection
                </Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              compact
              icon="search-outline"
              title="No matches"
              description={query ? `Nothing matches "${query}".` : 'There are no options to choose from yet.'}
            />
          }
          renderItem={({ item }) => {
            const active = item.value === value;
            return (
              <Pressable
                onPress={() => {
                  if (item.disabled) return;
                  onSelect(item.value);
                  close();
                }}
                disabled={item.disabled}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: !!item.disabled }}
                accessibilityLabel={item.label}
                pressedScale={0.99}
                style={[
                  styles.option,
                  active ? { backgroundColor: colors.tone.brand.soft } : null,
                  item.disabled ? styles.disabled : null,
                ]}
              >
                {item.icon ? (
                  <Ionicons
                    name={item.icon}
                    size={20}
                    color={active ? colors.tone.brand.on : colors.textMuted}
                  />
                ) : null}
                <View style={styles.optionLabel}>
                  <Text
                    variant={active ? 'bodyStrong' : 'body'}
                    style={active ? { color: colors.tone.brand.on } : undefined}
                  >
                    {item.label}
                  </Text>
                  {item.description ? (
                    <Text variant="caption" color="muted" style={styles.optionDescription}>
                      {item.description}
                    </Text>
                  ) : null}
                </View>
                {active ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.tone.brand.solid} />
                ) : null}
              </Pressable>
            );
          }}
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: hitTarget.comfortable,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  triggerText: {
    flex: 1,
  },
  disabled: {
    opacity: 0.6,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  helper: {
    marginTop: spacing.xs,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: hitTarget.comfortable,
    borderRadius: radii.md,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  searchInput: {
    flex: 1,
    padding: 0,
  },
  list: {
    // Keeps a long option list from pushing the sheet past its max height.
    maxHeight: 420,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
  },
  optionLabel: {
    flex: 1,
  },
  optionDescription: {
    marginTop: spacing.xxs,
  },
  separator: {
    height: 1,
    marginHorizontal: spacing.md,
  },
});
