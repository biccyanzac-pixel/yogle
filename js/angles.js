// Pose features: signed segment orientations in the image plane, in degrees.
// 0 = segment pointing straight down (torso: 0 = upright); +90 = pointing towards image right.
// Must stay identical to tools/build_library.py `features()`.

export const LM = {
  NOSE: 0, L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16,
  L_HIP: 23, R_HIP: 24, L_KN: 25, R_KN: 26, L_AN: 27, R_AN: 28,
};

export const SEGMENTS = {
  torso: null,
  l_upper_arm: [LM.L_SH, LM.L_EL], r_upper_arm: [LM.R_SH, LM.R_EL],
  l_forearm: [LM.L_EL, LM.L_WR], r_forearm: [LM.R_EL, LM.R_WR],
  l_thigh: [LM.L_HIP, LM.L_KN], r_thigh: [LM.R_HIP, LM.R_KN],
  l_shin: [LM.L_KN, LM.L_AN], r_shin: [LM.R_KN, LM.R_AN],
};
export const FEATURES = Object.keys(SEGMENTS);

// Landmarks each feature depends on (for visibility gating)
export const FEATURE_LANDMARKS = Object.fromEntries(FEATURES.map((f) => [f, SEGMENTS[f] ?? [LM.L_SH, LM.R_SH, LM.L_HIP, LM.R_HIP]]));

const DEG = 180 / Math.PI;

/** Wrap an angle difference into (-180, 180]. */
export function circ(a) {
  let d = ((a + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** @param pts array of {x, y} in pixel-aspect-correct coordinates (y down). */
export function features(pts) {
  const out = {};
  for (const f of FEATURES) {
    if (f === 'torso') {
      const hx = (pts[LM.L_HIP].x + pts[LM.R_HIP].x) / 2, hy = (pts[LM.L_HIP].y + pts[LM.R_HIP].y) / 2;
      const sx = (pts[LM.L_SH].x + pts[LM.R_SH].x) / 2, sy = (pts[LM.L_SH].y + pts[LM.R_SH].y) / 2;
      out.torso = Math.atan2(sx - hx, -(sy - hy)) * DEG;
    } else {
      const [a, b] = SEGMENTS[f];
      out[f] = Math.atan2(pts[b].x - pts[a].x, pts[b].y - pts[a].y) * DEG;
    }
  }
  return out;
}

export const MIRROR_FEATURE = Object.fromEntries(FEATURES.map((f) => [f, f.startsWith('l_') ? 'r_' + f.slice(2) : f.startsWith('r_') ? 'l_' + f.slice(2) : f]));

/** Features of the left-right mirror image of a pose: swap sides and negate (x -> -x). */
export function mirrorFeatures(feat) {
  const out = {};
  for (const f of FEATURES) out[MIRROR_FEATURE[f]] = feat[f] === undefined ? undefined : circ(-feat[f]);
  return out;
}

/** Interior joint angle at b (degrees, 180 = straight). */
export function jointAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (n < 1e-9) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n))) * DEG;
}
