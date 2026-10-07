// Regenerates site/data/schedule.json deterministically from site/data/poses.json.
// Rules (checked by test/schedule.test.mjs):
//   - no pose repeats within 21 days
//   - consecutive days have a different body focus
//   - difficulty rises through the week (Monday easiest, Sunday hardest)
// usage: node tools/make_schedule.mjs [startDate] [days]
import fs from 'node:fs';
import { EPOCH, addDays, weekdayMon0, mulberry32, hashString } from '../site/js/daily.js';

export const MIN_GAP_DAYS = 21;

export function makeSchedule(poses, start = EPOCH, days = 2 * 365 + 90, seed = 'yogle-v1') {
  const rand = mulberry32(hashString(seed));
  const ranked = [...poses].sort((a, b) => a.difficulty - b.difficulty || a.id.localeCompare(b.id));
  const rank = new Map(ranked.map((p, i) => [p.id, i / Math.max(1, ranked.length - 1)]));
  const used = new Map(); // pose id -> day indexes
  const byDay = [];       // day index -> pose
  const restedSince = (id, d) => Math.min(1e9, ...(used.get(id) ?? []).map((u) => Math.abs(d - u)));
  const place = (d) => {
    const wd = weekdayMon0(addDays(start, d));
    const centre = (wd + 0.5) / 7;
    const neighbours = [byDay[d - 1], byDay[d + 1]].filter(Boolean).map((p) => p.focus);
    const ok = (p) => restedSince(p.id, d) >= MIN_GAP_DAYS && !neighbours.includes(p.focus);
    // widen the difficulty window around this weekday until something is available
    for (let half = 1 / 7; half <= 1; half += 0.25 / 7) {
      const cands = ranked.filter((p) => Math.abs(rank.get(p.id) - centre) <= half && ok(p));
      if (cands.length) {
        // prefer poses that have rested longest, with a seeded random tie-break
        cands.sort((a, b) => restedSince(b.id, d) - restedSince(a.id, d));
        const pool = cands.slice(0, Math.max(1, Math.ceil(cands.length / 2)));
        return pool[Math.floor(rand() * pool.length)];
      }
    }
    throw new Error(`no pose available for ${addDays(start, d)}`);
  };
  // Plan week by week, Sunday (hardest, smallest pool) first, then Monday..Saturday in order.
  for (let w0 = 0; w0 < days; ) {
    const len = Math.min(7 - weekdayMon0(addDays(start, w0)), days - w0);
    const order = [...Array(len).keys()].map((i) => w0 + i);
    const sun = order.find((d) => weekdayMon0(addDays(start, d)) === 6);
    for (const d of sun !== undefined ? [sun, ...order.filter((x) => x !== sun)] : order) {
      const pick = place(d);
      byDay[d] = pick;
      used.set(pick.id, [...(used.get(pick.id) ?? []), d]);
    }
    w0 += len;
  }
  const out = {};
  byDay.forEach((p, d) => { out[addDays(start, d)] = { pose: p.id }; });
  return { generated_with: 'tools/make_schedule.mjs', seed, start, end: addDays(start, days - 1), days: out };
}

if (process.argv[1] && process.argv[1].endsWith('make_schedule.mjs')) {
  const lib = JSON.parse(fs.readFileSync('site/data/poses.json', 'utf8'));
  const sched = makeSchedule(lib.poses, process.argv[2] || EPOCH, Number(process.argv[3]) || 2 * 365 + 90);
  fs.writeFileSync('site/data/schedule.json', JSON.stringify(sched));
  console.log(`schedule ${sched.start} .. ${sched.end}: ${Object.keys(sched.days).length} days, ${new Set(Object.values(sched.days).map((x) => x.pose)).size} distinct poses`);
}
