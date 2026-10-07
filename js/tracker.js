// MediaPipe Pose Landmarker wrapper. Everything runs on this device; frames are never uploaded.
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const WASM = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = {
  full: new URL('../models/pose_landmarker_full.task', import.meta.url).href,
  lite: new URL('../models/pose_landmarker_lite.task', import.meta.url).href,
};

export class Tracker {
  constructor() {
    this.landmarker = null;
    this.variant = null;
    this.delegate = null;
    this.fileset = null;
    this.lastTs = 0;
  }

  /** Load a model. Tries the GPU first, then the CPU. */
  async load(variant = 'full') {
    this.fileset ??= await FilesetResolver.forVisionTasks(WASM);
    const old = this.landmarker;
    let lastErr;
    for (const delegate of ['GPU', 'CPU']) {
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(this.fileset, {
          baseOptions: { modelAssetPath: MODEL_URL[variant], delegate },
          runningMode: 'VIDEO', numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        this.variant = variant;
        this.delegate = delegate;
        old?.close();
        return this;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  /** Run on the current video frame. Returns null when no person is found. */
  detect(video) {
    if (!this.landmarker || video.readyState < 2) return null;
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1; // MediaPipe needs strictly increasing timestamps
    this.lastTs = ts;
    const res = this.landmarker.detectForVideo(video, ts);
    if (!res.landmarks?.length) return null;
    const W = video.videoWidth, H = video.videoHeight;
    const lm = res.landmarks[0];
    return {
      norm: lm,                                              // 0..1 image coords
      pts: lm.map((p) => ({ x: p.x * W, y: p.y * H })),     // pixels, aspect-correct, unmirrored
      vis: lm.map((p) => p.visibility ?? 0),
      world: res.worldLandmarks?.[0] ?? null,
      W, H,
    };
  }
}
