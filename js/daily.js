// Deterministic daily pose: everyone gets the same pose for the same UTC date, no server.

export const EPOCH = '2026-10-05'; // Yogle #1 (a Monday)

/** UTC calendar date 'YYYY-MM-DD' for a Date (defaults to now). Uses UTC on purpose: one global puzzle per day. */
export function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Whole days between two 'YYYY-MM-DD' strings (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

/** Puzzle number: 1 on EPOCH. */
export function dayNumber(dateStr) {
  return daysBetween(EPOCH, dateStr) + 1;
}

/** 0 = Monday ... 6 = Sunday, for a UTC date string. */
export function weekdayMon0(dateStr) {
  return (new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

/** mulberry32: small, fast, well-distributed 32-bit seeded PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string to a 32-bit seed. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * Today's entry: from the committed schedule if the date is covered, otherwise a seeded fallback
 * (weekday-appropriate difficulty band, seeded by the date) so the game never breaks after the schedule ends.
 */
export function entryFor(dateStr, schedule, poses) {
  const hit = schedule?.days?.[dateStr];
  if (hit) return { ...hit, date: dateStr, fromSchedule: true };
  const rand = mulberry32(hashString('yogle:' + dateStr));
  const wd = weekdayMon0(dateStr);
  const sorted = [...poses].sort((a, b) => a.difficulty - b.difficulty || a.id.localeCompare(b.id));
  const lo = Math.floor((wd / 7) * sorted.length), hi = Math.max(lo + 1, Math.floor(((wd + 1) / 7) * sorted.length));
  const pick = sorted[lo + Math.floor(rand() * (hi - lo))];
  return { pose: pick.id, date: dateStr, fromSchedule: false };
}
