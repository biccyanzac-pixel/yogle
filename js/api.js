// Client for the shared leaderboard worker (worker/). Only scores and names are sent, never video or landmarks.
// The URL comes from data/config.json at runtime, so the backend can be switched by editing one file.
// Every call fails soft: if the backend is down or unset, the game still works without a leaderboard.

const SESSION_KEY = 'yogle:session';
const NAME_KEY = 'yogle:name';
let base = undefined;

export async function loadConfig() {
  if (base !== undefined) return base;
  try {
    const cfg = await (await fetch('data/config.json', { cache: 'no-cache' })).json();
    const override = new URLSearchParams(location.search).get('api'); // local testing: ?api=http://127.0.0.1:8797
    base = (override || cfg.leaderboardUrl || '').replace(/\/+$/, '') || null;
  } catch { base = null; }
  return base;
}

export const enabled = () => !!base;

async function call(path, body) {
  if (!base) throw new Error('No leaderboard configured.');
  const res = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }
  if (!res.ok) { const e = new Error(data?.message || `Leaderboard error (HTTP ${res.status}).`); e.status = res.status; e.code = data?.error; throw e; }
  return data;
}

function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
function writeSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode: session lasts for this page */ } }
let memSession = null;

export async function session(fresh = false) {
  if (!fresh) { const s = memSession || readSession(); if (s?.playerId && s?.token) return (memSession = s); }
  memSession = await call('/api/session', {});
  writeSession(memSession);
  return memSession;
}

export function playerId() { return (memSession || readSession())?.playerId ?? null; }

export function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } }

/** Submit a finished run for a day. Retries once with a fresh session if the stored one is unknown. */
export async function submit({ day, pose, name, result }) {
  const body = { day, pose, name, score: result.score, accuracy: result.accuracy, stability: result.stability, held: Math.round(result.held * 100) / 100, grid: result.grid };
  let s = await session();
  try { return await call('/api/submit', { ...s, ...body }); }
  catch (e) {
    if (e.code !== 'bad_session') throw e;
    s = await session(true);
    return call('/api/submit', { ...s, ...body });
  }
}

export function board(day, late = false) {
  const pid = playerId();
  return call(`/api/leaderboard?day=${day}${late ? '&late=1' : ''}${pid ? '&playerId=' + encodeURIComponent(pid) : ''}`);
}

export function days(from, to) { return call(`/api/days?from=${from}&to=${to}`); }
