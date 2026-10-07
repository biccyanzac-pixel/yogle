# Yogle: pose-estimation model decision (Phase 1)

Status: **approved 2026-10-07** (MediaPipe full + lite fallback). See build-status.md for what was built. All numbers below were measured on 2026-10-06/07 with the harness in `bench/` unless marked *(published)* or *(estimate)*.

## Recommendation

**Use MediaPipe Pose Landmarker "full" (float16), via `@mediapipe/tasks-vision` 1.1.0, with the GPU delegate. Self-host the wasm runtime and the model file.**

- About **10.6 MB** to download (brotli): runtime 2.7 MB + model 7.8 MB. That is inside the 15 MB budget.
- **26 FPS** on a 2019 ultrabook's integrated GPU. It stays at **17 FPS with the CPU slowed 4×**, because the GPU path barely uses the CPU. No other candidate held up under CPU throttling.
- It gives **33 landmarks with 3D "world" coordinates**, including heels and toes, plus built-in tracking and smoothing. It had the lowest frame-to-frame jitter of the realistic options.
- Apache-2.0 (library and model card); maintained by Google (1.1.0 published 2026-10-06).
- **Fallback:** switch to the "lite" model (7.3 MB, 39 FPS) when a device can't sustain about 15 FPS after warm-up. Lite is clearly less accurate and noisier (see table), so the scorer should widen tolerances when it's in use.

Rejected, with the main reason:

- **MediaPipe heavy:** 30 MB.
- **TF.js MoveNet:** 2D only, CPU-bound in the browser, and the package has had no release since 2023. It is the runner-up.
- **TF.js BlazePose:** the same model family as MediaPipe, but 2.5–4× slower.
- **RTMPose / RTMO via ONNX Runtime Web:** most accurate on paper (with a caveat, see below). But the person detector, 4 MB runtime and fp32 weights total about 42 MB. int8 quantisation destroys accuracy, and **ORT's WebGPU backend silently produced wrong keypoints for 2 of 4 tested configurations**.
- **RTMW3D-x:** 369 MB.
- **Ultralytics YOLO-pose:** AGPL-3.0 (restrictive), so not evaluated. Ask first.

Main weakness of the pick: **MediaPipe loses people who face away from the camera, and people whose face is hidden while low to the floor** (back views, head-on lying, head-down all-fours). Its **visibility score is a poor predictor of its own errors.** Both are handled in the scoring design below rather than by switching model.

## Comparison table

Accuracy is measured against pseudo-ground-truth on 768 frames from "Yoga for all": 8 non-inversion poses, correct and incorrect execution, 4 camera views. **PCK@0.2** is the fraction of body keypoints within 20% of torso diameter, the same metric as the MediaPipe model card. **Angle error** is the absolute error of the 8 scoring angles (elbows, shoulders, hips, knees). FPS is sequential tracking on a 540×960 portrait clip. Sizes are brotli-compressed, runtime plus weights.

