import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  LayoutChangeEvent,
  ViewStyle,
  StyleProp,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii, duration } from '../theme/tokens';
import { ToneName } from '../theme/palette';
import { Text, Pressable, Badge } from './ui';

interface AccordionProps {
  title: string;
  /** Secondary line under the title — good for "3 of 8 completed". */
  subtitle?: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: ToneName;
  /** Small count/status pill on the right of the header. */
  badge?: string;
  badgeTone?: ToneName;
  style?: StyleProp<ViewStyle>;
}

/**
 * Collapsible section, used to keep the long underwriting forms navigable.
 *
 * The body is animated by interpolating a measured height rather than by
 * `LayoutAnimation`: that API needs `setLayoutAnimationEnabledExperimental` on
 * old-architecture Android, and on the New Architecture that setter is a no-op
 * that logs a warning on every import. Measuring and driving the height works
 * identically on both, and lets the chevron and body share one timing curve.
 */
export default function Accordion({
  title,
  subtitle,
  children,
  defaultExpanded = false,
  icon,
  tone = 'neutral',
  badge,
  badgeTone = 'neutral',
  style,
}: AccordionProps) {
  const { colors, shadow } = useTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [contentHeight, setContentHeight] = useState(0);

  const progress = useRef(new Animated.Value(defaultExpanded ? 1 : 0)).current;
  // Height cannot be driven natively, so the two run on separate values: the
  // body on the JS thread, the chevron natively.
  const rotation = useRef(new Animated.Value(defaultExpanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(progress, {
        toValue: expanded ? 1 : 0,
        duration: duration.fast,
        useNativeDriver: false,
      }),
      Animated.timing(rotation, {
        toValue: expanded ? 1 : 0,
        duration: duration.fast,
        useNativeDriver: true,
      }),
    ]).start();
  }, [expanded, progress, rotation]);

  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    // Re-measure on every layout so a field appearing inside the body (a
    // conditional input, a validation message) grows the container with it.
    setContentHeight((current) => (Math.abs(current - measured) > 1 ? measured : current));
  }, []);

  const t = colors.tone[tone];

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, borderColor: colors.border },
        shadow(1),
        style,
      ]}
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        pressedScale={0.995}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={title}
        accessibilityHint={expanded ? 'Collapses this section' : 'Expands this section'}
        style={styles.header}
      >
        {icon ? (
          <View style={[styles.iconWrap, { backgroundColor: t.soft, borderColor: t.softBorder }]}>
            <Ionicons name={icon} size={17} color={t.on} />
          </View>
        ) : null}

        <View style={styles.headerText}>
          <Text variant="title3" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" color="muted" numberOfLines={1} style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {badge ? <Badge label={badge} tone={badgeTone} variant="soft" /> : null}

        <Animated.View
          style={{
            transform: [
              {
                rotate: rotation.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', '180deg'],
                }),
              },
            ],
          }}
        >
          <Ionicons name="chevron-down" size={20} color={colors.textMuted} />
        </Animated.View>
      </Pressable>

      <Animated.View
        style={[
          styles.bodyClip,
          {
            // Before the first measurement the height is unknown; falling back
            // to `auto` when expanded avoids a collapsed first paint.
            height:
              contentHeight === 0 && expanded
                ? undefined
                : progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, contentHeight],
                  }),
            opacity: progress,
          },
        ]}
      >
        {/* Absolutely positioned so measuring it never fights the animated
            height of the clipping parent. */}
        <View
          style={contentHeight === 0 && expanded ? undefined : styles.bodyMeasure}
          onLayout={onContentLayout}
        >
          <View style={[styles.content, { borderTopColor: colors.borderSubtle }]}>{children}</View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
  },
  subtitle: {
    marginTop: spacing.xxs,
  },
  bodyClip: {
    overflow: 'hidden',
  },
  bodyMeasure: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
