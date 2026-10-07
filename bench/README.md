# Phase 1 benchmark harness

Reproduces the numbers in `../docs/model-decision.md`. This is research tooling, not part of the game.

Large inputs are **not** meant for version control: `data/` (about 7 GB of downloaded datasets), `models/` (about 1 GB), `frames/` and `node_modules/`.

## Setup
```
npm install                      # playwright-core, @mediapipe/tasks-vision, @tensorflow-models/pose-detection, onnxruntime-web, esbuild
pip install onnx onnxruntime onnxconverter-common opencv-python-headless numpy
node fetch-tfjs.mjs              # MoveNet / BlazePose weights -> models/tfjs
```
MediaPipe `.task` files and the OpenMMLab ONNX zips are downloaded with the URLs listed in `docs/model-decision.md`. The fp16/int8 conversions were made with `onnxconverter-common` and `onnxruntime.quantization.quantize_dynamic`. The int8 RTMPose model they produce is broken; don't use it.

## Pipeline
1. `python py/extract.py ...`: frame extraction. Eval sets: `frames/yfa`, `frames/yognet`, `frames/yfa_lowres`, clips `frames/fps_*`, `frames/jit_*`.
2. `python py/pseudo_gt.py frames/<set>`: RTMPose-x + YOLOX-m reference keypoints, written to `results/gt_<set>.json`.
3. `npx esbuild web/bench.js --bundle --format=esm --outfile=web/bundle.js`
4. `node run.mjs frames/<set> images|fps results/<out>.json "<model regex>" [--throttle=N]`: drives the installed Chrome. Model ids are listed in `web/bench.js`.
5. Analysis:
   - `python py/analyze.py frames/<set> results/<acc>.json results/gt_<set>.json results/an_<set>`: accuracy
   - `PYTHONPATH=py python py/arm3d.py results/acc_yfa.json`: 3D arm direction, using the hand labels in `results/arm_labels.json`
   - `python py/jitter.py results/jit_*.json`: temporal stability
   - `node sizes/measure.mjs`: compressed download sizes

## Data licences
- "Yoga for all": Suryawanshi et al. 2023, CC BY 4.0, DOI 10.5281/zenodo.7818789.
- YogNet / YAR: Mendeley Data k842kz6v4n, CC BY 4.0, DOI 10.1016/j.knosys.2022.109097.

No dataset images are committed. The `results/*.jpg` contact sheets are derived from CC BY material and need attribution if shared.
