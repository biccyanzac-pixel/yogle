# Yogle: handover guide

Read this first if you are picking up Yogle, human or coding agent. It explains what exists, how it fits together, what must not be broken, and what is left to do. Last updated 2026-10-07.

## 1. What Yogle is
A daily yoga-pose game in the browser, like Wordle. Everyone gets the same pose each UTC day. The player gets into the pose in front of their phone or laptop camera and holds it for 10 seconds. They get a score (pose quality + stillness), an emoji grid to share, and can put their name on a shared leaderboard. Past days can be replayed from an archive. Replays go on a separate "played later" board.

- **Live site:** https://biccyanzac-pixel.github.io/yogle/
- **Repo:** https://github.com/biccyanzac-pixel/yogle (account `biccyanzac-pixel`)
- **Leaderboard API:** https://yogle-leaderboard.jacob-gg-leaderboard-worker.workers.dev (Cloudflare Worker + D1, free tier, same Cloudflare account as the owner's other game jacob.gg)
- **Owner's constraints:** free and non-commercial (a research project). **No paid services. Ask before adding any.** No backend inference. Video never leaves the device. No analytics.
- **Owner's decisions (2026-10-07):** all poses allowed, including inversions, arm balances and deep backbends, with a disclaimer and an "advanced" warning. Non-commercial-licensed data (3DYoga90, CC BY-NC) is OK.

