// Yogle: screens, camera loop and game flow.
import { features } from './angles.js';
import { matchPose, visibleFeatures, HoldSession, CONFIG, shareText } from './scoring.js';
import { utcDateString, dayNumber, entryFor } from './daily.js';
import { Figure3D, drawSkeleton2D, ghostPoints, BONE_FEATURE } from './figure.js';
import { Tracker } from './tracker.js';
import * as store from './storage.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const MAX_PLAY_SECONDS = 120;
const LOW_FPS = 12;

let LIB = null, SCHED = null;
let today = null, todayPose = null;
let homeFigure = null, miniFigure = null;
const tracker = new Tracker();
let modelPromise = null;
let game = null; // current run

const poseById = (id) => LIB.poses.find((p) => p.id === id);
const viewText = (pose) => (pose.view === 'front' ? 'Face the camera' : 'Side-on to the camera');
const swapName = (f) => (f.startsWith('l_') ? 'r_' + f.slice(2) : f.startsWith('r_') ? 'l_' + f.slice(2) : f);
const PART_NAME = { torso: 'body angle', upper_arm: 'upper arm', forearm: 'forearm', thigh: 'thigh', shin: 'lower leg' };
function partLabel(f) {
  if (f === 'torso') return 'body angle';
  const side = f.startsWith('l_') ? 'left' : 'right';
  return `${side} ${PART_NAME[f.slice(2)]}`;
}

function show(screen) {
  for (const s of ['home', 'play', 'result']) $('screen-' + s).hidden = s !== screen;
  document.querySelector('.top').hidden = screen === 'play';
  document.querySelector('.foot').hidden = screen === 'play';
  if (screen !== 'play') window.scrollTo(0, 0);
}

