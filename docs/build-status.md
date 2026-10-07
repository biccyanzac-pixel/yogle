# Build status: first playable version (2026-10-07)

## Decisions from you (2026-10-07)
- Model: **MediaPipe Pose Landmarker** approved (full, auto-falling back to lite below 12 FPS).
- **All poses allowed**, including inversions, arm balances and deep backbends, with a disclaimer and an "advanced" warning. This overrides the original brief's exclusions.
- Non-commercial research use, so **3DYoga90 (CC BY-NC) is OK**.
- **No paid services.** You'll test on your own devices.
- Public website on GitHub Pages.

## What's built
| Area | Status |
|---|---|
| Pose library (Phase 2) | 70 poses from real people, difficulty 1–10. See [pose-library.md](pose-library.md). No modifiers yet. |
| Daily schedule (Phase 3) | `site/data/schedule.json`, 2026-10-05 to 2029-01-01 (820 days), seeded and deterministic. Rules tested: no repeat within 21 days, different body focus on consecutive days, difficulty rising Mon→Sun (mean 2.3 → 9.0). Falls back to a seeded pick after it ends. |
| Game (Phase 4) | Rotatable 3D target figure, mirrored camera with a white ghost outline, framing prompts, per-frame scoring, 10 s hold with a 1 s dropout grace, stillness score, result screen with an emoji grid, share, best-moment snapshot (kept on device), streaks in localStorage, practice mode for every pose, disclaimer dialog. |
| Leaderboard and archive (added 2026-10-07) | Shared daily board (name, score, pose quality, stillness, hold time; best run per player). An archive of every past day with replay; replays rank on a separate "played later" board. Cloudflare Worker + D1 (free tier) in `worker/`. See [HANDOVER.md](HANDOVER.md). |
| Tests | `npm test`: 26 pass. 1 `todo`: the pose+modifier yearly rule. Worker: 25 end-to-end checks against local D1. |

## Scoring (provisional: these numbers set difficulty)
- A frame's score is the weighted mean over the 9 segments: 1 inside tolerance, falling linearly to 0 at tolerance + 30°.
- Joints with MediaPipe visibility below 0.5 are left out rather than penalised. The torso must be visible.
- In side views only one limb of each left/right pair is expected, because the far limb is hidden. At least 70% of the expected weight must be visible.
- The hold timer runs while the frame score is 60 or more.
- Final = completion × (0.85 × mean accuracy + 0.15 × stillness). Stillness is 100 at ≤2° mean frame-to-frame std and 0 at ≥12°.
- Either side is accepted for every pose (mirror image, or in side views the other leg leading). Your brief said "only if symmetric or the player chose a side". I chose "either side" for now to keep the first version simple. **Your call.**

## Validation so far
- **Real videos (YogNet, CC BY 4.0):** 60 clips, 15 asanas that map to library poses, 4 different people each, scored with the game's own code against all 70 poses (`tools/eval_clips.mjs`).
  - The correct pose ranked #1 in 22 of 60 clips and top-3 in 25.
  - 29 of 60 clips reached the hold threshold in at least 30% of frames.
  - Works well: Downward Dog, Tree, Mountain, Plank, Bridge, Bow, Standing Forward Bend.
  - Poor: Corpse, Easy Sitting (the clips show lotus), and some Warrior 2 and Cobra clips.
  - Caveat: these YogNet clips use a wide, high camera with the person small in frame, and some catch people between poses. So these numbers understate a well-set-up phone.
- **End-to-end in Chrome**, with a real person's video as the camera:
  - Tree and Plank: score 100 (held 10 s, about 23 FPS).
  - The same Tree video when Warrior 2 is asked for: the timer never starts.
  - **Two perfect 100s suggest tolerances may be too generous.**
- **Not tested:** any phone, Safari/iOS, Firefox.

## Known issues and next steps
1. Test on your phone(s) and tell me if it feels too easy or too hard. The tolerances and threshold are in `site/js/scoring.js` (`CONFIG`) and `tools/build_library.py` (`BASE_TOL`).
2. Add modifiers (arm and depth variants) so the yearly no-repeat rule can be met.
3. Recover dropped poses (Warrior 1, lunges, Child, Happy Baby…).
4. Record our own test clips (correct and incorrect) for a proper scoring test set.
5. A first visit downloads about 40 MB of runtime and models (both the full and lite models are hosted, but only one loads at a time; typical first load is about 13 MB compressed). Cold start is about 9 s on a laptop.
