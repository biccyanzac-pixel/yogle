# Yogle

A daily yoga pose game in the browser. Everyone gets the same pose each day (chosen from the UTC date). Get into it in front of your camera, hold it for 10 seconds, and share your score as an emoji grid. **Video never leaves your device**: pose tracking runs locally with MediaPipe, and there's no backend, no accounts and no analytics.

> ⚠️ Some poses are advanced (inversions, arm balances, deep backbends). Stop if anything hurts. You play at your own risk.

**New here (human or agent)? Read [docs/HANDOVER.md](docs/HANDOVER.md).**

Features: the daily pose, a 10 s hold scored for pose quality and stillness, an emoji share grid, streaks, practice mode for all 70 poses, a **shared daily leaderboard** and an **archive** to replay past days (replays rank on a separate "played later" board).

## Play
https://biccyanzac-pixel.github.io/yogle/

Add `?pose=<id>` to open a pose in practice mode (e.g. `?pose=tree`) and `?debug` to show FPS and model info.

## Develop
```
node tools/serve.mjs          # http://localhost:8080/  (the camera works on localhost)
npm test                      # unit tests: angles, scoring, hold timer, dates and seeding, schedule rules
npm run schedule              # regenerate site/data/schedule.json after changing the library
python tools/build_library.py bench/data/3dyoga90 bench/data/3dyoga90_repo/data/pose-index.csv   # rebuild poses.json
```

## Deploy
The site is served by GitHub Pages from the `gh-pages` branch, which mirrors `site/`:
```
git subtree split --prefix site -b gh-pages && git push -f origin gh-pages
```
(`tools/github-pages-workflow.example.yml` would automate this with tests on every push. It needs a GitHub token with the `workflow` scope; copy it to `.github/workflows/` to enable it.)

## Layout
- `site/`: the static website (deployed to GitHub Pages)
  - `js/angles.js` (features), `js/scoring.js` (matching and hold), `js/daily.js` (date and seeding), `js/app.js` (UI)
  - `data/poses.json` (pose library), `data/schedule.json` (daily schedule)
  - `vendor/mediapipe/`, `models/`: MediaPipe Tasks Vision 1.1.0 and the pose models (Apache-2.0)
- `worker/`: leaderboard API (Cloudflare Worker + D1), https://yogle-leaderboard.jacob-gg-leaderboard-worker.workers.dev
- `tools/`: library builder, schedule generator, real-video scoring evaluation, dev server
- `bench/`: Phase 1 model benchmark harness (large data is not committed)
- `docs/`: decisions and status. Start with [docs/build-status.md](docs/build-status.md).

## Credits and licences
- Pose targets are derived from **3DYoga90** (Kim et al., 2023, https://github.com/seonokkim/3DYoga90), annotations CC BY-NC 4.0. That's why this project is non-commercial.
- Pose tracking: **MediaPipe Pose Landmarker** (Google, Apache-2.0).
- Evaluation data: "Yoga for all" (Suryawanshi et al., 2023) and YogNet/YAR (Mendeley Data k842kz6v4n), both CC BY 4.0. Not redistributed here.
- No licence has been chosen for Yogle's own code yet.
