// Browser benchmark harness for Yogle Phase 1.
// Every adapter returns { kps: [[x, y, score] x 17 COCO], world?: [[x, y, z] x 17] } in pixel coords.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-webgpu';
import * as poseDetection from '@tensorflow-models/pose-detection';
import * as ort from 'onnxruntime-web/webgpu';

const MP_TO_COCO = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const TFJS_BP_TO_COCO = MP_TO_COCO; // BlazePose tfjs uses the same 33-point topology

// ---------- MediaPipe Tasks ----------
async function mediapipe(variant, delegate) {
  const fileset = await FilesetResolver.forVisionTasks('/node_modules/@mediapipe/tasks-vision/wasm');
  const make = (runningMode) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `/models/pose_landmarker_${variant}.task`, delegate },
    runningMode, numPoses: 1,
  });
  const video = await make('VIDEO');
  let image = null;
  let ts = 0;
  const conv = (res, w, h) => {
    if (!res.landmarks.length) return null;
    const lm = res.landmarks[0], wl = res.worldLandmarks[0];
    return {
      kps: MP_TO_COCO.map((i) => [lm[i].x * w, lm[i].y * h, lm[i].visibility ?? 0]),
      world: MP_TO_COCO.map((i) => [wl[i].x, wl[i].y, wl[i].z]),
      native33: lm.map((p) => [p.x * w, p.y * h, p.z, p.visibility ?? 0, p.presence ?? null]),
    };
  };
  return {
    // sequential frames: tracking mode (what the game will use)
    async video(src) { ts += 33; return conv(video.detectForVideo(src, ts), src.width, src.height); },
    // independent stills
    async image(src) { image ??= await make('IMAGE'); return conv(image.detect(src), src.width, src.height); },
  };
}

// ---------- TF.js pose-detection ----------
async function tfjsModel(kind, variant, backend) {
  await tf.setBackend(backend);
  await tf.ready();
  let det;
  if (kind === 'movenet') {
    det = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
      modelType: variant === 'thunder' ? poseDetection.movenet.modelType.SINGLEPOSE_THUNDER : poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
      modelUrl: `/models/tfjs/movenet-${variant}/model.json`, enableSmoothing: true,
    });
  } else {
    det = await poseDetection.createDetector(poseDetection.SupportedModels.BlazePose, {
      runtime: 'tfjs', modelType: variant, enableSmoothing: true,
      detectorModelUrl: '/models/tfjs/blazepose-detector/model.json',
      landmarkModelUrl: `/models/tfjs/blazepose-${variant}/model.json`,
    });
  }
  const run = async (src, still) => {
    const poses = await det.estimatePoses(src, still ? { flipHorizontal: false } : undefined, still ? undefined : performance.now());
    if (!poses.length) return null;
    const k = poses[0].keypoints;
    const out = kind === 'movenet'
      ? { kps: k.map((p) => [p.x, p.y, p.score ?? 0]) }
      : { kps: TFJS_BP_TO_COCO.map((i) => [k[i].x, k[i].y, k[i].score ?? 0]) };
    if (poses[0].keypoints3D) out.world = TFJS_BP_TO_COCO.map((i) => { const p = poses[0].keypoints3D[i]; return [p.x, p.y, p.z]; });
    return out;
  };
  return {
    async video(src) { return run(src, false); },
    async image(src) { det.reset?.(); return run(src, true); },
  };
}

// ---------- ONNX Runtime Web: RTMPose (top-down) and RTMO (one-stage) ----------
const canvas = (w, h) => { const c = new OffscreenCanvas(w, h); return [c, c.getContext('2d', { willReadFrequently: true })]; };

function letterboxBGR(src, size) {
  const r = Math.min(size / src.height, size / src.width);
  const [, ctx] = canvas(size, size);
  ctx.fillStyle = 'rgb(114,114,114)'; ctx.fillRect(0, 0, size, size);
  ctx.drawImage(src, 0, 0, Math.floor(src.width * r), Math.floor(src.height * r));
  const d = ctx.getImageData(0, 0, size, size).data, n = size * size, t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { t[i] = d[4 * i + 2]; t[n + i] = d[4 * i + 1]; t[2 * n + i] = d[4 * i]; }
  return { tensor: new ort.Tensor('float32', t, [1, 3, size, size]), r };
}

