// Drawing: the rotatable 3D target figure and 2D skeleton overlays.

// Bones in MediaPipe landmark indices. side: 'l' | 'r' | 'c'
export const BONES = [
  [11, 12, 'c'], [11, 23, 'c'], [12, 24, 'c'], [23, 24, 'c'],
  [11, 13, 'l'], [13, 15, 'l'], [12, 14, 'r'], [14, 16, 'r'],
  [23, 25, 'l'], [25, 27, 'l'], [27, 29, 'l'], [29, 31, 'l'], [27, 31, 'l'],
  [24, 26, 'r'], [26, 28, 'r'], [28, 30, 'r'], [30, 32, 'r'], [28, 32, 'r'],
];
// Which scored feature a bone belongs to (for colouring the player's skeleton)
export const BONE_FEATURE = {
  '11-13': 'l_upper_arm', '13-15': 'l_forearm', '12-14': 'r_upper_arm', '14-16': 'r_forearm',
  '23-25': 'l_thigh', '25-27': 'l_shin', '24-26': 'r_thigh', '26-28': 'r_shin',
  '11-12': 'torso', '11-23': 'torso', '12-24': 'torso', '23-24': 'torso',
};

function cssVar(name, fallback) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
}

/** Map a pose's display skeleton (array aligned with landmarkIds) to a sparse 33-array of {x,y,z}. */
export function skeletonPoints(pose, landmarkIds) {
  const pts = [];
  pose.skeleton.forEach((p, i) => { pts[landmarkIds[i]] = { x: p[0], y: p[1], z: p[2] }; });
  return pts;
}

/** Rotatable 3D figure. Drag (or arrow keys) to rotate around the vertical axis. */
export class Figure3D {
  constructor(canvas, { autoRotate = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.yaw = 0;
    this.pts = null;
    this.dragging = false;
    this.auto = autoRotate && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.t0 = performance.now();
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.auto = false; this.lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (this.dragging) { this.yaw += (e.clientX - this.lastX) * 0.01; this.lastX = e.clientX; this.draw(); } });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { this.auto = false; this.yaw += e.key === 'ArrowLeft' ? -0.2 : 0.2; this.draw(); e.preventDefault(); }
    });
    const loop = () => {
      if (this.auto && this.pts) { this.yaw = 0.5 * Math.sin((performance.now() - this.t0) / 1800); this.draw(); }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  set(pose, landmarkIds) {
    this.pts = skeletonPoints(pose, landmarkIds);
    this.canvas.setAttribute('aria-label', `${pose.name}: figure showing the target pose. Use left and right arrow keys to rotate.`);
    this.yaw = 0;
    this.draw();
  }

  draw() {
    const { canvas, ctx, pts } = this;
    if (!pts) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const P = [];
    for (const i in pts) { const p = pts[i]; P[i] = { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c }; }
    // fit to canvas (use a fixed fit across rotation so the figure doesn't pulse)
    const all = Object.values(pts);
    const r = Math.max(...all.map((p) => Math.hypot(p.x, p.z))), ys = all.map((p) => p.y);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = 0.85 * Math.min(w / (2 * r + 0.3), h / (maxY - minY + 0.6));
    const cx = w / 2, cy = h / 2 - ((minY + maxY) / 2) * scale;
    const X = (p) => cx + p.x * scale, Y = (p) => cy + p.y * scale;
    // floor shadow
    ctx.fillStyle = cssVar('--shadow', 'rgba(0,0,0,0.12)');
    ctx.beginPath(); ctx.ellipse(cx, cy + maxY * scale + 6, r * scale, 8, 0, 0, Math.PI * 2); ctx.fill();
    const colour = { l: cssVar('--left', '#e4572e'), r: cssVar('--right', '#1f6feb'), c: cssVar('--ink', '#222') };
    const bones = BONES.filter(([a, b]) => P[a] && P[b]).map(([a, b, side]) => ({ a, b, side, z: (P[a].z + P[b].z) / 2 }));
    bones.sort((u, v) => v.z - u.z); // far first (larger z = further from viewer)
    ctx.lineCap = 'round';
    for (const { a, b, side, z } of bones) {
      ctx.strokeStyle = colour[side];
      ctx.globalAlpha = z > 0.1 ? 0.55 : 1;
      ctx.lineWidth = Math.max(4, scale * 0.09);
      ctx.beginPath(); ctx.moveTo(X(P[a]), Y(P[a])); ctx.lineTo(X(P[b]), Y(P[b])); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (P[0] && P[11] && P[12]) {
      const neck = { x: (P[11].x + P[12].x) / 2, y: (P[11].y + P[12].y) / 2 };
      ctx.strokeStyle = colour.c; ctx.lineWidth = Math.max(4, scale * 0.08);
      ctx.beginPath(); ctx.moveTo(X(neck), Y(neck)); ctx.lineTo(X(P[0]), Y(P[0])); ctx.stroke();
      ctx.fillStyle = colour.c;
      ctx.beginPath(); ctx.arc(X(P[0]), Y(P[0]), Math.max(7, scale * 0.16), 0, Math.PI * 2); ctx.fill();
    }
  }
}

/**
 * Draw a skeleton given 2D points (sparse array indexed by landmark id) onto a 2D context.
 * colourFor(boneKey) -> css colour or null to skip.
 */
export function drawSkeleton2D(ctx, pts, { width = 8, colourFor = () => '#fff', head = true, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  for (const [a, b] of BONES) {
    if (!pts[a] || !pts[b]) continue;
    const col = colourFor(`${a}-${b}`);
    if (!col) continue;
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke();
  }
  if (head && pts[0] && pts[11] && pts[12]) {
    const col = colourFor('11-12') || '#fff';
    ctx.strokeStyle = col; ctx.fillStyle = col;
    const nx = (pts[11].x + pts[12].x) / 2, ny = (pts[11].y + pts[12].y) / 2;
    ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(pts[0].x, pts[0].y); ctx.stroke();
    ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, width * 1.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/**
 * Place the target skeleton over the player: hips on the player's hips, scaled to the player's torso.
 * Returns a sparse array of {x,y} in the same (unmirrored) pixel space as the player's landmarks.
 */
export function ghostPoints(pose, landmarkIds, anchor, mirrored) {
  const out = [];
  pose.skeleton.forEach((p, i) => {
    const x = mirrored ? -p[0] : p[0];
    out[landmarkIds[i]] = { x: anchor.x + x * anchor.scale, y: anchor.y + p[1] * anchor.scale };
  });
  if (mirrored) { // the shape is mirrored; swap labels back so left/right colours stay anatomical
    const sw = [];
    for (const i in out) sw[swapIndex(+i)] = out[i];
    return sw;
  }
  return out;
}

function swapIndex(i) {
  if (i === 0) return 0;
  if (i >= 11) return i % 2 === 1 ? i + 1 : i - 1;
  return i;
}
