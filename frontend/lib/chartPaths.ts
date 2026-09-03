export interface PathPoint {
  x: number;
  y: number;
}

/**
 * Smooth cubic-spline SVG path through a series of already-scaled points
 * (Catmull-Rom-style tangents). Used for every line/area chart in the
 * dashboard so trend lines share one visual language.
 */
export function smoothPathFromPoints(pts: PathPoint[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`;

  let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? i : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/** Closes a smoothed line path down to `bottomY` to make a filled area path. */
export function areaPathFromPoints(pts: PathPoint[], bottomY: number): string {
  const linePath = smoothPathFromPoints(pts);
  if (!linePath) return "";
  const firstX = pts[0].x.toFixed(1);
  const lastX = pts[pts.length - 1].x.toFixed(1);
  return `${linePath} L ${lastX},${bottomY.toFixed(1)} L ${firstX},${bottomY.toFixed(1)} Z`;
}