| Model (backend) | Output | Kpts | Download | Licence | FPS desktop | FPS, CPU 4× slower | Phone FPS *(estimate)* | PCK@0.2 | Angle err median / p90 | Angles off by >30° | Conf. predicts error (AUROC) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **MediaPipe full (GPU/WebGL)** | 2D + 3D world | 33 | **10.6 MB** | Apache-2.0 | **25.6** | **17.2** | 15–25 | 0.887 | 3.8° / 19.6° | 6.6% | 0.63 |
| MediaPipe lite (GPU) | 2D + 3D world | 33 | 7.3 MB | Apache-2.0 | 39.2 | 22.4 | 20–35 | 0.840 | 4.8° / 27.0° | 8.9% | 0.56 |
| MediaPipe heavy (GPU) | 2D + 3D world | 33 | 29.7 MB ✗ | Apache-2.0 | 17.0 | – | 8–15 | 0.902 | 3.5° / 16.9° | 5.9% | 0.53 |
| MediaPipe full (CPU/wasm) | 2D + 3D world | 33 | 10.6 MB | Apache-2.0 | 6.5 | 1.8 | <5 | same | same | same | same |
| MoveNet Lightning (TF.js WebGL) | 2D | 17 | 4.4 MB | Apache-2.0 | 32.0 | 11.6 | 10–25 | 0.884 | 4.1° / 23.1° | 8.0% | **0.90** |
| MoveNet Thunder (TF.js WebGL) | 2D | 17 | 11.3 MB | Apache-2.0 | 21.8 | 8.8 | 8–18 | 0.902 | 3.7° / 19.8° | 7.3% | 0.89 |
| BlazePose full (TF.js WebGL) | 2D + 3D | 33 | 8.4 MB | Apache-2.0 | 9.8 | – | <10 | 0.887 | 3.8° / 21.7° | 8.1% | 0.66 |
| RTMPose-s fp32 + YOLOX-tiny, box tracking (ORT wasm) | 2D | 17 | 41 MB ✗ | Apache-2.0 code/weights; training-data caveat† | 18.7 | 4.4 | 4–9 | 0.937‡ | 3.4° / 18.1°‡ | 6.4% | 0.85 |
| RTMPose-s fp32 (ORT WebGPU, box tracking) | 2D | 17 | 42.7 MB ✗ | † | 13.0 | – | ? | 0.937‡ | 3.4° / 18.1°‡ | 6.4% | 0.85 |
| RTMPose-s **fp16** (ORT WebGPU) | 2D | 17 | 22.6 MB | † | 6.0 (detector every frame) | – | ? | **0.513 ✗ broken** | 45° / 162° | 57% | – |
| RTMPose-s **int8** (ORT wasm) | 2D | 17 | 8.9 MB | † | 3.8 (detector every frame) | – | ? | **0.022 ✗ broken** | – | – | – |
| RTMPose-m fp16 (ORT WebGPU, box tracking) | 2D | 17 | 36.7 MB ✗ | † | 11.1 | – | ? | 0.966‡ | 2.5° / 12.1°‡ | 3.1% | 0.89 |
| RTMO-s fp32 (ORT WebGPU) | 2D | 17 | 40 MB ✗ | † | 2.3 | – | <2 | **0.619 ✗ wrong on WebGPU** | 20° / 103° | 40% | – |
| RTMO-s int8 (ORT wasm) | 2D | 17 | 8.9 MB | † | 2.0 | – | <2 | 0.859 | 5.1° / 29.3° | 9.8% | 0.72 |
| RTMW3D-x (ORT) | 3D | 133 | 369 MB ✗ | Apache-2.0 † | not run | – | – | – | – | – | – |
| Ultralytics YOLO11/26-pose | 2D | 17 | ~7–15 MB | **AGPL-3.0 ✗ (ask)** | not run | – | – | – | – | – | – |

✗ = disqualified for Yogle. † = mmpose code and weights are Apache-2.0, but the "body7" and "cocktail14" training mixes include datasets with research-only terms (e.g. AI Challenger, Halpe); this needs a licence review before shipping. ‡ = favoured by the evaluation, because the pseudo-GT comes from the same model family (see Limitations).

### Robustness on other data (PCK@0.2)

| Condition | MP lite | **MP full** | MoveNet L | MoveNet T | RTMPose-s‡ | RTMPose-m‡ |
|---|---|---|---|---|---|---|
| Yoga for all, front view | 0.869 | **0.913** | 0.908 | 0.914 | 0.956 | 0.960 |
| Yoga for all, side view | 0.891 | **0.925** | 0.891 | 0.915 | 0.940 | 0.982 |
| Yoga for all, **back view** | 0.681 | **0.759** | 0.838 | 0.858 | 0.911 | 0.931 |
| YogNet: 19 asanas, many people and clothing styles, person ≈25% of frame height | 0.734 | **0.825** | 0.769 | 0.805 | 0.890 | 0.936 |
| YogNet standing poses only (Tadasana, Trikonasana, Warrior I/II, Tree) | 0.86 | **0.92** | 0.87 | 0.89 | 0.92 | 0.95 |
| **256 px thumbnails** (stress test) | 0.541 | **0.612** (finds the person 79% of the time) | 0.655 | 0.776 | 0.829 | 0.926 |

### Temporal stability (8 held-pose clips × 90 frames, side view, tracking mode as shipped)

| | MP lite | **MP full** | MoveNet L | MoveNet T | RTMPose-s (no smoothing) |
|---|---|---|---|---|---|
| Median frame-to-frame angle change | 0.44° | **0.21°** | 0.64° | 0.45° | 1.41° |
| 90th-percentile frame-to-frame change | 7.7° | **1.7°** | 2.2° | 1.7° | 5.1° |
| High-frequency noise (std after a 9-frame median) | 4.6° | **1.0°** | 1.1° | 0.6° | 2.5° |
| Frames with no person found | 0% | 0% | 0% | 0% | 0% |

