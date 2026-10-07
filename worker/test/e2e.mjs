/**
 * End-to-end test against a running worker (wrangler dev --local = real Miniflare + local D1, no mocks).
 *   npm run db:init:local && npm run dev:local      (in another terminal)
 *   npm test                                         (or: node test/e2e.mjs http://127.0.0.1:8787)
 */
import { entryFor, addDays } from '../../site/js/daily.js';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8797';
const schedule = JSON.parse(fs.readFileSync(new URL('../../site/data/schedule.json', import.meta.url)));
const lib = JSON.parse(fs.readFileSync(new URL('../../site/data/poses.json', import.meta.url)));
const today = new Date().toISOString().slice(0, 10);
const yesterday = addDays(today, -1);
const pose = (d) => entryFor(d, schedule, lib.poses).pose;

let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
async function call(path, body) {
  const res = await fetch(BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: res.status, body: await res.json() };
}
const grid = { arms: [90, 90, 80, 70, 60], legs: [100, 100, 100, 95, 90], torso: [80, 80, 85, 90, 95], steady: [100, 90, null, 80, 70] };
const result = (o = {}) => ({ day: today, pose: pose(today), name: 'Ada', score: 87, accuracy: 88, stability: 80, held: 10, grid, ...o });

const a = (await call('/api/session', {})).body, b = (await call('/api/session', {})).body;
check('session issues id + token', !!a.playerId && !!a.token && a.playerId !== b.playerId);

let r = await call('/api/submit', { ...a, ...result() });
check('valid submission accepted', r.status === 200 && r.body.ok && r.body.late === false, JSON.stringify(r.body).slice(0, 120));
check('board returned with you ranked', r.body.board?.top?.[0]?.you === true && r.body.board.top[0].score === 87);

r = await call('/api/submit', { ...a, ...result({ score: 60, accuracy: 60, stability: 60 }) });
check('worse second attempt accepted', r.status === 200);
r = await call('/api/leaderboard?day=' + today + '&playerId=' + a.playerId);
check('board keeps the best per player', r.body.top.length === 1 && r.body.top[0].score === 87 && r.body.top[0].attempts === 2);

r = await call('/api/submit', { ...b, ...result({ name: 'Bo', score: 95, accuracy: 95, stability: 95 }) });
r = await call('/api/leaderboard?day=' + today);
check('ranked by score', r.body.top.map((x) => x.name).join(',') === 'Bo,Ada', r.body.top.map((x) => x.name).join(','));
check('board shows pose quality, stillness, held, grid', r.body.top[0].accuracy === 95 && r.body.top[0].stability === 95 && r.body.top[0].held === 10 && Array.isArray(r.body.top[0].grid.arms));

check('wrong pose rejected', (await call('/api/submit', { ...a, ...result({ pose: 'definitely-not-a-pose' }) })).status === 409);
check('future day rejected', (await call('/api/submit', { ...a, ...result({ day: addDays(today, 1), pose: pose(addDays(today, 1)) }) })).status === 400);
check('invalid date rejected', (await call('/api/submit', { ...a, ...result({ day: '2026-02-30' }) })).status === 400);
check('inconsistent score rejected', (await call('/api/submit', { ...a, ...result({ score: 100 }) })).status === 400);
check('partial hold must scale the score', (await call('/api/submit', { ...a, ...result({ held: 5, score: 87 }) })).status === 400);
check('partial hold with matching score accepted', (await call('/api/submit', { ...a, ...result({ held: 5, score: 44 }) })).status === 200);
check('out-of-range rejected', (await call('/api/submit', { ...a, ...result({ accuracy: 140 }) })).status === 400);
check('bad grid rejected', (await call('/api/submit', { ...a, ...result({ grid: { arms: [1] } }) })).status === 400);
check('empty name rejected', (await call('/api/submit', { ...a, ...result({ name: '   ' }) })).status === 400);
check('forged token rejected', (await call('/api/submit', { playerId: a.playerId, token: b.token, ...result() })).status === 401);
check('unknown player rejected', (await call('/api/submit', { playerId: 'nope', token: 'nope', ...result() })).status === 401);

// archive replay of a past day goes on the separate late board
r = await call('/api/submit', { ...a, ...result({ day: yesterday, pose: pose(yesterday), score: 70, accuracy: 70, stability: 70 }) });
check('past day accepted as late', r.status === 200 && r.body.late === true);
const onDay = (await call('/api/leaderboard?day=' + yesterday)).body, lateB = (await call('/api/leaderboard?day=' + yesterday + '&late=1')).body;
check('late result not on the real board', !onDay.top.some((x) => x.name === 'Ada'));
check('late result on the late board', lateB.top.some((x) => x.name === 'Ada' && x.score === 70));
check('board reports that day\'s pose', onDay.pose === pose(yesterday));

// attempt cap
const c = (await call('/api/session', {})).body;
let last;
for (let i = 0; i < 11; i++) last = await call('/api/submit', { ...c, ...result({ name: 'Cy' }) });
check('11th submission for a day rejected', last.status === 409);

r = await call(`/api/days?from=${yesterday}&to=${today}`);
check('archive summary counts on-time and late players', r.body.days[today]?.players >= 3 && r.body.days[yesterday]?.latePlayers >= 1, JSON.stringify(r.body.days));

const opt = await fetch(BASE + '/api/submit', { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
check('CORS does not echo unknown origins', opt.headers.get('access-control-allow-origin') !== 'http://evil.example');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