async function session(file, ep) {
  const opts = { executionProviders: [ep], graphOptimizationLevel: 'all' };
  return ort.InferenceSession.create(`/models/onnx/${file}`, opts);
}

async function rtmpose(size, prec, ep, detMode) {
  ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1;
  const det = await session(`yolox-tiny.${prec}.onnx`, ep);
  const pose = await session(`rtmpose-${size}.${prec}.onnx`, ep);
  const W = 192, H = 256, MEAN = [123.675, 116.28, 103.53], STD = [58.395, 57.12, 57.375];
  let lastBox = null;

  async function detect(src) {
    const { tensor, r } = letterboxBGR(src, 416);
    const out = await det.run({ input: tensor });
    const dets = out.dets.data, labels = out.labels.data;
    let best = null, bestArea = 0;
    for (let i = 0; i < labels.length; i++) {
      if (Number(labels[i]) !== 0 || dets[5 * i + 4] < 0.3) continue;
      const b = [dets[5 * i] / r, dets[5 * i + 1] / r, dets[5 * i + 2] / r, dets[5 * i + 3] / r];
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a > bestArea) { bestArea = a; best = b; }
    }
    return best;
  }

  async function estimate(src, box) {
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    let sw = (box[2] - box[0]) * 1.25, sh = (box[3] - box[1]) * 1.25;
    if (sw > sh * W / H) sh = sw * H / W; else sw = sh * W / H;
    const [, ctx] = canvas(W, H);
    ctx.fillStyle = 'black'; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(W / sw, 0, 0, H / sh, W / 2 - cx * W / sw, H / 2 - cy * H / sh);
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data, n = W * H, t = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) t[c * n + i] = (d[4 * i + c] - MEAN[c]) / STD[c];
    const out = await pose.run({ input: new ort.Tensor('float32', t, [1, 3, H, W]) });
    const sx = out.simcc_x.data, sy = out.simcc_y.data, K = 17, LX = 2 * W, LY = 2 * H;
    const kps = [];
    for (let k = 0; k < K; k++) {
      let mx = -1e9, ix = 0, my = -1e9, iy = 0;
      for (let i = 0; i < LX; i++) if (sx[k * LX + i] > mx) { mx = sx[k * LX + i]; ix = i; }
      for (let i = 0; i < LY; i++) if (sy[k * LY + i] > my) { my = sy[k * LY + i]; iy = i; }
      kps.push([cx + (ix / 2 / W - 0.5) * sw, cy + (iy / 2 / H - 0.5) * sh, Math.min(mx, my)]);
    }
    return kps;
  }

  const boxFromKps = (kps) => {
    const v = kps.filter((p) => p[2] > 0.3);
    if (v.length < 6) return null;
    const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
    const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
    const px = (x2 - x1) * 0.1, py = (y2 - y1) * 0.1;
    return [x1 - px, y1 - py, x2 + px, y2 + py];
  };

  return {
    // detMode 'every': detector on every frame. 'track': detector only when the previous frame's keypoints are lost.
    async video(src) {
      let box = detMode === 'track' ? lastBox : null;
      if (!box) box = await detect(src);
      if (!box) { lastBox = null; return null; }
      const kps = await estimate(src, box);
      lastBox = boxFromKps(kps);
      return { kps };
    },
    async image(src) { const box = await detect(src); return box ? { kps: await estimate(src, box) } : null; },
  };
}

async function rtmo(prec, ep) {
  ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1;
  const s = await session(`rtmo-s.${prec}.onnx`, ep);
  const run = async (src) => {
    const { tensor, r } = letterboxBGR(src, 640);
    const out = await s.run({ input: tensor });
    const dets = out.dets.data, kp = out.keypoints.data, N = out.dets.dims[1];
    let best = -1, bestArea = 0;
    for (let i = 0; i < N; i++) {
      if (dets[5 * i + 4] < 0.3) continue;
      const a = (dets[5 * i + 2] - dets[5 * i]) * (dets[5 * i + 3] - dets[5 * i + 1]);
      if (a > bestArea) { bestArea = a; best = i; }
    }
    if (best < 0) return null;
    const kps = [];
    for (let k = 0; k < 17; k++) { const o = (best * 17 + k) * 3; kps.push([kp[o] / r, kp[o + 1] / r, kp[o + 2]]); }
    return { kps };
  };
  return { video: run, image: run };
}

