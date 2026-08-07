import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing, Dimensions } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import { spacing, radii } from '../../theme/tokens';
import Text from './Text';

const { width } = Dimensions.get('window');

interface AnimatedSplashScreenProps {
  onFinish?: () => void;
  subtitle?: string;
}

export default function AnimatedSplashScreen({
  onFinish,
  subtitle = 'Agent Portal',
}: AnimatedSplashScreenProps) {
  const { colors } = useTheme();

  // Animation values
  const textScale = useRef(new Animated.Value(0.6)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textTranslateY = useRef(new Animated.Value(15)).current;
  const glowScale = useRef(new Animated.Value(0.7)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const progressWidth = useRef(new Animated.Value(0)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // 1. Entrance sequence
    Animated.parallel([
      // Text scale with spring physics
      Animated.spring(textScale, {
        toValue: 1,
        friction: 7,
        tension: 40,
        useNativeDriver: true,
      }),
      // Text slide & fade in
      Animated.parallel([
        Animated.timing(textTranslateY, {
          toValue: 0,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 450,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      // Glow pulse ring behind text
      Animated.parallel([
        Animated.timing(glowScale, {
          toValue: 1.4,
          duration: 1000,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(glowOpacity, {
            toValue: 0.25,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(glowOpacity, {
            toValue: 0.1,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      ]),
      // Progress bar fill
      Animated.timing(progressWidth, {
        toValue: 1,
        duration: 1300,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: false,
      }),
    ]).start();

    // 2. Smooth exit transition to Dashboard after 1500ms
    const timer = setTimeout(() => {
      Animated.timing(screenOpacity, {
        toValue: 0,
        duration: 350,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(() => {
        if (onFinish) {
          onFinish();
        }
      });
    }, 1500);

    return () => clearTimeout(timer);
  }, [
    textScale,
    textTranslateY,
    textOpacity,
    glowScale,
    glowOpacity,
    progressWidth,
    screenOpacity,
    onFinish,
  ]);

  const barWidth = progressWidth.interpolate({
    inputRange: [0, 1],
    outputRange: [0, width * 0.5],
  });

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          opacity: screenOpacity,
        },
      ]}
      pointerEvents="none"
    >
      <View style={styles.centerContent}>
        {/* Soft background ambient glow */}
        <Animated.View
          style={[
            styles.glowRing,
            {
              backgroundColor: colors.tone.brand.solid,
              opacity: glowOpacity,
              transform: [{ scale: glowScale }],
            },
          ]}
        />

        {/* Pure Typography Title */}
        <Animated.View
          style={{
            alignItems: 'center',
            opacity: textOpacity,
            transform: [{ scale: textScale }, { translateY: textTranslateY }],
          }}
        >
          <Text style={[styles.brandTitle, { color: colors.text }]}>
            RIZVIZ
          </Text>
          <Text variant="callout" color="muted" align="center" style={styles.subtitleText}>
            {subtitle}
          </Text>
        </Animated.View>

        {/* Animated Accent Line */}
        <View style={[styles.progressTrack, { backgroundColor: colors.surfaceSunken }]}>
          <Animated.View
            style={[
              styles.progressBar,
              {
                backgroundColor: colors.tone.brand.solid,
                width: barWidth,
              },
            ]}
          />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowRing: {
    position: 'absolute',
    width: 220,
    height: 120,
    borderRadius: 60,
  },
  brandTitle: {
    fontSize: 42,
    lineHeight: 48,
    fontWeight: '900',
    letterSpacing: 6,
    textAlign: 'center',
  },
  subtitleText: {
    letterSpacing: 3,
    textTransform: 'uppercase',
    fontSize: 12,
    marginTop: spacing.xs,
    fontWeight: '600',
  },
  progressTrack: {
    height: 3,
    width: width * 0.5,
    borderRadius: radii.pill,
    marginTop: spacing.xxl,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: radii.pill,
  },
});
