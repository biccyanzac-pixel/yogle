import { test } from 'node:test';
import assert from 'node:assert/strict';
import { features, mirrorFeatures, circ, jointAngle, FEATURES, LM } from '../site/js/angles.js';
import { featureScore, matchPose, visibleFeatures, HoldSession, CONFIG, shareText, stabilityFromStd } from '../site/js/scoring.js';
import { utcDateString, dayNumber, weekdayMon0, mulberry32, hashString, entryFor, addDays, EPOCH } from '../site/js/daily.js';

// A simple standing skeleton (y down): arms straight out to the sides (T-pose), legs straight.
function tpose() {
  const p = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
  const set = (i, x, y) => { p[i] = { x, y }; };
  set(LM.NOSE, 0, -70);
  set(LM.L_SH, 20, -50); set(LM.R_SH, -20, -50); // subject's left is image right when facing camera
  set(LM.L_EL, 50, -50); set(LM.R_EL, -50, -50);
  set(LM.L_WR, 80, -50); set(LM.R_WR, -80, -50);
  set(LM.L_HIP, 10, 0); set(LM.R_HIP, -10, 0);
  set(LM.L_KN, 10, 45); set(LM.R_KN, -10, 45);
  set(LM.L_AN, 10, 90); set(LM.R_AN, -10, 90);
  return p;
}

test('circ wraps into (-180, 180]', () => {
  assert.equal(circ(190), -170);
  assert.equal(circ(-190), 170);
  assert.equal(circ(180), 180);
  assert.equal(circ(-180), 180);
  assert.equal(circ(720 + 5), 5);
});

test('segment orientations of a T-pose', () => {
  const f = features(tpose());
  assert.equal(Math.round(f.torso), 0);
  assert.equal(Math.round(f.l_upper_arm), 90);   // pointing image-right
  assert.equal(Math.round(f.r_upper_arm), -90);  // pointing image-left
  assert.equal(Math.round(f.l_thigh), 0);        // straight down
  assert.equal(Math.round(f.l_shin), 0);
});

test('mirroring a symmetric pose gives the same features', () => {
  const f = features(tpose()), m = mirrorFeatures(f);
  for (const k of FEATURES) assert.ok(Math.abs(circ(f[k] - m[k])) < 1e-9, k);
});

test('mirror of mirror is identity', () => {
  const p = tpose(); p[LM.L_WR] = { x: 60, y: -90 };
  const f = features(p), mm = mirrorFeatures(mirrorFeatures(f));
  for (const k of FEATURES) assert.ok(Math.abs(circ(f[k] - mm[k])) < 1e-9);
});

test('jointAngle: straight = 180, right angle = 90', () => {
  assert.equal(Math.round(jointAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })), 180);
  assert.equal(Math.round(jointAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })), 90);
  assert.ok(Number.isNaN(jointAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })));
});

test('featureScore: full marks inside tolerance, linear falloff, never negative', () => {
  assert.equal(featureScore(5, 10), 1);
  assert.equal(featureScore(-10, 10), 1);
  assert.equal(featureScore(25, 10, 30), 0.5);
  assert.equal(featureScore(100, 10, 30), 0);
});

const allVisible = () => Array(33).fill(1);
function poseFrom(f, { tol = 10, symmetric = false } = {}) {
  return { symmetric, targets: Object.fromEntries(FEATURES.map((k) => [k, { angle: f[k], tol, weight: 1 }])) };
}

test('matchPose: exact match scores 100, big error scores low', () => {
  const f = features(tpose());
  const pose = poseFrom(f);
  const vis = visibleFeatures(allVisible());
  assert.equal(Math.round(matchPose(f, vis, pose).score), 100);
  const bad = { ...f, l_upper_arm: f.l_upper_arm + 90, r_upper_arm: f.r_upper_arm - 90 }; // arms down
  const s = matchPose(bad, vis, pose, { allowMirror: false }).score;
  assert.ok(s < 80 && s > 50, `got ${s}`);
});

test('matchPose: mirrored asymmetric pose only accepted when allowed', () => {
  const p = tpose(); p[LM.L_EL] = { x: 20, y: -90 }; p[LM.L_WR] = { x: 20, y: -130 }; // left arm straight up
  const f = features(p);
  const pose = poseFrom(f);
  const other = mirrorFeatures(f); // player raises the other arm
  const vis = visibleFeatures(allVisible());
  assert.ok(matchPose(other, vis, pose, { allowMirror: false }).score < 90);
  const m = matchPose(other, vis, pose, { allowMirror: true });
  assert.equal(Math.round(m.score), 100);
  assert.equal(m.mirrored, true);
});

test('visibility gates features and reduces coverage instead of the score', () => {
  const f = features(tpose());
  const pose = poseFrom(f);
  const vis = allVisible(); vis[LM.L_WR] = 0.1;
  const v = visibleFeatures(vis);
  assert.equal(v.l_forearm, false);
  const m = matchPose(f, v, pose, { allowMirror: false });
  assert.equal(Math.round(m.score), 100);
  assert.ok(Math.abs(m.coverage - 8 / 9) < 1e-9);
});

function runHold(frames, fps = 30) {
  const h = new HoldSession();
  frames.forEach((fr, i) => h.update(i / fps, fr));
  return h;
}
const good = (score = 95, feat = { torso: 0 }) => ({ score, coverage: 1, per: {}, feat, mirrored: false });

test('hold: completes after HOLD_SECONDS of good frames', () => {
  const h = runHold(Array(30 * (CONFIG.HOLD_SECONDS + 1)).fill(good()));
  assert.equal(h.state, 'done');
  assert.ok(h.result().score >= 90);
});

