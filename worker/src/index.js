/**
 * Yogle shared leaderboard: Cloudflare Worker + D1. Modelled on jacob.gg's leaderboard worker.
 *
 * Scoring happens entirely in the player's browser (MediaPipe pose tracking; video never leaves the
 * device). This worker never sees video or landmarks. It stores the numbers the browser computed and
 * closes every cheap hole:
 *   - player ids are issued here (/api/session) with a token; a submission must present the token.
 *   - the day must be a real date, not in the future; "late" (archive replay) = day before today (UTC).
 *   - the pose must be the one this server's own copy of the schedule assigns to that day
 *     (same code and data as the site: ../site/js/daily.js + ../site/data/*.json, bundled at deploy).
 *   - numbers must be in range and consistent: score == completion * (0.85 * accuracy + 0.15 * stability)
 *     within rounding, completion == held / 10.
 *   - attempt numbers are assigned here; at most MAX_ATTEMPTS per player per day per board.
 *   - rows are insert-only.
 * Not defended (by design, same as jacob.gg): a modified browser that reports invented numbers.
 */
import { entryFor } from '../../site/js/daily.js';
import schedule from '../../site/data/schedule.json';
import library from '../../site/data/poses.json';

const MAX_NAME = 20;
const MAX_ATTEMPTS = 10;
const BOARD_SIZE = 20;
const HOLD_SECONDS = 10;
const STABILITY_WEIGHT = 0.15;
const GRID_ROWS = ['arms', 'legs', 'torso', 'steady'];

export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function poseForDay(day) {
  return entryFor(day, schedule, library.poses).pose;
}

function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))
    && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

function validateName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || [...name].length > MAX_NAME) return null;
  return name;
}

const num = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;

/** Range and consistency checks on the numbers the browser computed. Returns an error message or null. */
export function checkResult(r) {
  if (!num(r.score, 0, 100) || !num(r.accuracy, 0, 100) || !num(r.stability, 0, 100) || !num(r.held, 0, HOLD_SECONDS)) {
    return 'Scores out of range.';
  }
  const completion = Math.min(1, r.held / HOLD_SECONDS);
  const expected = completion * ((1 - STABILITY_WEIGHT) * r.accuracy + STABILITY_WEIGHT * r.stability);
  // accuracy and stability arrive rounded to whole numbers, so allow a little slack
  if (Math.abs(expected - r.score) > 1.5) return 'Score does not add up.';
  const g = r.grid;
  if (!g || typeof g !== 'object') return 'Missing grid.';
  for (const row of GRID_ROWS) {
    if (!Array.isArray(g[row]) || g[row].length !== 5 || !g[row].every((v) => v === null || num(v, 0, 100))) return 'Bad grid.';
  }
  return null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- HTTP plumbing ---

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return '*';
  return allowed.includes(origin) ? origin : allowed[0];
}

function cors(request, env) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(request, env),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(request, env) } });
}

function fail(request, env, code, message, status) {
  return json(request, env, { error: code, message }, status);
}

