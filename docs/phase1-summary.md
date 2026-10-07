# Phase 1 summary: model choice

**Decision: approved by you on 2026-10-07.** MediaPipe Pose Landmarker *full* (GPU delegate), self-hosted. Switch to *lite* on slow devices. Full write-up: [model-decision.md](model-decision.md).

## What was done
- Checked current versions on 2026-10-06:
  - `@mediapipe/tasks-vision` 1.1.0 (released that day)
  - `@tensorflow-models/pose-detection` 2.1.3 (last release Oct 2023)
  - `onnxruntime-web` 1.30.0
  - RTMPose/RTMO/RTMW ONNX exports from OpenMMLab
  - RTMW3D-x (369 MB)
  - rtmlib-ts (experimental, 4 GitHub stars)
- Built a browser harness (`bench/`) that runs 16 model/backend configurations in real Chrome. It measures load time, FPS (also with the CPU slowed 2× and 4×), compressed download size, accuracy against a heavy reference model, temporal jitter, and 3D arm-direction disambiguation.
- Evaluated on two CC BY 4.0 yoga datasets ("Yoga for all", YogNet): 1,508 frames plus 8 held-pose clips.

## Key decisions and why
- **MediaPipe full:** fits the 15 MB budget (10.6 MB), runs at 26 FPS on an integrated GPU and is barely affected by a slow CPU, gives 3D, and was the most stable over time.
- **No ONNX Runtime models:** too large, quantisation breaks them, and WebGPU silently gave wrong outputs on our test GPU.
- **Scoring:** 2D angles in a declared camera plane, confidence used as a gate rather than a weight, and 3D only for coarse direction classes.
- **Never require back views or head-on views of lying poses.** Every model fails on them.

## Open questions
1. Approval of the model choice.
2. **Phase 2 needs more licensed real-human pose data.** The available CC BY sets cover only about 25 usable poses. I recommend recording consented volunteer clips.
3. Real-device testing (Safari/iOS, Android): ask before using a paid device cloud.
4. The scoring tolerances set difficulty; treat them as provisional.

## Couldn't verify
- Any phone or Safari performance. The phone numbers are estimates from CPU throttling plus published figures.
- Absolute accuracy: there is no human-labelled ground truth, and the reference model favours the RTMPose family.
- Robustness to loose clothing or long skirts, and to dim lighting: barely represented in the data.