// ---------- home ----------
async function init() {
  try {
    [LIB, SCHED] = await Promise.all([
      fetch('data/poses.json').then((r) => r.json()),
      fetch('data/schedule.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  } catch (e) {
    $('daynum').textContent = 'Could not load the pose library. Please reload.';
    return;
  }
  today = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : utcDateString();
  todayPose = poseById(entryFor(today, SCHED, LIB.poses).pose);
  homeFigure = new Figure3D($('figure'));
  renderHome();

  const sel = $('practice-select');
  for (const p of LIB.poses) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name}: ${p.difficulty.toFixed(1)}/10 · ${p.focus}${p.advanced ? ' · advanced' : ''}`;
    sel.append(o);
  }
  const showFigure = () => {
    const p = $('practice').open ? poseById(sel.value) : todayPose;
    homeFigure.set(p, LIB.skeleton_landmarks);
    $('figure-caption').textContent = $('practice').open ? `Showing practice pose: ${p.name} (${viewText(p).toLowerCase()})` : 'Drag to rotate · orange = left side, blue = right side';
  };
  sel.addEventListener('change', showFigure);
  $('practice').addEventListener('toggle', showFigure);
  $('btn-start').addEventListener('click', () => begin(todayPose, false));
  $('btn-practice').addEventListener('click', () => begin(poseById(sel.value), true));
  $('btn-quit').addEventListener('click', () => finish(true));
  $('btn-home').addEventListener('click', () => { show('home'); renderHome(); });
  $('btn-again').addEventListener('click', () => begin(game.pose, game.practice));
  $('btn-share').addEventListener('click', share);
  if (params.get('pose') && poseById(params.get('pose'))) { sel.value = params.get('pose'); $('practice').open = true; }
}

function renderHome() {
  const n = dayNumber(today);
  const nice = new Date(today + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  $('daynum').textContent = `Yogle #${n} · ${nice}`;
  $('today-title').textContent = todayPose.name;
  $('today-meta').textContent = `Difficulty ${todayPose.difficulty.toFixed(1)}/10 · ${cap(todayPose.focus)} · ${viewText(todayPose)}`;
  $('advanced-warning').hidden = !todayPose.advanced;
  homeFigure.set(todayPose, LIB.skeleton_landmarks);
  const done = store.getDaily(today);
  $('done-today').hidden = !done;
  if (done) $('done-today').textContent = `Today's best: ${done.score}/100. You can try again to beat it.`;
  const s = store.stats(today);
  $('stats').innerHTML = `<div><b>${s.played}</b><span>Played</span></div><div><b>${s.streak}</b><span>Streak</span></div><div><b>${s.bestStreak}</b><span>Best streak</span></div><div><b>${s.average ?? '–'}</b><span>Average</span></div>`;
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---------- game ----------
async function begin(pose, practice) {
  if (!store.getFlag('agreed')) {
    const dlg = $('disclaimer');
    const ok = await new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
    if (!ok) return;
    store.setFlag('agreed');
  }
  show('play');
  game = { pose, practice, phase: 'loading', session: null, okSince: null, start: null, raf: 0, stream: null,
    frames: [], snap: null, snapBest: -1, snapT: 0, lastHint: '', lastHintT: 0, ended: false, switching: false };
  setStatus('Starting the camera…');
  $('match-threshold').style.left = CONFIG.MATCH_THRESHOLD + '%';
  miniFigure ??= new Figure3D($('mini-figure'), { autoRotate: false });
  miniFigure.set(pose, LIB.skeleton_landmarks);
  $('mini-name').textContent = `${pose.name} · ${pose.view}`;
  updateMeters(0, 0);

  const video = $('video');
  try {
    game.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    setStatus(e.name === 'NotAllowedError' ? 'Camera permission was blocked. Allow camera access in your browser settings, then try again.' : 'No camera found, or it is in use by another app.');
    return;
  }
  video.srcObject = game.stream;
  await video.play().catch(() => {});
  await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  setStatus('Loading the pose model (about 10 MB, first time only)…');
  try {
    modelPromise ??= tracker.load('full');
    await modelPromise;
  } catch (e) {
    modelPromise = null;
    setStatus('Sorry, pose tracking could not start on this browser. Try an up-to-date Chrome or Safari.');
    return;
  }
  if (game.ended) return;
  const ov = $('overlay');
  ov.width = video.videoWidth; ov.height = video.videoHeight;
  game.phase = 'framing';
  game.lastVideoTime = -1;
  loop();
}

function loop() {
  if (!game || game.ended) return;
  game.raf = requestAnimationFrame(loop);
  const video = $('video');
  if (game.switching || video.currentTime === game.lastVideoTime) return;
  game.lastVideoTime = video.currentTime;
  const now = performance.now();
  const r = tracker.detect(video);
  game.frames.push(now);
  while (game.frames.length && now - game.frames[0] > 3000) game.frames.shift();
  const fps = game.frames.length > 5 ? (game.frames.length - 1) / ((now - game.frames[0]) / 1000) : 0;
  if (DEBUG) { $('perf').hidden = false; $('perf').textContent = `${fps.toFixed(0)} fps · ${tracker.variant} · ${tracker.delegate}`; }
  maybeDowngrade(fps, now);

  const ov = $('overlay'), ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  const lw = Math.max(4, ov.height / 110);

  if (game.phase === 'framing') {
    if (r) drawSkeleton2D(ctx, r.pts, { width: lw, colourFor: () => 'rgba(255,255,255,0.9)' });
    const adv = framingAdvice(r);
    if (adv.ok) {
      game.okSince ??= now;
      setStatus(`Good, I can see you. ${viewText(game.pose)}.`);
      if (now - game.okSince > 1200) { game.phase = 'posing'; game.session = new HoldSession(); game.start = now; }
    } else { game.okSince = null; setStatus(adv.text); }
    return;
  }

  // posing
  let frame = null, m = null;
  if (r) {
    const feat = features(r.pts);
    m = matchPose(feat, visibleFeatures(r.vis), game.pose);
    frame = { ...m, feat };
  }
  const state = game.session.update(now / 1000, frame);
  // ghost: target placed on the player's hips, scaled to their torso
  const anchor = anchorFor(r, ov);
  const ghost = ghostPoints(game.pose, LIB.skeleton_landmarks, anchor, m ? m.mirrored : false);
  drawSkeleton2D(ctx, ghost, { width: lw * 1.6, colourFor: () => 'rgba(255,255,255,0.45)' });
  if (r) {
    const renamed = m.mirrored !== m.swapped;
    drawSkeleton2D(ctx, r.pts, {
      width: lw, colourFor: (bone) => {
        const f = BONE_FEATURE[bone];
        if (!f) return '#9ee6a8';
        const res = m.per[renamed ? swapName(f) : f];
        if (!res) return 'rgba(200,200,200,0.7)';
        return res.score >= 0.85 ? '#4cc26b' : res.score >= 0.5 ? '#f2c14e' : '#ff5a5a';
      },
    });
  }
  updateMeters(m ? m.score : 0, game.session.held / CONFIG.HOLD_SECONDS);
  setStatus(postureMessage(state, m, now));
  if (m && game.session.state === 'holding' && m.score > game.snapBest + 1 && now - game.snapT > 300) takeSnapshot(m.score, now);
  if (state === 'done' || (now - game.start) / 1000 > MAX_PLAY_SECONDS) finish(false);
}

async function maybeDowngrade(fps, now) {
  if (game.downgraded || tracker.variant !== 'full') return;
  game.fpsSince ??= now;
  if (now - game.fpsSince < 4000 || fps === 0 || fps >= LOW_FPS) return;
  game.downgraded = true;
  game.switching = true;
  setStatus('Switching to a lighter pose model for this device…');
  try { modelPromise = tracker.load('lite'); await modelPromise; } catch { /* keep going with full */ }
  game.switching = false;
}

function anchorFor(r, ov) {
  if (!r) return { x: ov.width / 2, y: ov.height * 0.55, scale: ov.height * 0.2 };
  const p = r.pts;
  const hx = (p[23].x + p[24].x) / 2, hy = (p[23].y + p[24].y) / 2;
  const sx = (p[11].x + p[12].x) / 2, sy = (p[11].y + p[12].y) / 2;
  return { x: hx, y: hy, scale: Math.max(Math.hypot(sx - hx, sy - hy), ov.height * 0.12) };
}

function framingAdvice(r) {
  if (!r) return { ok: false, text: 'Step into view. Prop your device up so it can see your whole body.' };
  const n = r.norm, v = r.vis;
  const inFrame = (i) => v[i] >= 0.5 && n[i].x > 0.01 && n[i].x < 0.99 && n[i].y > 0.01 && n[i].y < 0.99;
  if (![27, 28].some(inFrame) || ![25, 26].some(inFrame)) return { ok: false, text: 'Step back or tilt the camera down: I can\'t see your feet.' };
  if (!inFrame(0) || ![11, 12].every(inFrame)) return { ok: false, text: 'Step back: your head or shoulders are cut off.' };
  if (![23, 24].every(inFrame)) return { ok: false, text: 'Move to the middle of the picture.' };
  const ys = [0, 11, 12, 23, 24, 25, 26, 27, 28].filter(inFrame).map((i) => n[i].y);
  if (Math.max(...ys) - Math.min(...ys) < 0.35) return { ok: false, text: 'Come a little closer so you fill more of the picture.' };
  return { ok: true };
}

function postureMessage(state, m, now) {
  const left = Math.max(0, Math.ceil(CONFIG.HOLD_SECONDS - game.session.held));
  if (state === 'holding') return `Hold it! ${left}s`;
  if (!m) return state === 'paused' ? 'I lost you. Step back into view.' : 'Step back into view.';
  if (m.coverage < CONFIG.MIN_COVERAGE) return 'I can\'t see all of you. Adjust the camera or your position.';
  // worst visible feature, named from the player's point of view; change the hint at most every 1.5 s
  let worst = null;
  for (const [f, res] of Object.entries(m.per)) if (res && game.pose.targets[f].weight > 0.3 && (!worst || res.score < worst[1].score)) worst = [f, res];
  let hint = 'Match the white outline.';
  if (worst && worst[1].score < 0.85) hint = `Nearly! Adjust your ${partLabel(m.mirrored !== m.swapped ? swapName(worst[0]) : worst[0])}.`;
  if (state === 'paused') hint = 'Back into the pose to keep the timer going. ' + hint;
  if (hint !== game.lastHint && now - game.lastHintT < 1500) return game.lastHint;
  game.lastHint = hint; game.lastHintT = now;
  return hint;
}

function updateMeters(score, frac) {
  $('match-val').textContent = score ? Math.round(score) + '%' : '–';
  $('match-bar').style.width = Math.max(0, Math.min(100, score)) + '%';
  $('match-bar').style.background = score >= CONFIG.MATCH_THRESHOLD ? '#4cc26b' : '#f2c14e';
  $('hold-ring').style.strokeDashoffset = String(119.4 * (1 - Math.min(1, frac)));
  $('hold-val').textContent = Math.floor(Math.min(1, frac) * CONFIG.HOLD_SECONDS);
}

function setStatus(text) { if ($('status').textContent !== text) $('status').textContent = text; }

function takeSnapshot(score, now) {
  const video = $('video'), ov = $('overlay');
  const c = game.snap ?? (game.snap = document.createElement('canvas'));
  const s = Math.min(1, 720 / Math.max(ov.width, ov.height));
  c.width = Math.round(ov.width * s); c.height = Math.round(ov.height * s);
  const ctx = c.getContext('2d');
  ctx.save(); ctx.translate(c.width, 0); ctx.scale(-1, 1); // mirrored, as the player saw it
  ctx.drawImage(video, 0, 0, c.width, c.height);
  ctx.drawImage(ov, 0, 0, c.width, c.height);
  ctx.restore();
  game.snapBest = score; game.snapT = now;
}

function stopCamera() {
  cancelAnimationFrame(game?.raf);
  game?.stream?.getTracks().forEach((t) => t.stop());
  $('video').srcObject = null;
}

function finish(quit) {
  if (!game || game.ended) return;
  game.ended = true;
  stopCamera();
  const s = game.session;
  if (!s || !s.samples.length) { show('home'); renderHome(); return; }
  const res = s.result();
  game.result = res;
  if (!game.practice && res.score > 0) store.recordDaily(today, { pose: game.pose.id, score: res.score, grid: res.grid });
  $('result-title').textContent = game.practice ? `Practice: ${game.pose.name}` : `Yogle #${dayNumber(today)}: ${game.pose.name}`;
  $('result-score').textContent = res.score;
  $('result-detail').textContent = `Accuracy ${res.accuracy} · Stillness ${res.stability} · Held ${res.held.toFixed(1)} of ${CONFIG.HOLD_SECONDS} s` + (quit && res.completion < 1 ? ' (stopped early)' : '');
  game.share = shareText({ dayNumber: dayNumber(today), poseName: game.pose.name, score: res.score, grid: res.grid, practice: game.practice });
  $('result-grid').textContent = game.share.split('\n').slice(1).join('\n');
  $('share-msg').textContent = '';
  if (game.snap) {
    const url = game.snap.toDataURL('image/jpeg', 0.85);
    $('snapshot').src = url; $('snapshot-save').href = url; $('snapshot-wrap').hidden = false;
  } else $('snapshot-wrap').hidden = true;
  show('result');
}

async function share() {
  const text = game.share + '\n' + location.origin + location.pathname;
  try {
    if (navigator.share) { await navigator.share({ text }); $('share-msg').textContent = 'Shared!'; return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); $('share-msg').textContent = 'Copied to clipboard.'; } catch { $('share-msg').textContent = 'Copy the grid above to share it.'; }
}

init();