// in-memory, per isolate: enough to blunt a burst
const hits = new Map();
function rateLimited(ip, bucket, limit) {
  const now = Date.now(), key = `${bucket}:${ip}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  const over = recent.length >= limit;
  if (!over) recent.push(now);
  hits.set(key, recent);
  return over;
}

// --- routes ---

async function handleSession(request, env, ip) {
  if (rateLimited(ip, 'session', 30)) return fail(request, env, 'rate_limited', 'Too many new sessions from here.', 429);
  const playerId = crypto.randomUUID(), token = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO players (id, token_hash, created_at) VALUES (?, ?, ?)')
    .bind(playerId, await sha256Hex(token), new Date().toISOString()).run();
  return json(request, env, { playerId, token });
}

async function verifyPlayer(env, playerId, token) {
  if (typeof playerId !== 'string' || typeof token !== 'string' || !playerId || !token) return false;
  const row = await env.DB.prepare('SELECT token_hash FROM players WHERE id = ?').bind(playerId).first();
  return !!row && row.token_hash === (await sha256Hex(token));
}

/** Best result per player for a day's on-time (late=0) or archive (late=1) board. */
export async function fetchBoard(env, day, late, playerId) {
  const { results } = await env.DB.prepare(
    `SELECT id, player_id, display_name, score, accuracy, stability, held, grid, submitted_at
       FROM results WHERE day_key = ? AND is_late = ?
      ORDER BY score DESC, submitted_at ASC, id ASC`,
  ).bind(day, late ? 1 : 0).all();
  const best = new Map(), attempts = new Map();
  for (const r of results ?? []) {
    attempts.set(r.player_id, (attempts.get(r.player_id) ?? 0) + 1);
    if (!best.has(r.player_id)) best.set(r.player_id, r); // first row per player = their best (ties: earliest)
  }
  const ranked = [...best.values()];
  const view = (r, i) => ({
    rank: i + 1, name: r.display_name, score: r.score, accuracy: r.accuracy, stability: r.stability, held: r.held,
    grid: JSON.parse(r.grid), attempts: attempts.get(r.player_id), submittedAt: r.submitted_at, you: r.player_id === playerId,
  });
  const top = ranked.slice(0, BOARD_SIZE).map(view);
  const yi = playerId ? ranked.findIndex((r) => r.player_id === playerId) : -1;
  return { day, late: !!late, pose: poseForDay(day), players: ranked.length, top, you: yi >= BOARD_SIZE ? view(ranked[yi], yi) : null };
}

async function handleLeaderboard(request, env) {
  const url = new URL(request.url);
  const day = url.searchParams.get('day') || todayKey();
  if (!validDay(day)) return fail(request, env, 'bad_day', 'Invalid day.', 400);
  return json(request, env, await fetchBoard(env, day, url.searchParams.get('late') === '1', url.searchParams.get('playerId')));
}

/** Archive summary: on-time player count and top score per day in [from, to]. */
async function handleDays(request, env) {
  const url = new URL(request.url);
  const to = url.searchParams.get('to') || todayKey();
  const from = url.searchParams.get('from') || '2000-01-01';
  if (!validDay(from) || !validDay(to)) return fail(request, env, 'bad_day', 'Invalid day.', 400);
  const { results } = await env.DB.prepare(
    `SELECT day_key, is_late, COUNT(DISTINCT player_id) AS players, MAX(score) AS top
       FROM results WHERE day_key BETWEEN ? AND ? GROUP BY day_key, is_late`,
  ).bind(from, to).all();
  const days = {};
  for (const r of results ?? []) {
    days[r.day_key] ??= { players: 0, top: null, latePlayers: 0 };
    if (r.is_late) days[r.day_key].latePlayers = r.players;
    else Object.assign(days[r.day_key], { players: r.players, top: r.top });
  }
  return json(request, env, { days });
}

async function handleSubmit(request, env, ip) {
  if (rateLimited(ip, 'submit', 60)) return fail(request, env, 'rate_limited', 'Too many submissions from here. Try again later.', 429);
  let body;
  try { body = await request.json(); } catch { return fail(request, env, 'bad_request', 'Invalid JSON.', 400); }
  const { playerId, token } = body ?? {};
  if (!(await verifyPlayer(env, playerId, token))) return fail(request, env, 'bad_session', 'Invalid or missing session. Reload the page.', 401);
  const today = todayKey();
  const day = body.day;
  if (!validDay(day)) return fail(request, env, 'bad_day', 'Invalid day.', 400);
  if (day > today) return fail(request, env, 'bad_day', "That day hasn't happened yet.", 400);
  if (body.pose !== poseForDay(day)) return fail(request, env, 'wrong_pose', "That isn't the pose for that day. Refresh the page.", 409);
  const name = validateName(body.name);
  if (!name) return fail(request, env, 'bad_name', `Name must be 1-${MAX_NAME} characters.`, 400);
  const problem = checkResult(body);
  if (problem) return fail(request, env, 'bad_result', problem, 400);
  const late = day !== today ? 1 : 0;
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM results WHERE player_id = ? AND day_key = ? AND is_late = ?')
    .bind(playerId, day, late).first();
  if ((count?.n ?? 0) >= MAX_ATTEMPTS) return fail(request, env, 'too_many', `You've already submitted ${MAX_ATTEMPTS} times for this day.`, 409);
  const grid = Object.fromEntries(GRID_ROWS.map((k) => [k, body.grid[k].map((v) => (v === null ? null : Math.round(v)))]));
  try {
    await env.DB.prepare(
      `INSERT INTO results (id, player_id, day_key, pose_id, attempt_number, display_name, score, accuracy, stability, held, grid, submitted_at, is_late)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), playerId, day, body.pose, (count?.n ?? 0) + 1, name, body.score, body.accuracy, body.stability,
      body.held, JSON.stringify(grid), new Date().toISOString(), late).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail(request, env, 'conflict', 'Submitted twice at once. Try again.', 409);
    throw e;
  }
  return json(request, env, { ok: true, late: !!late, board: await fetchBoard(env, day, late, playerId) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request, env) });
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    try {
      if (url.pathname === '/api/session' && request.method === 'POST') return await handleSession(request, env, ip);
      if (url.pathname === '/api/leaderboard' && request.method === 'GET') return await handleLeaderboard(request, env);
      if (url.pathname === '/api/days' && request.method === 'GET') return await handleDays(request, env);
      if (url.pathname === '/api/submit' && request.method === 'POST') return await handleSubmit(request, env, ip);
      return fail(request, env, 'not_found', 'No such endpoint.', 404);
    } catch (err) {
      console.error(err);
      return fail(request, env, 'server_error', 'Something broke. Try again.', 500);
    }
  },
};