### Load time (fresh browser profile, served from localhost, so download time is excluded)

MediaPipe full reaches its first result about **9.1 s** after page load, almost all of it GPU shader compilation; lite takes 8.4 s. MoveNet takes 11.5–12.5 s and RTMPose-s on wasm about 2.0 s. On a phone, add download time: about 10.6 MB is roughly 9 s at 10 Mbit/s. **The game should start loading and warm up the model during the intro and camera-setup screens**, and the browser cache makes repeat visits faster.

## Failure cases

Galleries are in `bench/results/fail_*.jpg`.

1. **Lying poses filmed head-on or feet-on** (Anantasana from front or back, Bhujangasana from behind) were the worst case for every model. MediaPipe usually returns *no person*. MoveNet returns a confident-looking but scrambled skeleton, often with left and right swapped. Even the reference model is unreliable here. **These views should never be required.** Floor poses must be filmed side-on.
2. **The player facing away from the camera:** MediaPipe's PCK drops to 0.76 (front view 0.91). Its person detector relies on the face. **Never require a back view.**
3. **Head-down all-fours** (Marjariasana): MediaPipe 0.82 vs MoveNet 0.97.
4. **Arms overhead in a tall portrait frame** (Tadasana): MoveNet 0.76–0.79 vs MediaPipe 0.95.
5. **Small or low-resolution person:** every model degrades. MediaPipe lite on YogNet falls to 0.73. The **calibration step must make the player fill at least ~50% of the frame height**, and on a phone the camera should run at 720p or higher.
6. **Elbows are the least reliable joint for every model** (MediaPipe full mean error: elbow 12.8°, shoulder 12.4°, hip 7.8°, knee 7.2°).
7. **Left/right swaps** were rare on front and side views (MP full 0.4%, MoveNet 1.5–2%) and higher on back and lying views (YogNet 5–6%).
8. **ONNX Runtime Web correctness:** the same fp16 RTMPose-s file gives PCK 0.979 on CPU but 0.513 on WebGPU (Intel Gen9). RTMO-s fp32 gives 0.928 on CPU vs 0.619 on WebGPU. These wrong outputs are silent and would vary with each player's GPU, which we can't test.

## Scoring approach (recommendation for Phase 4)

1. **Score 2D joint angles in the image plane of a required camera view.** Each pose declares `view: front | side`. Only angles that lie roughly in that plane are scored:
   - **Front:** shoulder abduction, elbow, hip abduction/stance width, lateral torso lean, knee valgus/varus.
   - **Side:** hip flexion, knee flexion, forward torso lean, shoulder flexion, elbow.
   - A knee bend seen front-on is foreshortened. It is *not* scored from the front unless 3D confirms it (step 3).
2. **Gate on confidence rather than weighting by it.** MediaPipe's visibility barely predicts its own errors (AUROC 0.63, where 0.5 is chance). So a joint with visibility below 0.5 is *dropped*, and the weights of the remaining joints are renormalised. It does not scale the penalty. Visibility is combined with two cheap checks: a temporal median over about 5 frames, and bone-length plausibility against the player's own calibration frame. If fewer than about 70% of a pose's scored weight is visible, the game says **"adjust your camera"** instead of lowering the score.
3. **Use 3D world landmarks only for coarse, categorical checks**, never for fine angle error. Example: "arm forward vs out to the side vs overhead", or "leg forward vs sideways".
   - On 71 hand-labelled front/back frames, MediaPipe world landmarks put forward-pointing arms a median **71–73°** out of the torso plane, versus **8–13°** for arms in the frontal plane (AUROC 0.92–0.996).
   - But at a 30° threshold, 12% of frontal-plane arms were still misread as forward. So categories must be at least 45° apart, and a 3D-only miss should cost at most a small fraction of the score.
   - A 2D foreshortening cue scored nearly as well here (AUROC 0.92–0.97). That's because there was one performer at a fixed distance; with different bodies and distances it gets weaker. **3D's real value is the person-independent sign-free direction, not precision.**
4. **Per-joint tolerances derived from measured error, not guessed.** Proposal: full marks within the model's p50 error, falling to zero at about p90 plus the pose's intended slack.
   - That gives roughly ±20–25° for elbows, ±20° for shoulders and ±15° for hips and knees with the full model, widened by about 30% on the lite fallback.
   - **This directly affects difficulty**, so it is flagged for your decision when Phase 4 starts. The numbers will be re-measured on the Phase 4 test videos.
