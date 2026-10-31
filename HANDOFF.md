# Handoff — 2026-10-31 — combined cleanup published

## Current result

The agreed three-part cleanup is complete, validated, committed and published:

- `8733f22` — Extract HUD messages, first-run tutorial and scene overlays.
- All required validation passed (details below).
- The user explicitly approved publication with “push”.
- `git push fork main` succeeded: `604a077..8733f22 main -> main`.
- Local main and fork/main are synchronized (`0 0`).
- No implementation, validation or publication work remains for this batch.

## Repository state

- Workspace: `/home/eli/Projects/battledrones`.
- Branch: `main`, tracking `fork/main`.
- HEAD: `8733f22` (full hash available through git rev-parse HEAD).
- `fork/main`: `8733f22`. Local main is synchronized.
- Push destination: `git@github.com:elialbert/battledrones.git`, branch `main` (`fork`). It is public.
- `origin` is simonw/battledrones; do not push there.
- Only `?? HANDOFF.md` remains in the working tree. Keep this handoff local and uncommitted.
- Prior handoff saved at `/tmp/battledrones-combined-original-handoff.md`.
- No applicable AGENTS.md was found in this repository or its ancestors.
- No test/build/browser/server sessions remain running.

## Implementation

All three targets were handled together in one commit:

1. `src/ui/messages.ts`: HUD toast/banner presenter, owning announcement subscription and banner timer/click teardown. Preserves toast eviction, safe text, passive touches, durations, banner priorities/pre-emption/queue cap/deduplication, layout refreshes and camera taps. `Hud.bannerUp` and hint suppression delegate to this presenter. Existing toast expiry callbacks continue touching only their own nodes; no broader toast lifecycle redesign was introduced.
2. `src/ui/tutorial.ts`: first-run state/storage progression using the existing shared HintQueue. Preserves tutorial flags, blocked-storage/spectator/Ops skips, stages and opener wording, queue priority/TTL/validity, and persistence on show. HUD still owns global hint pacing and updates the hint queue before offering tutorial hints each frame.
3. `src/game/render/overlays.ts`: selection/world marks and screen status marks with narrow view/controller/entity/juice dependencies. Keeps waypoint, chevron and weapon-down scratch buffers in the renderer. Reads World collections on every draw, including after replay restore. GameScene keeps Last Stand/placement orchestration, world/screen rendering order, fast-forward semantics and final drawLabels call.

No camera/input coordination, sim, visibility-policy or game-rule changes.

Main orchestrator sizes: `src/ui/hud.ts` 1,064 lines (was 1,194); `src/game/GameScene.ts` 1,671 (was 1,915).

The extracted toast/banner, tutorial and world/screen mark logic was mechanically compared with `git show 604a077:<path>` after normalizing the intended ownership substitutions. All comparisons matched.

## Validation (all passed at 8733f22)

- `npm run build`: TypeScript, Vite and PWA generation passed.
- `npm test`: all 91 Vitest files, all 1,719 tests passed (160.59 s), then all four archive tests passed.
- Focused tests: 192 tests across 12 files passed (tutorial, overlays, hints, heroes, render, Goliath render/UI, minimap, local-side, orders-ahead, command-ux, versus-imports).
- `npm run smoke:hud`: all 17 real-DOM Chrome component checks passed. Five new message checks use an explicitly paused Playwright clock to cover toast expiry/eviction and banner timing, queue/pre-emption and teardown in both timer phases.
- `node tools/smoke.mjs 390 844`: SMOKE OK as blue, RECORD OK (28 turns, 10 hashes through tick 1051, final d429f74b).
- `node tools/smoke.mjs 1280 900 --side=red`: SMOKE OK as red, RECORD OK (26 turns, 10 hashes through tick 1053, final 453d8b2d).
- Working/staged diff whitespace checks passed before committing.

New Vitest coverage: twelve tutorial cases and eight overlay cases, including stale hints, completion timing, in-flight rally previews, hidden/remembered entities, public Gantry production, red-seat meters, DPR snapping, Goliath weapon states, scratch reuse and replay collection replacement.

Logs:

- `/tmp/battledrones-combined-build.log`
- `/tmp/battledrones-combined-tests.log`
- `/tmp/battledrones-combined-mobile-smoke.log`
- `/tmp/battledrones-combined-desktop-red-smoke.log`

## Environment and preferences

- User wants action and dislikes unnecessary confirmations. This batch and its publication are complete.
- Do not spawn sub-agents unless the user or applicable instructions ask.
- Git metadata is read-only in the sandbox; git writes require escalation. Chrome, loopback servers and the full test suite also used escalation.
- Full-game smoke commands both bind port 8899, so run sequentially if ever needed again; production build must precede them.
- Keep the existing queue-aware smoke timing fix in `604a077`.
- Camera/input coordination was fourth in the previous recommendations and remains outside this batch. No additional cleanup scope is selected.
