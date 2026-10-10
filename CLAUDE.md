# Yogle: notes for coding agents

Start with **docs/HANDOVER.md**. It covers what everything is, how it works, how to run/test/deploy, and the TODO list.

Critical rules (details in HANDOVER section 7):
- **jacob.gg house rules and shared kit:** read `../jacob.gg/PLAYBOOK.md` before changing the look, the results screen, the leaderboard flow or the leaderboard table. The page loads `jacob.gg/kit/jgg.css` + `jgg.js` (colours, font, masthead, weekday level, rating box): don't redefine the kit's base CSS here. If the leaderboard table changes, update the hub's `worker/src/sources.js` so plays keep counting.
- Never change the pose of a past day: don't regenerate the whole `site/data/schedule.json` after changing `poses.json`. Keep pose ids stable.
- After changing `site/data/*.json` or `site/js/daily.js`, redeploy the worker (`cd worker && npx wrangler deploy`). It bundles them to validate submissions.
- `site/js/angles.js` must match `tools/build_library.py` features. `tracker.js` must return MediaPipe 33-landmark order.
- If the score formula changes in `site/js/scoring.js`, change `checkResult()` in `worker/src/index.js` too.
- Free/non-commercial project: ask the owner before adding any paid service, restrictive-licence dependency or analytics.
- Commit as `biccyanzac-pixel <285977456+biccyanzac-pixel@users.noreply.github.com>` (already the repo-local config). Deploy the site with `git subtree split --prefix site -b gh-pages && git push -f origin gh-pages`.
- Tests: `npm test` (root), and `cd worker && npm run dev:local` + `npm test` for the API.
