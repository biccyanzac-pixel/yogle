// Per-frame pose matching and the 10-second hold. Pure functions/classes: no DOM, no camera.
import { FEATURES, FEATURE_LANDMARKS, circ, mirrorFeatures } from './angles.js';

// Provisional constants: these set difficulty (see docs/scoring.md).
export const CONFIG = {
  VIS_MIN: 0.5,          // landmark visibility below this => feature not scored (gate, not weight)
  MIN_COVERAGE: 0.7,     // fraction of the pose's scoring weight that must be visible
  FALLOFF: 30,           // degrees beyond tolerance at which a feature scores 0
  MATCH_THRESHOLD: 60,   // frame score needed for the hold timer to run
  HOLD_SECONDS: 10,
  GRACE_SECONDS: 1.0,    // brief dropouts/dips shorter than this don't pause the timer
  STABILITY_WEIGHT: 0.15,
  STABILITY_GOOD_DEG: 2, // mean per-feature std (deg) at or below which stability = 100
  STABILITY_BAD_DEG: 12, // ... at or above which stability = 0
};

export const PART_OF = { torso: 'torso', l_upper_arm: 'arms', r_upper_arm: 'arms', l_forearm: 'arms', r_forearm: 'arms', l_thigh: 'legs', r_thigh: 'legs', l_shin: 'legs', r_shin: 'legs' };

/** Score one feature: 1 inside tolerance, linear to 0 at tolerance + FALLOFF. */
export function featureScore(err, tol, falloff = CONFIG.FALLOFF) {
  const e = Math.abs(err);
  if (e <= tol) return 1;
  return Math.max(0, 1 - (e - tol) / falloff);
}

/** Which features are visible enough to score. vis: per-landmark visibility array (33). */
export function visibleFeatures(vis, minVis = CONFIG.VIS_MIN) {
  const out = {};
  for (const f of FEATURES) out[f] = FEATURE_LANDMARKS[f].every((i) => (vis[i] ?? 0) >= minVis);
  return out;
}

/** Scoring weight we can expect to see. In a side view the far arm and leg are hidden behind the body,
 *  so only one limb of each left/right pair is expected. */
export function expectedWeight(targets, view) {
  let w = 0;
  for (const f of FEATURES) {
    const t = targets[f];
    if (!t || t.weight <= 0) continue;
    if (view === 'side' && f.startsWith('r_')) continue; // counted with its l_ partner below
    if (view === 'side' && f.startsWith('l_')) w += Math.max(t.weight, targets['r_' + f.slice(2)]?.weight ?? 0);
    else w += t.weight;
  }
  return w;
}

function scoreAgainst(feat, visible, targets, view) {
  let wvis = 0, acc = 0;
  const per = {};
  for (const f of FEATURES) {
    const t = targets[f];
    if (!t || t.weight <= 0) continue;
    if (!visible[f] || feat[f] === undefined || Number.isNaN(feat[f])) { per[f] = null; continue; }
    const err = circ(feat[f] - t.angle);
    const s = featureScore(err, t.tol);
    per[f] = { err, score: s };
    wvis += t.weight; acc += t.weight * s;
  }
  // The torso anchors everything: without it there is no score.
  if (!per.torso) return { score: 0, coverage: 0, per };
  // Coverage: in a side view each left/right pair counts once (whichever limb is visible).
  let seen = 0;
  for (const f of FEATURES) {
    const t = targets[f];
    if (!t || t.weight <= 0 || !per[f]) continue;
    if (view === 'side' && f.startsWith('r_') && per['l_' + f.slice(2)]) continue;
    seen += view === 'side' && f.startsWith('l_') ? Math.max(t.weight, per['r_' + f.slice(2)] ? targets['r_' + f.slice(2)].weight : 0) : t.weight;
  }
  const expected = expectedWeight(targets, view);
  return { score: wvis > 0 ? (100 * acc) / wvis : 0, coverage: expected > 0 ? Math.min(1, seen / expected) : 0, per };
}

/**
 * Match a player's features against a pose.
 * Mirror (the other side) is accepted when the pose is symmetric or allowMirror is set (player chose "either side").
 */
export function matchPose(feat, visible, pose, { allowMirror = true } = {}) {
  const swapName = (f) => (f.startsWith('l_') ? 'r_' + f.slice(2) : f.startsWith('r_') ? 'l_' + f.slice(2) : f);
  const swapVis = (v) => Object.fromEntries(FEATURES.map((f) => [swapName(f), v[f]]));
  const swapFeat = (x) => Object.fromEntries(FEATURES.map((f) => [swapName(f), x[f]]));
  // Variants of the player that count as "the same pose":
  //   mirrored: the other side, seen in a mirror (front view, or facing the other way in a side view)
  //   swapped:  side view only - same facing direction, other leg/arm leading (also absorbs left/right label mix-ups)
  const variants = [{ feat, vis: visible, mirrored: false, swapped: false }];
  if (pose.symmetric || allowMirror) {
    variants.push({ feat: mirrorFeatures(feat), vis: swapVis(visible), mirrored: true, swapped: false });
    if (pose.view === 'side') {
      variants.push({ feat: swapFeat(feat), vis: swapVis(visible), mirrored: false, swapped: true });
      variants.push({ feat: mirrorFeatures(swapFeat(feat)), vis: visible, mirrored: true, swapped: true });
    }
  }
  let best = null;
  for (const v of variants) {
    const r = scoreAgainst(v.feat, v.vis, pose.targets, pose.view);
    if (!best || r.score > best.score + 1e-9) best = { ...r, mirrored: v.mirrored, swapped: v.swapped };
  }
  return best;
}