5. **Mirroring:** the preview is mirrored, but scoring uses unmirrored landmarks. The mirrored version of the target is accepted only for symmetric poses or a player-chosen side (as in the brief).

## Sources of evidence and their limitations

- **Hardware:** one Windows laptop: i7-10510U (4 cores/8 threads, 2019), Intel UHD 620 integrated GPU (WebGPU adapter "intel gen-9"), 16 GB RAM. Headless Chrome 154 driven by Playwright, cross-origin isolated. **No phone and no Safari was tested.** The phone column is an estimate built from three things: the CPU-throttling runs (Chrome slows only the CPU, so GPU-path numbers are an upper bound); the MediaPipe model card *(published)*: full model at about 40 FPS with TFLite GPU on a Pixel 3, native app; and the fact that a 2021–23 mid-range phone GPU is roughly comparable to UHD 620.
- **Safari/iOS (unverified):** MediaPipe's web GPU delegate uses WebGL2, which Safari has supported since 15. Safari on iOS 26 also ships WebGPU by default *(published)*. One developer report describes thermal throttling on an iPhone 12 after about 8 minutes of GPU pose tracking *(published; native iOS, not web)*. Our sessions are about 1 minute. **Real-device testing in Phase 4 is required.** A device cloud (e.g. BrowserStack) is a paid service and needs your approval.
- **Pseudo-ground-truth bias:**
  - There is no human-annotated yoga keypoint set with a usable licence. "Truth" here is RTMPose-x (384×288) with a YOLOX-m detector, run offline. RTMPose-s/m share its architecture and training data, so their numbers are inflated by an unknown amount. MediaPipe and MoveNet are independent of it.
  - I visually audited 48 reference skeletons. About 43 looked right; the ~5 questionable ones were all lying poses filmed head-on or feet-on, which the game won't use.
  - The independent comparisons (MediaPipe vs MoveNet vs TF.js BlazePose) are the reliable part of this evaluation.
- **Datasets:**
  - **"Yoga for all"** (Suryawanshi, Gunjal, Kanorewala, Patil 2023, DOI 10.5281/zenodo.7818789; Mendeley jc4mmnvcdk; CC BY 4.0): one consenting performer, 10 asanas (2 inversions excluded), correct and wrong execution, 4 views, 720p. The 64 non-inversion videos were used, 12 frames each.
  - **YogNet / YAR** (Mendeley k842kz6v4n, DOI 10.1016/j.knosys.2022.109097; CC BY 4.0): 20 asanas, many people. 6 videos × 4 frames per asana were used (Sarvangasana excluded).
  - **Yoga-82 was not used.** Access is by request form, and its images are scraped from the web, so their copyright sits with the original owners. **3DYoga90** is CC BY-NC-SA (non-commercial). Neither has been cleared.
  - Both CC BY datasets require attribution if any derived data (e.g. canonical skeletons) ships.
- **Not fully covered:** loose clothing is only lightly covered (a few YogNet subjects wear loose tops; nobody wears a long skirt). Crossed limbs only appear in Anantasana, Padmasana and Vakrasana. Lighting is mostly bright indoor.

## Open questions for you

1. **Approve MediaPipe full + lite fallback?** Alternatively: MoveNet Lightning (smaller and better confidence scores, but no 3D, more CPU-bound, and unmaintained).
2. **Phase 2 data is the real bottleneck.** The CC BY sources contain about 25 distinct non-inversion poses, and several are unsuitable for Yogle (deep backbends such as Ustrasana and Dhanurasana; Shavasana and Padmasana). That isn't enough for a 40–80 pose library "sourced from real human examples". Options:
   - (a) Record our own short clips of volunteers with consent forms. Most robust, and those clips double as the Phase 4 test videos.
   - (b) Seek permission to use Yoga-82, or a licence for 3DYoga90.
   - (c) Accept fewer base poses and more modifier variety.
   - I recommend (a), plus (c) in the meantime.
3. **Device testing:** may I use a paid device cloud for Safari/iOS and Android checks in Phase 4? Or can you test on 2–3 phones you have?
4. **Scoring tolerances** (the ± values above) set difficulty. Shall I treat them as provisional until the Phase 4 test videos exist?
