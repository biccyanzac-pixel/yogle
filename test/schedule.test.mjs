import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSchedule, MIN_GAP_DAYS } from '../tools/make_schedule.mjs';
import { weekdayMon0, addDays, entryFor } from '../site/js/daily.js';

const lib = JSON.parse(fs.readFileSync('site/data/poses.json', 'utf8'));
const committed = JSON.parse(fs.readFileSync('site/data/schedule.json', 'utf8'));
const byId = new Map(lib.poses.map((p) => [p.id, p]));
const entries = Object.entries(committed.days).sort(([a], [b]) => a.localeCompare(b));

test('committed schedule is exactly what the generator produces (regenerate with npm run schedule)', () => {
  const fresh = makeSchedule(lib.poses, committed.start, entries.length, committed.seed);
  assert.deepEqual(fresh.days, committed.days);
});

test('schedule covers at least 2 years with consecutive dates and known poses', () => {
  assert.ok(entries.length >= 730);
  entries.forEach(([date, e], i) => {
    if (i) assert.equal(date, addDays(entries[i - 1][0], 1));
    assert.ok(byId.has(e.pose), e.pose);
  });
});

test(`no pose repeats within ${MIN_GAP_DAYS} days`, () => {
  const last = new Map();
  entries.forEach(([, e], i) => {
    if (last.has(e.pose)) assert.ok(i - last.get(e.pose) >= MIN_GAP_DAYS, `${e.pose} repeats after ${i - last.get(e.pose)} days`);
    last.set(e.pose, i);
  });
});

test('consecutive days have a different body focus', () => {
  for (let i = 1; i < entries.length; i++) assert.notEqual(byId.get(entries[i][1].pose).focus, byId.get(entries[i - 1][1].pose).focus, entries[i][0]);
});

test('difficulty rises through the week (Mon easiest, Sun hardest)', () => {
  const sums = Array(7).fill(0), n = Array(7).fill(0);
  for (const [date, e] of entries) { const w = weekdayMon0(date); sums[w] += byId.get(e.pose).difficulty; n[w]++; }
  const means = sums.map((s, i) => s / n[i]);
  for (let w = 1; w < 7; w++) assert.ok(means[w] > means[w - 1], `weekday means not rising: ${means.map((m) => m.toFixed(2))}`);
});

test('every date resolves to an entry, including after the schedule ends', () => {
  assert.equal(entryFor(entries[0][0], committed, lib.poses).pose, entries[0][1].pose);
  const after = entryFor(addDays(committed.end, 10), committed, lib.poses);
  assert.ok(byId.has(after.pose));
  assert.equal(after.fromSchedule, false);
});

test('KNOWN GAP: "no identical pose+modifier within a year" needs >= 365 combinations', { todo: lib.poses.length < 365 ? `only ${lib.poses.length} poses and no modifiers yet` : false }, () => {
  const seen = new Map();
  entries.forEach(([, e], i) => {
    const key = e.pose + '|' + (e.modifier ?? '');
    if (seen.has(key)) assert.ok(i - seen.get(key) >= 365, key);
    seen.set(key, i);
  });
});
