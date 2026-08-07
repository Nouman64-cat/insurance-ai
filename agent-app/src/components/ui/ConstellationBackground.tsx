import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing, Dimensions } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface NodeDef {
  id: number;
  baseX: number;
  baseY: number;
  connectTo: number[];
  speed: number;
  dx: number;
  dy: number;
}

const NODES: NodeDef[] = [
  { id: 0, baseX: SCREEN_WIDTH * 0.08, baseY: SCREEN_HEIGHT * 0.1, connectTo: [1, 4], speed: 1800, dx: 30, dy: 20 },
  { id: 1, baseX: SCREEN_WIDTH * 0.35, baseY: SCREEN_HEIGHT * 0.06, connectTo: [2, 5], speed: 2200, dx: -25, dy: 35 },
  { id: 2, baseX: SCREEN_WIDTH * 0.68, baseY: SCREEN_HEIGHT * 0.12, connectTo: [3, 6], speed: 1900, dx: 40, dy: -25 },
  { id: 3, baseX: SCREEN_WIDTH * 0.92, baseY: SCREEN_HEIGHT * 0.18, connectTo: [6, 7], speed: 2100, dx: -30, dy: 30 },
  
  { id: 4, baseX: SCREEN_WIDTH * 0.15, baseY: SCREEN_HEIGHT * 0.32, connectTo: [5, 8], speed: 2000, dx: 35, dy: -30 },
  { id: 5, baseX: SCREEN_WIDTH * 0.52, baseY: SCREEN_HEIGHT * 0.28, connectTo: [6, 9], speed: 1700, dx: -40, dy: 25 },
  { id: 6, baseX: SCREEN_WIDTH * 0.82, baseY: SCREEN_HEIGHT * 0.36, connectTo: [7, 10], speed: 2300, dx: 25, dy: 40 },
  { id: 7, baseX: SCREEN_WIDTH * 0.95, baseY: SCREEN_HEIGHT * 0.48, connectTo: [11], speed: 1900, dx: -35, dy: -20 },

  { id: 8, baseX: SCREEN_WIDTH * 0.06, baseY: SCREEN_HEIGHT * 0.62, connectTo: [9, 12], speed: 2100, dx: 45, dy: 30 },
  { id: 9, baseX: SCREEN_WIDTH * 0.42, baseY: SCREEN_HEIGHT * 0.58, connectTo: [10, 13], speed: 1800, dx: -30, dy: -35 },
  { id: 10, baseX: SCREEN_WIDTH * 0.78, baseY: SCREEN_HEIGHT * 0.65, connectTo: [11, 14], speed: 2400, dx: 35, dy: -25 },
  { id: 11, baseX: SCREEN_WIDTH * 0.9, baseY: SCREEN_HEIGHT * 0.75, connectTo: [14, 15], speed: 2000, dx: -40, dy: 30 },

  { id: 12, baseX: SCREEN_WIDTH * 0.12, baseY: SCREEN_HEIGHT * 0.88, connectTo: [13], speed: 1900, dx: 30, dy: -40 },
  { id: 13, baseX: SCREEN_WIDTH * 0.48, baseY: SCREEN_HEIGHT * 0.85, connectTo: [14], speed: 2200, dx: -35, dy: 25 },
  { id: 14, baseX: SCREEN_WIDTH * 0.75, baseY: SCREEN_HEIGHT * 0.9, connectTo: [15], speed: 1800, dx: 25, dy: -30 },
  { id: 15, baseX: SCREEN_WIDTH * 0.94, baseY: SCREEN_HEIGHT * 0.92, connectTo: [], speed: 2000, dx: -20, dy: -35 },
];

function Line({ x1, y1, x2, y2, color, opacity }: { x1: number; y1: number; x2: number; y2: number; color: string; opacity: number }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  return (
    <View
      style={{
        position: 'absolute',
        left: midX - length / 2,
        top: midY,
        width: length,
        height: 1,
        backgroundColor: color,
        opacity,
        transform: [{ rotate: `${angle}rad` }],
      }}
    />
  );
}

export default function ConstellationBackground() {
  const { colors, isDark } = useTheme();

  // Floating 2D position and opacity animations per node
  const anims = useRef(
    NODES.map(() => ({
      x: new Animated.Value(0),
      y: new Animated.Value(0),
      opacity: new Animated.Value(0.15),
    }))
  ).current;

  useEffect(() => {
    NODES.forEach((node, i) => {
      if (!anims[i]) return;
      Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(anims[i].x, {
              toValue: node.dx,
              duration: node.speed,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(anims[i].y, {
              toValue: node.dy,
              duration: node.speed,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(anims[i].opacity, {
              toValue: 0.45,
              duration: node.speed,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: true,
            }),
          ]),
          Animated.parallel([
            Animated.timing(anims[i].x, {
              toValue: 0,
              duration: node.speed * 1.1,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(anims[i].y, {
              toValue: 0,
              duration: node.speed * 1.1,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(anims[i].opacity, {
              toValue: 0.1,
              duration: node.speed * 1.1,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: true,
            }),
          ]),
        ])
      ).start();
    });
  }, [anims]);

  const dotColor = isDark ? colors.tone.brand.solid : colors.primary;
  const lineColor = isDark ? colors.tone.brand.solid : colors.primary;
  const lineOpacity = isDark ? 0.08 : 0.05;

  // Build connecting line segments between node base positions
  const lines: React.ReactNode[] = [];
  NODES.forEach((node) => {
    node.connectTo.forEach((targetId) => {
      const target = NODES.find((n) => n.id === targetId);
      if (target) {
        lines.push(
          <Line
            key={`line_${node.id}_${target.id}`}
            x1={node.baseX}
            y1={node.baseY}
            x2={target.baseX}
            y2={target.baseY}
            color={lineColor}
            opacity={lineOpacity}
          />
        );
      }
    });
  });

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      {/* Delicate hairline network lines */}
      {lines}

      {/* Extreme small light dots */}
      {NODES.map((node, index) => {
        const anim = anims[index];
        if (!anim) return null;

        return (
          <Animated.View
            key={`node_${node.id}`}
            style={[
              styles.extremeSmallDot,
              {
                left: node.baseX - 1,
                top: node.baseY - 1,
                backgroundColor: dotColor,
                opacity: anim.opacity,
                transform: [
                  { translateX: anim.x },
                  { translateY: anim.y },
                ],
              },
            ]}
          >
            {/* Subtle soft micro halo */}
            <View style={[styles.microHalo, { backgroundColor: dotColor }]} />
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  extremeSmallDot: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  microHalo: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.15,
  },
});