test('hold: brief dropout inside grace keeps the clock running', () => {
  const frames = [...Array(90).fill(good()), ...Array(15).fill(null), ...Array(240).fill(good())]; // 0.5 s dropout
  const h = runHold(frames);
  assert.equal(h.state, 'done');
});

test('hold: long dropout pauses the timer', () => {
  const frames = [...Array(90).fill(good()), ...Array(90).fill(null)]; // 3 s gone
  const h = runHold(frames);
  assert.equal(h.state, 'paused');
  assert.ok(h.held > 2.9 && h.held < 4.1, `held ${h.held}`);
});

test('hold: timer does not start below threshold', () => {
  const h = runHold(Array(400).fill(good(CONFIG.MATCH_THRESHOLD - 1)));
  assert.equal(h.state, 'waiting');
  assert.equal(h.result().score, 0);
});

test('stability: jittery hold scores lower than a still one', () => {
  const still = runHold(Array(330).fill(0).map(() => good(95, { torso: 0 }))).result();
  const r = mulberry32(1);
  const shaky = runHold(Array(330).fill(0).map(() => good(95, { torso: (r() - 0.5) * 60 }))).result();
  assert.ok(still.stability > shaky.stability);
  assert.ok(still.score > shaky.score);
  assert.equal(stabilityFromStd(0), 100);
  assert.equal(stabilityFromStd(100), 0);
});

test('share text has a header and 4 rows of 5 squares', () => {
  const h = runHold(Array(330).fill(good()));
  const txt = shareText({ dayNumber: 3, poseName: 'Tree', score: 91, grid: h.result().grid });
  const lines = txt.split('\n');
  assert.equal(lines[0], 'Yogle #3 🧘 Tree 91/100');
  assert.equal(lines.length, 5);
  for (const l of lines.slice(1)) assert.equal([...l.split(' ')[0]].length, 5);
});

// ---- dates & seeding ----
test('UTC date string ignores local timezone', () => {
  // 23:30 on 31 Dec in New York is already 1 Jan in UTC
  assert.equal(utcDateString(new Date('2026-12-31T23:30:00-05:00')), '2027-01-01');
  // 00:30 on 1 Jan in Auckland is still 31 Dec in UTC
  assert.equal(utcDateString(new Date('2027-01-01T00:30:00+13:00')), '2026-12-31');
});

test('day numbers and weekdays', () => {
  assert.equal(dayNumber(EPOCH), 1);
  assert.equal(dayNumber(addDays(EPOCH, 1)), 2);
  assert.equal(weekdayMon0(EPOCH), 0); // epoch is a Monday
  assert.equal(weekdayMon0('2026-10-18'), 6); // Sunday
  // across a DST change in Europe/US the day count still steps by exactly one
  assert.equal(dayNumber('2027-03-29') - dayNumber('2027-03-28'), 1);
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // leap year
});

test('PRNG is deterministic and seed-sensitive', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notEqual(xs[0], c());
  assert.equal(hashString('yogle:2026-10-12'), hashString('yogle:2026-10-12'));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test('fallback entry is deterministic and harder on Sunday than Monday', () => {
  const poses = Array.from({ length: 70 }, (_, i) => ({ id: 'p' + i, difficulty: 1 + (i % 10), symmetric: true }));
  const mon = entryFor('2099-01-05', null, poses), mon2 = entryFor('2099-01-05', null, poses);
  assert.deepEqual(mon, mon2);
  const d = (id) => poses.find((p) => p.id === id).difficulty;
  let monSum = 0, sunSum = 0;
  for (let w = 0; w < 20; w++) {
    monSum += d(entryFor(addDays('2099-01-05', 7 * w), null, poses).pose);
    sunSum += d(entryFor(addDays('2099-01-11', 7 * w), null, poses).pose);
  }
  assert.ok(sunSum > monSum);
});

test('reported hold time never exceeds HOLD_SECONDS (the leaderboard rejects it)', () => {
  for (const fps of [3, 7, 11, 24, 30]) { // coarse frame steps can overshoot the 10 s mark
    const h = runHold(Array(fps * (CONFIG.HOLD_SECONDS + 2)).fill(good()), fps);
    assert.equal(h.state, 'done');
    assert.ok(h.result().held <= CONFIG.HOLD_SECONDS && h.result().held > CONFIG.HOLD_SECONDS - 0.5, `fps ${fps}: ${h.result().held}`);
  }
});

test('countdown to the next UTC midnight', async () => {
  const { msUntilNextUtcDay, formatCountdown } = await import('../site/js/daily.js');
  assert.equal(msUntilNextUtcDay(new Date('2026-10-07T23:59:59Z')), 1000);
  assert.equal(msUntilNextUtcDay(new Date('2026-10-07T00:00:00Z')), 86400000);
  // UK summer time: 00:30 BST on 8 Oct is still 23:30 UTC on 7 Oct -> 30 min left
  assert.equal(msUntilNextUtcDay(new Date('2026-10-08T00:30:00+01:00')), 30 * 60000);
  assert.equal(msUntilNextUtcDay(new Date('2028-02-28T12:00:00Z')), 12 * 3600000); // leap year
  assert.equal(formatCountdown(3 * 3600000 + 4 * 60000 + 5000), '03:04:05');
  assert.equal(formatCountdown(-5), '00:00:00');
  assert.equal(formatCountdown(1), '00:00:01'); // rounds up so it never shows 0 early
});
