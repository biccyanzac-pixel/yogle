// Per-device history and streaks. localStorage can be missing or throw (private mode, blocked storage),
// so every access is guarded and the game works without it.
import { addDays } from './daily.js';

const KEY = 'yogle:v1';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function write(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); return true; } catch { return false; }
}

export function getFlag(name) { return !!read().flags?.[name]; }
export function setFlag(name, value = true) { const d = read(); d.flags = { ...(d.flags || {}), [name]: value }; write(d); }

/** Record a daily result; keeps the best score per date. */
export function recordDaily(date, { pose, score, grid }) {
  const d = read();
  d.history = d.history || {};
  const prev = d.history[date];
  if (!prev || score > prev.score) d.history[date] = { pose, score, grid };
  write(d);
  return d.history[date];
}

export function getDaily(date) { return read().history?.[date] ?? null; }

export function stats(today) {
  const h = read().history || {};
  const dates = Object.keys(h).sort();
  let streak = 0;
  // the streak survives until the end of today even if today isn't played yet
  let day = h[today] ? today : addDays(today, -1);
  while (h[day]) { streak++; day = addDays(day, -1); }
  let best = 0, run = 0, prev = null;
  for (const dt of dates) { run = prev && addDays(prev, 1) === dt ? run + 1 : 1; best = Math.max(best, run); prev = dt; }
  const scores = dates.map((dt) => h[dt].score);
  return { played: dates.length, streak, bestStreak: best, average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null };
}

/** Archive replays are kept apart from daily history: they never count towards streaks or stats. */
export function recordReplay(date, { pose, score }) {
  const d = read();
  d.replays = d.replays || {};
  if (!d.replays[date] || score > d.replays[date].score) d.replays[date] = { pose, score };
  write(d);
}

export function getReplay(date) { return read().replays?.[date] ?? null; }
