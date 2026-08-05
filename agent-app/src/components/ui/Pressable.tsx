import React, { useRef } from 'react';
import {
  Animated,
  Pressable as RNPressable,
  PressableProps as RNPressableProps,
  ViewStyle,
  StyleProp,
  Platform,
} from 'react-native';
import { duration } from '../../theme/tokens';

export interface PressableProps extends Omit<RNPressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** How far the element shrinks while held. 1 disables the effect. */
  pressedScale?: number;
  /** Opacity while held, applied alongside the scale. */
  pressedOpacity?: number;
  children?: React.ReactNode;
}

/**
 * Pressable with the spring-in/spring-out response native apps have and RN's
 * `TouchableOpacity` does not. Uses the native driver so the animation stays
 * at 60fps even while the JS thread is busy fetching.
 */
export default function Pressable({
  style,
  pressedScale = 0.97,
  pressedOpacity = 0.9,
  onPressIn,
  onPressOut,
  disabled,
  android_ripple,
  children,
  ...props
}: PressableProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const animateTo = (toScale: number, toOpacity: number, springy: boolean) => {
    Animated.parallel([
      springy
        ? Animated.spring(scale, {
            toValue: toScale,
            useNativeDriver: true,
            speed: 50,
            bounciness: 4,
          })
        : Animated.timing(scale, {
            toValue: toScale,
            duration: duration.instant,
            useNativeDriver: true,
          }),
      Animated.timing(opacity, {
        toValue: toOpacity,
        duration: duration.instant,
        useNativeDriver: true,
      }),
    ]).start();
  };

  return (
    <RNPressable
      onPressIn={(e) => {
        if (!disabled) animateTo(pressedScale, pressedOpacity, false);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        if (!disabled) animateTo(1, 1, true);
        onPressOut?.(e);
      }}
      disabled={disabled}
      // Ripple would fight the scale transform on Android, so it is opt-in only.
      android_ripple={android_ripple ?? null}
      {...props}
    >
      <Animated.View
        style={[
          style,
          { transform: [{ scale }], opacity },
          // Android clips shadows on transformed views unless elevation is
          // preserved on the animated layer itself.
          Platform.OS === 'android' ? { backfaceVisibility: 'hidden' } : null,
        ]}
      >
        {children}
      </Animated.View>
    </RNPressable>
  );
}