// ---------- registry ----------
const MODELS = {
  'mp-lite-gpu': () => mediapipe('lite', 'GPU'), 'mp-full-gpu': () => mediapipe('full', 'GPU'), 'mp-heavy-gpu': () => mediapipe('heavy', 'GPU'),
  'mp-lite-cpu': () => mediapipe('lite', 'CPU'), 'mp-full-cpu': () => mediapipe('full', 'CPU'), 'mp-heavy-cpu': () => mediapipe('heavy', 'CPU'),
  'movenet-lightning-webgl': () => tfjsModel('movenet', 'lightning', 'webgl'), 'movenet-thunder-webgl': () => tfjsModel('movenet', 'thunder', 'webgl'),
  'movenet-lightning-webgpu': () => tfjsModel('movenet', 'lightning', 'webgpu'), 'movenet-thunder-webgpu': () => tfjsModel('movenet', 'thunder', 'webgpu'),
  'tfjs-blazepose-lite-webgl': () => tfjsModel('blazepose', 'lite', 'webgl'), 'tfjs-blazepose-full-webgl': () => tfjsModel('blazepose', 'full', 'webgl'),
  'tfjs-blazepose-heavy-webgl': () => tfjsModel('blazepose', 'heavy', 'webgl'), 'tfjs-blazepose-full-webgpu': () => tfjsModel('blazepose', 'full', 'webgpu'),
};
for (const size of ['s', 'm']) for (const prec of ['fp32', 'fp16', 'int8']) for (const ep of ['webgpu', 'wasm']) for (const dm of ['every', 'track']) {
  MODELS[`rtmpose-${size}-${prec}-${ep}-${dm}`] = () => rtmpose(size, prec, ep, dm);
}
for (const prec of ['fp32', 'fp16', 'int8']) for (const ep of ['webgpu', 'wasm']) MODELS[`rtmo-s-${prec}-${ep}`] = () => rtmo(prec, ep);

async function loadBitmap(url) { const b = await (await fetch(url)).blob(); return createImageBitmap(b); }

window.listModels = () => Object.keys(MODELS);
window.envInfo = async () => {
  const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  return { ua: navigator.userAgent, coi: self.crossOriginIsolated, cores: navigator.hardwareConcurrency, webgpu: !!a, adapter: a ? (a.info ? { ...a.info, vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null) : null, f16: a ? a.features.has('shader-f16') : false };
};

// mode 'fps': sequential frames through .video(); mode 'images': independent stills through .image()
window.runBench = async ({ model, mode, frames, warmup = 10, repeat = 1 }) => {
  const t0 = performance.now();
  const m = await MODELS[model]();
  const tInit = performance.now() - t0;
  const bitmaps = [];
  for (const f of frames) bitmaps.push(await loadBitmap(f));
  const t1 = performance.now();
  const first = await (mode === 'fps' ? m.video(bitmaps[0]) : m.image(bitmaps[0]));
  const tFirst = performance.now() - t1;
  const results = [];
  const times = [];
  if (mode === 'fps') {
    for (let i = 0; i < warmup; i++) await m.video(bitmaps[i % bitmaps.length]);
    for (let rep = 0; rep < repeat; rep++) for (let i = 0; i < bitmaps.length; i++) {
      const s = performance.now();
      const r = await m.video(bitmaps[i]);
      times.push(performance.now() - s);
      if (rep === 0) results.push(r);
    }
  } else {
    results.push(first);
    for (let i = 1; i < bitmaps.length; i++) {
      const s = performance.now();
      results.push(await m.image(bitmaps[i]));
      times.push(performance.now() - s);
    }
  }
  return { model, mode, tInit, tFirst, times, results, backend: tf.getBackend?.() };
};
window.benchReady = true;
