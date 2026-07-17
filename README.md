# Battle Drones

A mobile-friendly real-time strategy game in the Command & Conquer
tradition: two armies of drones — flying and ground-based — battle for
territory and resources. Single-player skirmish against an AI commander,
built for phone browsers (touch-first, portrait or landscape) and
installable as a PWA.

**Play it: <https://simonw.github.io/battledrones/>**

Mine scrap with harvesters, build a Fab Plant and Airpad, produce a
counter-balanced drone army (Stingers ▸ Flak Crawlers ▸ Wasps ▸ …), scout
through the fog of war, and destroy the enemy HQ. Matches run about ten
minutes.

## Development

```bash
npm install
npm run dev        # Vite dev server
npm test           # Vitest suite for the simulation layer
npm run build      # typecheck + production build into docs/
npm run sprites    # regenerate placeholder sprite sheets
node tools/smoke.mjs   # headless Playwright smoke test against docs/
```

The built site in `docs/` is committed so GitHub Pages serves it directly
with no build step — rebuild and commit `docs/` when shipping changes.

- **`DESIGN.md`** — full MVP design: mechanics, balance philosophy,
  controls spec, architecture.
- **`ART.md`** — sprite sheet contract for replacing the generated
  placeholder art with real pixel art (paths, frame sizes, direction
  conventions).

## Architecture

- `src/sim/` — the deterministic game simulation: pure TypeScript, no
  engine imports, fixed 10 Hz tick, command-queue input. All tunable
  numbers live in `src/sim/balance.ts`. The AI commander
  (`src/sim/ai/commander.ts`) plays by the same rules and fog as the
  player. Fully unit-tested.
- `src/game/` — Phaser 3 rendering and input: interpolated 60 fps view of
  the sim, gesture recognizer (`gestures.ts`, engine-free and tested),
  camera, fog overlay, fx.
- `src/ui/` — DOM-overlay HUD: build bar, minimap, chips, screens, with
  portrait/landscape layouts in CSS.