## 2. History (what's been done)
| Phase | Result | Docs |
|---|---|---|
| 1. Model choice | Benchmarked MediaPipe, TF.js MoveNet/BlazePose and RTMPose/RTMO (ONNX Runtime Web) for speed, size and yoga accuracy. Chose **MediaPipe Pose Landmarker full**, with a fallback to lite. | `docs/model-decision.md`, `docs/phase1-summary.md`, harness in `bench/` |
| 2. Pose library | 70 poses built from real people's skeletons (3DYoga90), each with a camera view, target angles, tolerances and a difficulty from 1 to 10. | `docs/pose-library.md` |
| 3. Schedule | A deterministic daily schedule from 2026-10-05 (#1) to 2029-01-01, with rules covered by tests. | `tools/make_schedule.mjs`, `test/schedule.test.mjs` |
| 4. Game | Camera, framing prompts, ghost outline, scoring, 10 s hold, result screen, share, streaks, practice mode. | `docs/build-status.md` |
| 5. Leaderboard and archive | A shared daily leaderboard (name, score, pose quality, stillness, hold time) and an archive with replays on a separate "played later" board. Same design as jacob.gg. | Section 6 below; `worker/` |

## 3. Repo map
```
site/                     the static website (served by GitHub Pages from the gh-pages branch)
  index.html, css/style.css
  js/app.js               UI + game loop (screens: home, archive, play, result)
  js/tracker.js           MediaPipe wrapper. The ONLY file that knows which pose model is used
  js/angles.js            pose features (9 signed segment angles). Mirrors tools/build_library.py
  js/scoring.js           per-frame matching, HoldSession (10 s hold), share text. CONFIG = scoring knobs
  js/daily.js             UTC date, puzzle number, seeded PRNG, which pose a date gets (also used by the worker)
  js/figure.js            rotatable 3D target figure + 2D skeleton/ghost drawing
  js/storage.js           localStorage (try/catch everywhere): daily history, streaks, replays, flags
  js/api.js               leaderboard client. Fails soft: the game works with no backend
  data/poses.json         GENERATED pose library (do not hand-edit)
  data/schedule.json      GENERATED daily schedule (see the invariants!)
  data/config.json        { leaderboardUrl }. Set it to null to switch the leaderboard off
  vendor/mediapipe/       @mediapipe/tasks-vision 1.1.0 (JS + wasm), self-hosted
  models/                 pose_landmarker_full.task (9.4 MB), pose_landmarker_lite.task (5.8 MB)
worker/                   leaderboard backend (Cloudflare Worker + D1)
  src/index.js            routes + validation; imports ../site/js/daily.js and ../site/data/*.json
  schema.sql              D1 schema (players, results)
  test/e2e.mjs            end-to-end tests against `wrangler dev --local`
  wrangler.toml           D1 binding (database_id), ALLOWED_ORIGINS
tools/
  build_library.py        3DYoga90 skeletons -> site/data/poses.json
  make_schedule.mjs       poses.json -> site/data/schedule.json
  eval_clips.mjs          scoring validation on real videos (landmarks from bench/run_clips.mjs)
  serve.mjs               local static server (http://localhost:8080)
  github-pages-workflow.example.yml   CI deploy (needs a token with workflow scope, see section 8)
test/                     node --test unit tests (angles, scoring, hold, dates, seeding, schedule rules)
bench/                    Phase 1 benchmark + browser end-to-end harnesses. bench/data, models, frames are NOT committed
docs/                     decisions and status (this file is the entry point)
```

## 4. How it works at runtime
1. **Daily pose:** `entryFor(utcDate, schedule, poses)` in `daily.js`. If the date is in `schedule.json`, use it. Otherwise fall back to a seeded pick in that weekday's difficulty band. Puzzle #1 = 2026-10-05 (`EPOCH`). The day changes at 00:00 UTC for everyone.
2. **Tracking:** `tracker.js` loads MediaPipe full on the GPU (falling back to the CPU). After about 4 s below 12 FPS, `app.js` switches to the lite model. `detect(video)` returns `{ pts (pixels, unmirrored), vis[33], norm, world }` in **MediaPipe 33-landmark order**.
3. **Features:** `angles.js` turns landmarks into 9 signed angles in the image plane: torso, upper arms, forearms, thighs and shins.
4. **Match:** `matchPose()` in `scoring.js`. Each feature scores 1 inside its tolerance, falling linearly to 0 at tolerance + 30°. The frame score is the weighted mean.
   - Features whose landmarks have visibility below 0.5 are **left out**, not penalised.
   - The torso must be visible.
   - "Coverage" is the fraction of expected weight that's visible. In side views only one limb per left/right pair is expected, because the far limb is hidden. Coverage must be at least 0.7.
   - Mirrored variants (the other side, and in side views the other leg leading) are accepted. See TODO "sides".
5. **Hold:** `HoldSession` counts time while the score is at least 60 and coverage at least 0.7. Dips or dropouts of up to 1 s don't pause it. There's a 120 s cap per attempt.
6. **Final score** = completion × (0.85 × mean accuracy + 0.15 × stillness), where stillness comes from the per-feature std over the hold (100 at ≤2°, 0 at ≥12°). The grid is 4 rows (arms, legs, torso, still) × 5 two-second bins.
7. **Result:** stored locally (only today's real daily counts for streaks; archive replays are stored separately). The player can submit name + scores to the leaderboard. Practice mode never submits.

## 5. How the pose library is made (summary; details in `docs/pose-library.md`)
3DYoga90 world landmarks are processed per pose:

1. Take the median skeleton over each sequence's steadiest frames.
2. Run sanity checks against the label (e.g. a forward bend must actually fold).
3. Classify each sequence's view; the pose uses the majority view.
4. Rotate every sequence into that view and flip all to the same working side.
5. Target = circular median of the features; tolerance from how much people differ; display figure = the medoid person.
6. Compute difficulty from balance, flexibility, strength and coordination (AAOS range-of-motion references).

20 of 90 poses were dropped as not judgeable from one camera.

Rebuild (needs the dataset under bench/data; see `bench/README.md` and the 3DYoga90 repo for download instructions):
```
python tools/build_library.py bench/data/3dyoga90 bench/data/3dyoga90_repo/data/pose-index.csv
```

## 6. Leaderboard and archive
- **Endpoints (worker/src/index.js):**
  - `POST /api/session`: server-issued `{playerId, token}`, stored in localStorage `yogle:session`
  - `POST /api/submit`: `{playerId, token, day, pose, name, score, accuracy, stability, held, grid}`
  - `GET /api/leaderboard?day=YYYY-MM-DD&late=0|1&playerId=`: the best result per player, top 20, plus "you" if ranked lower
  - `GET /api/days?from=&to=`: per-day counts for the archive list
- **Rules enforced server-side:**
  - The day can't be in the future.
  - The pose must equal **the server's own** `entryFor(day)`. That's why the worker imports `site/js/daily.js` and `site/data/*.json`.
  - All numbers must be in range, and score ≈ completion × (0.85·accuracy + 0.15·stability) within 1.5.
  - held ≤ 10.
  - At most 10 submissions per player per day per board.
  - Rows are insert-only.
- **On time vs "played later":** `is_late = 1` when the submission's UTC date isn't the puzzle's day. The two boards are never merged, so archive replays can't rewrite a day's real result.
- **Trust model (same as jacob.gg):** scores are computed in the browser, so a modified browser could lie. Only cheap tampering is blocked. Accepted trade-off for a free, on-device game.
- **CORS:** `ALLOWED_ORIGINS` in `wrangler.toml` (comma-separated). Production allows only `https://biccyanzac-pixel.github.io`.
- **Front end:** `site/js/api.js` plus the "leaderboard" and "archive" sections at the bottom of `app.js`. `?api=<url>` overrides the backend for local testing.
- **Moderating a bad name or row:** the app never deletes. Do it manually:
  `cd worker && npx wrangler d1 execute yogle-leaderboard --remote --command "DELETE FROM results WHERE id = '...'"`. List rows first with `SELECT`.

## 7. Invariants: don't break these
1. **Past days must never change pose.** The leaderboard checks the pose against the schedule, and every archive day depends on it. `make_schedule.mjs` regenerates the *whole* schedule from the library, so **if you change `poses.json` (rebuild, retune, add or remove poses), past days could get different poses.**
   - Before shipping a library change, keep every `schedule.json` entry up to and including today and only regenerate from tomorrow onward. That needs a small change to `make_schedule.mjs`: a `--keep-until` option that reads the committed file. Then update the "matches the generator" test to compare only the regenerated range.
   - Pose **ids** must also stay stable: a past day refers to a pose by id.
2. **Redeploy the worker whenever `site/data/schedule.json`, `site/data/poses.json` or `site/js/daily.js` changes.** The worker bundles them at deploy time; a stale copy rejects every submission as `wrong_pose`.
3. **`site/js/angles.js` and `tools/build_library.py` (`features`, `SEGMENTS`) must compute identical features.** Targets are built in Python and matched in JS. Unit tests cover the JS side only.
4. **`tracker.js` must keep returning MediaPipe 33-landmark indices.** If you swap models, map their keypoints into that layout.
5. **Changing `EPOCH`** renumbers every puzzle and moves the schedule start. Don't, now that it's live.
6. **Scores in `scoring.js` and the worker's consistency check must agree.** If you change the final-score formula (`STABILITY_WEIGHT`, `HOLD_SECONDS`), update `worker/src/index.js` `checkResult()` in the same change and redeploy, ideally with a scoring version keyed by date so old days stay valid.

## 8. Run, test and deploy
```
# site locally (camera works on localhost)
node tools/serve.mjs                               # http://localhost:8080/   (?debug shows FPS/model; ?pose=<id> opens practice)
npm test                                           # unit + schedule tests (26 pass, 1 todo)

# worker locally (port 8797 - 8787 is used by jacob.gg's local worker)
cd worker && npm install
npm run db:init:local && npm run dev:local         # wrangler dev --local, allows origin http://localhost:8080
npm test                                           # in another terminal: 25 end-to-end checks against real local D1
# then open http://localhost:8080/?api=http://127.0.0.1:8797

# browser end-to-end with a video file as the camera (needs bench/ data + Chrome)
node bench/e2e.mjs bench/fakecam/tree.mjpeg tree tree-test
node bench/e2e-archive.mjs bench/fakecam/cobra.mjpeg 0 "Tester"     # needs the local worker
```
**Deploy the site** (GitHub Pages serves the `gh-pages` branch, a mirror of `site/`):
```
git push origin main
git subtree split --prefix site -b gh-pages && git push -f origin gh-pages
```
The machine's stored GitHub token lacks the `workflow` scope, so `.github/workflows/*` can't be pushed. To get CI, the owner creates a token with that scope, and you move `tools/github-pages-workflow.example.yml` into `.github/workflows/`.

**Deploy the worker:** `cd worker && npx wrangler deploy`. Wrangler is already logged in on the owner's machine. Schema changes: write `worker/migrations/000N_*.sql` and run it with `npx wrangler d1 execute yogle-leaderboard --remote --file=...` **before** deploying code that needs it.

**Git identity:** the repo-local config is `biccyanzac-pixel <285977456+biccyanzac-pixel@users.noreply.github.com>`. Don't commit with the machine's global (university) email.

## 9. Improving the pose model
- Everything model-specific is in `site/js/tracker.js` (and the model files in `site/models/`). Keep the return shape.
- Compare candidates with the Phase 1 harness: `bench/web/bench.js` holds the adapters, and `bench/run.mjs` measures FPS/accuracy against pseudo ground truth on yoga frames. Results and method are in `docs/model-decision.md`.
- **Phase 1 lessons:**
  - MediaPipe fails on back views and on lying poses filmed head-on (so the library never requires those).
  - Its visibility score is poorly calibrated, so it's used as a gate, not a weight.
  - ONNX Runtime WebGPU gave silently wrong outputs on an Intel GPU.
  - int8 quantisation broke RTMPose.
- **After changing the model,** re-run `tools/eval_clips.mjs`. Current baseline: the correct pose ranks #1 in 22/60 real clips, and 29/60 reach the hold threshold. Also re-check `vis` semantics: the 0.5 gate assumes MediaPipe visibility.
- `@mediapipe/tasks-vision` is vendored at 1.1.0. To upgrade, copy `vision_bundle.mjs` + `wasm/*` from the npm package into `site/vendor/mediapipe/` and test on GPU and CPU.

## 10. TODO: sort out later (owner's list + known issues)
1. **Difficulty slider:** let players choose Easy/Normal/Hard by scaling tolerances (e.g. ×1.5 / ×1 / ×0.7 on `tol`) and maybe `MATCH_THRESHOLD`.
   - Decide how this interacts with the leaderboard. Options: a separate board per setting; only Normal counts; or record the setting and show it. The worker would need a `difficulty` column, plus the score check would have to allow it.
   - Separately, review the pose difficulty ratings: backbends look underrated (Upward Bow 5.5, Camel 4.6) and Side Reclining Leg Lift overrated (8.4).
2. **Symmetry and sides:** currently **every** pose accepts either side (mirror), and side-view poses also accept the other leg leading.
   - The original brief said mirrored versions are accepted only if the pose is symmetric or the player chose a side.
   - Options: a "choose your side" toggle; alternate sides by day; or require both sides (two holds).
   - `poses.json` has `symmetric` per pose. Note that `symmetric` is only meaningful for front-view poses. Where to change: `matchPose(..., { allowMirror })` in `scoring.js` and its calls in `app.js`.
3. **Scoring may be too generous:** real-video tests gave Tree and Plank 100/100. Tune `BASE_TOL` (build_library.py), `CONFIG.FALLOFF` and `MATCH_THRESHOLD` (scoring.js) against owner play-tests. If the leaderboard is live, changing them mid-day makes scores incomparable, so change them at a day boundary.
4. **Modifiers** (arm variants, depth variants, gaze) aren't built, so the brief's "no identical pose+modifier within a year" rule can't be met (it's a `todo` test). With only 70 poses, each repeats about every 2 months.
5. **Recover dropped poses:** Warrior 1, the lunges, Child, Happy Baby and others were rejected because people disagree too much from one view. Better side alignment for mixed-angle poses would probably recover some.
6. **Test on real phones, Safari and iOS:** never done. Only desktop Chrome has been tested.
7. **Weak poses in real-video tests:** Corpse, Easy Sitting, some Warrior 2 and Cobra clips. Record our own correct/incorrect clips as a proper test set (`docs/build-status.md`).
8. **Leaderboard hardening:**
   - No profanity filter on names.
   - Rate limiting is in memory per isolate.
   - The archive list loads every day at once (fine for a few years; paginate later).
9. **Licence:** none chosen for Yogle's code yet. Data attribution (3DYoga90 CC BY-NC) is shown in the footer and README.
10. **Schedule `--keep-until`:** see invariant 1. Do this before the first library change.

## 11. Gotchas
- **Windows machine:** use Git Bash or PowerShell. Text files written by Python on Windows can get CRLF line endings. A CRLF list once broke filenames: a `\r` came out as `_`.
- **Port 8787** is jacob.gg's local worker; Yogle's local worker uses **8797**.
- **First load** downloads about 13 MB (model + wasm), plus about 9 s of GPU shader warm-up. The status line says "Loading the pose model".
- **Datasets** live only in `bench/data/` on the owner's machine: 3DYoga90 skeletons, "Yoga for all" and YogNet videos (CC BY 4.0). They're not committed and not redistributed.
- **jacob.gg** (`C:\Users\jacobp\Desktop\jacob.gg`, github.com/biccyanzac-pixel/jacob.gg) is the owner's other daily game. Yogle's leaderboard copies its design but has its **own** worker and D1 database. Don't touch jacob.gg's worker or database.
