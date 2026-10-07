// Validate scoring on real videos: people doing pose X should match X well and other poses poorly.
// Input: landmarks from bench/run_clips.mjs. Uses the game's own scoring code.
// node tools/eval_clips.mjs bench/frames/scoring_clips.json bench/results/clips_mpfull.json
import fs from 'node:fs';
import { features } from '../site/js/angles.js';
import { matchPose, visibleFeatures, CONFIG } from '../site/js/scoring.js';

const [clipsFile, lmFile] = process.argv.slice(2);
const clips = JSON.parse(fs.readFileSync(clipsFile, 'utf8'));
const LM = JSON.parse(fs.readFileSync(lmFile, 'utf8'));
const lib = JSON.parse(fs.readFileSync('site/data/poses.json', 'utf8'));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

function clipScores(frames) {
  const per = {};
  for (const pose of lib.poses) {
    const scores = [];
    for (const f of frames) {
      if (!f) continue;
      const pts = f.map((p) => ({ x: p[0], y: p[1] }));
      const m = matchPose(features(pts), visibleFeatures(f.map((p) => p[2])), pose);
      if (m.coverage >= CONFIG.MIN_COVERAGE) scores.push(m.score);
    }
    per[pose.id] = { median: median(scores), above: scores.length ? scores.filter((s) => s >= CONFIG.MATCH_THRESHOLD).length / frames.length : 0, n: scores.length };
  }
  return per;
}

const rows = [];
for (const c of clips) {
  const frames = LM[c.dir];
  if (!frames || !lib.poses.some((p) => p.id === c.expected)) continue;
  const per = clipScores(frames);
  const ranked = Object.entries(per).sort((a, b) => b[1].median - a[1].median);
  const rank = ranked.findIndex(([id]) => id === c.expected) + 1;
  const bestOther = ranked.find(([id]) => id !== c.expected);
  rows.push({ clip: c.dir.split('/').pop(), expected: c.expected, own: Math.round(per[c.expected].median), ownAbove: per[c.expected].above,
    rank, bestOther: bestOther[0], bestOtherScore: Math.round(bestOther[1].median), detected: frames.filter(Boolean).length / frames.length });
}
const byPose = {};
for (const r of rows) (byPose[r.expected] ??= []).push(r);
console.log('pose'.padEnd(24), 'own median (4 clips)'.padEnd(22), 'rank of own pose', '  frames >= threshold', '  most confused with');
for (const [p, rs] of Object.entries(byPose)) {
  console.log(p.padEnd(24), rs.map((r) => String(r.own).padStart(3)).join(' ').padEnd(22), rs.map((r) => String(r.rank).padStart(3)).join(' ').padEnd(18),
    rs.map((r) => (r.ownAbove * 100).toFixed(0).padStart(4) + '%').join(''), '  ', rs.map((r) => `${r.bestOther}(${r.bestOtherScore})`).join(', '));
}
const own = rows.map((r) => r.own), other = rows.map((r) => r.bestOtherScore);
const top1 = rows.filter((r) => r.rank === 1).length, top3 = rows.filter((r) => r.rank <= 3).length;
console.log(`\nclips ${rows.length}: own-pose median score mean ${Math.round(own.reduce((a, b) => a + b) / own.length)}, ` +
  `own pose ranked #1 in ${top1}, top-3 in ${top3}; clips reaching the ${CONFIG.MATCH_THRESHOLD} threshold in >=30% of frames: ${rows.filter((r) => r.ownAbove >= 0.3).length}`);
fs.writeFileSync(lmFile.replace('.json', '_eval.json'), JSON.stringify(rows, null, 1));