function std(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function stabilityFromStd(meanStd, cfg = CONFIG) {
  if (meanStd <= cfg.STABILITY_GOOD_DEG) return 100;
  if (meanStd >= cfg.STABILITY_BAD_DEG) return 0;
  return 100 * (1 - (meanStd - cfg.STABILITY_GOOD_DEG) / (cfg.STABILITY_BAD_DEG - cfg.STABILITY_GOOD_DEG));
}

/**
 * Tracks the hold. Feed it one frame at a time with a timestamp in seconds.
 * frame = null (no person) or { score, coverage, per, feat, mirrored }.
 */
export class HoldSession {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.held = 0;          // seconds counted towards the hold
    this.lastT = null;
    this.lastGoodT = null;  // last time the frame was good
    this.samples = [];      // { t, score, per, feat } during counted time
    this.best = null;       // best single frame { t, score }
    this.state = 'waiting'; // waiting | holding | paused | done
  }

  isGood(frame) {
    return frame && frame.coverage >= this.cfg.MIN_COVERAGE && frame.score >= this.cfg.MATCH_THRESHOLD;
  }

  update(t, frame) {
    if (this.state === 'done') return this.state;
    const dt = this.lastT === null ? 0 : Math.min(0.5, Math.max(0, t - this.lastT));
    this.lastT = t;
    const good = this.isGood(frame);
    if (good) this.lastGoodT = t;
    // a short dip or tracking dropout while holding keeps the clock running
    const bridging = !good && this.state === 'holding' && t - this.lastGoodT <= this.cfg.GRACE_SECONDS;
    if (good || bridging) {
      if (this.state === 'holding') this.held += dt; // the frame that starts/resumes a hold adds no time
      this.state = 'holding';
      if (frame && frame.coverage >= this.cfg.MIN_COVERAGE) {
        this.samples.push({ t: this.held, score: frame.score, per: frame.per, feat: frame.feat, mirrored: frame.mirrored });
        if (!this.best || frame.score > this.best.score) this.best = { t, score: frame.score };
      }
      if (this.held >= this.cfg.HOLD_SECONDS) this.state = 'done';
    } else if (this.state === 'holding') {
      this.state = 'paused';
    }
    return this.state;
  }

  /** Final result. Usable after 'done' or when the player gives up (partial hold is scaled down). */
  result() {
    const cfg = this.cfg;
    const s = this.samples;
    const accuracy = s.length ? s.reduce((a, x) => a + x.score, 0) / s.length : 0;
    // stability: per-feature std over the hold, averaged over features that were visible for most of it
    const stds = [];
    for (const f of FEATURES) {
      const xs = s.map((x) => x.feat?.[f]).filter((v) => v !== undefined && !Number.isNaN(v) && v !== null);
      if (xs.length >= Math.max(5, s.length * 0.6)) {
        const ref = xs[0];
        stds.push(std(xs.map((v) => ref + circ(v - ref))));
      }
    }
    const meanStd = stds.length ? stds.reduce((a, b) => a + b, 0) / stds.length : cfg.STABILITY_BAD_DEG;
    const stability = s.length ? stabilityFromStd(meanStd, cfg) : 0;
    const completion = Math.min(1, this.held / cfg.HOLD_SECONDS);
    const score = Math.round(completion * ((1 - cfg.STABILITY_WEIGHT) * accuracy + cfg.STABILITY_WEIGHT * stability));
    return { score, accuracy: Math.round(accuracy), stability: Math.round(stability), completion, held: Math.min(this.held, cfg.HOLD_SECONDS), grid: this.grid(), mirrored: s.length ? s.filter((x) => x.mirrored).length > s.length / 2 : false };
  }

  /** 4 rows (arms, legs, torso, steadiness) x 5 two-second columns of 0-100 scores (null = no data). */
  grid(cols = 5) {
    const cfg = this.cfg;
    const rows = { arms: [], legs: [], torso: [], steady: [] };
    for (let c = 0; c < cols; c++) {
      const lo = (c * cfg.HOLD_SECONDS) / cols, hi = ((c + 1) * cfg.HOLD_SECONDS) / cols;
      const bin = this.samples.filter((x) => x.t >= lo && (x.t < hi || (c === cols - 1 && x.t <= hi)));
      for (const part of ['arms', 'legs', 'torso']) {
        const vals = [];
        for (const x of bin) for (const [f, v] of Object.entries(x.per)) if (v && PART_OF[f] === part) vals.push(v.score * 100);
        rows[part].push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
      }
      const stds = [];
      for (const f of FEATURES) {
        const xs = bin.map((x) => x.feat?.[f]).filter((v) => v !== undefined && v !== null && !Number.isNaN(v));
        if (xs.length >= 3) { const ref = xs[0]; stds.push(std(xs.map((v) => ref + circ(v - ref)))); }
      }
      rows.steady.push(stds.length ? stabilityFromStd(stds.reduce((a, b) => a + b, 0) / stds.length, cfg) : null);
    }
    return rows;
  }
}

export function emojiFor(v) {
  if (v === null || v === undefined) return '⬛';
  if (v >= 85) return '🟩';
  if (v >= 60) return '🟨';
  return '🟥';
}

export function shareText({ dayNumber, poseName, score, grid, practice = false, replay = false }) {
  const label = { arms: 'Arms ', legs: 'Legs ', torso: 'Torso', steady: 'Still' };
  const lines = Object.entries(grid).map(([k, row]) => row.map(emojiFor).join('') + ' ' + label[k].trim());
  const head = practice ? `Yogle practice 🧘 ${poseName} ${score}/100` : `Yogle #${dayNumber}${replay ? ' (replay)' : ''} 🧘 ${poseName} ${score}/100`;
  return [head, ...lines].join('\n');
}
