# Battle Dromes — MVP Design

A mobile-friendly real-time strategy game in the Command & Conquer tradition.
Two armies of drones — flying and ground-based — battle for territory and
resources. The MVP is a single-player skirmish against an AI commander,
playable in a mobile browser.

## Design pillars

1. **Readable at phone size.** Every unit, building, and state must be
   identifiable on a 6" screen. Big touch targets, high-contrast sprites,
   minimal chrome.
2. **A full match in a coffee break.** Target match length ~10 minutes.
   Fast build times, small maps, decisive combat.
3. **Air vs ground is the core tension.** The rock-paper-scissors between
   flying and ground drones is what makes this game *Battle Dromes* and not
   a generic RTS. Every roster and map decision should feed it.

## Locked-in decisions

| Decision | Choice |
|---|---|
| Platform | Web PWA — TypeScript, Canvas/WebGL 2D |
| Opponent | Single-player vs scripted AI |
| Core mechanics | Resource harvesting, base building, fog of war |
| Win condition | Destroy the enemy HQ (~10 min matches) |
| Roster size | 6 units, 4 buildings |
| Art | Pixel-art sprites, supplied by the project owner (placeholders until then) |
| Controls | Full-screen touch-first (mouse also supported); portrait and landscape both first-class |

## Tech stack

- **Language:** TypeScript, strict mode.
- **Engine:** [Phaser 3](https://phaser.io/) — gives us WebGL rendering with
  canvas fallback, sprite atlases, tilemaps, camera controls, pointer/touch
  input, and an asset pipeline out of the box. Game *logic* stays in plain
  TS modules that don't import Phaser, so the simulation is unit-testable
  headlessly.
- **Build tooling:** Vite + `vite-plugin-pwa` (service worker, installable,
  offline-capable — the whole game is client-side).
- **Testing:** Vitest for the simulation layer (economy math, pathfinding,
  combat resolution, AI decisions). Playwright smoke test that boots the
  game and runs a few simulated frames.
- **No server.** Everything runs on-device. Persistence (settings, last
  match result) via `localStorage`.

## The game

### Map

- Square tile grid, **48×48 tiles** for the MVP map, 32 px tiles
  (1536×1536 px world).
- Tile types: **ground** (passable to all), **rock** (impassable to ground,
  passable to air), **scrap field** (the harvestable resource, sits on
  ground tiles).
- One hand-authored, mirrored map for the MVP: player HQ bottom-left, AI HQ
  top-right, a scrap field near each base and one contested field
  mid-map, rock formations creating ground chokepoints that air units can
  overfly.

### Economy

- Single resource: **Scrap**.
- Harvester drones carry up to **100 scrap** per trip; a scrap-field tile
  holds a finite pool (depletes visually). Harvesters auto-cycle:
  field → HQ → field.
- Starting stockpile: **500 scrap** — enough for a Fab Plant and a
  second Harvester, forcing an early build-order choice.
- No power/supply mechanic in the MVP. One resource, one currency.

### Buildings (4)

| Building | Cost | Role |
|---|---|---|
| **HQ** | — (pre-placed) | Scrap drop-off, builds Harvesters. Its destruction ends the game. 3×3 tiles, high HP. |
| **Fab Plant** | 300 | Builds ground combat drones. 2×2. |
| **Airpad** | 400 | Builds flying drones. 2×2. |
| **Turret** | 250 | Static defense, hits ground *and* air, short range. 1×1. |

- Build flow, C&C-style: pick a building from the build bar → it constructs
  on a timer → tap a valid tile near your base to place it. Placement must
  be within **6 tiles** of an existing friendly building (keeps bases
  coherent and the AI simple).

### Units (6)

| Unit | Cost | Built at | Domain | Attacks | Notes |
|---|---|---|---|---|---|
| **Harvester** | 150 | HQ | Ground | — | Auto-harvests. Slow, tanky-ish. |
| **Scout** | 100 | Airpad | Air | — | Fast, fragile, big sight radius. The fog-of-war tool. |
| **Stinger** | 150 | Fab Plant | Ground | Ground only | Cheap line infantry drone. |
| **Flak Crawler** | 200 | Fab Plant | Ground | Air only | The anti-air answer. Helpless vs ground. |
| **Wasp** | 200 | Airpad | Air | Ground only | Strike drone. Ignores terrain, shreds Stingers/Harvesters, dies to Flak. |
| **Raptor** | 250 | Airpad | Air | Air only | Air-superiority drone. Counters Wasps and Scouts. |

The counter-triangle: **Stingers** beat Flak Crawlers, **Flak Crawlers**
beat Wasps/Raptors, **Wasps** beat Stingers — with Raptors and Turrets as
the flex pieces. Exact HP/damage/speed numbers live in
`src/sim/balance.ts` as a single tuning table, not in this document.

- **Movement:** ground units path with A* on the tile grid (rocks and
  buildings block); air units fly straight lines over everything.
  Local avoidance is simple separation steering — no flow fields in MVP.
- **Combat:** auto-acquire nearest valid target in range; attack-move is
  the default behavior when given a move order onto/near enemies. Damage is
  instant-hit with a visual projectile/laser effect (no projectile
  simulation in MVP).

### Fog of war

- Two states per tile: **unexplored** (black) and **explored-but-unseen**
  (dimmed, shows last-known terrain and buildings, not units).
- Sight radii per unit/building; recomputed on a coarse timer (~4×/sec),
  not per frame.
- The AI does *not* cheat: it maintains its own visibility map and only
  reacts to what it has scouted. (This is cheap to do symmetrically and
  makes Scouts matter for both sides.)

### AI opponent

A finite-state commander with three states — **Build-up → Harass →
Assault** — evaluated every 2 seconds:

- **Build-up:** follow a build order (Harvester ×2, Fab Plant, Airpad,
  Turret), keep scrap flowing, replace lost Harvesters.
- **Harass:** once an Airpad exists, send Scout sweeps and 2–3-Wasp raids
  at the player's Harvester line.
- **Assault:** when army value exceeds a threshold (or its economy is
  starved), gather at a rally point and push the player HQ, composing the
  wave with counters to whatever it has scouted.

One difficulty level in the MVP. The AI uses the same build/production
rules and the same fog of war as the player — its advantage is discipline,
not cheating.

### Match flow

1. Splash → "Skirmish" button (menu is just this in MVP).
2. Both HQs pre-placed, each side starts with 1 Harvester + 500 scrap.
3. Real-time play until one HQ is destroyed.
4. Victory/defeat screen with match stats (duration, units built/lost,
   scrap harvested) → "Play again".

## Controls & UI (mobile-first, full-screen)

### Full-screen behavior

The game owns the entire screen — no page chrome, no scrolling, no
accidental browser gestures:

- **Installed as PWA:** `display: "fullscreen"` in the manifest — no
  browser UI at all.
- **In-browser play:** a "Play" tap on the splash screen requests the
  Fullscreen API where available (Android); on iOS Safari (no Fullscreen
  API for canvas) we rely on `100dvh` layout plus a one-time "Add to Home
  Screen for the best experience" hint.
- **Viewport hygiene:** `100dvh`/`100dvw` sizing so browser-bar
  show/hide never clips the HUD; `viewport-fit=cover` +
  `env(safe-area-inset-*)` padding so HUD elements clear notches, punch
  holes, and the home-indicator strip; `touch-action: none` and
  `overscroll-behavior: none` on the canvas so pinch/pan/pull-to-refresh
  never leak to the browser; `user-select: none` and context-menu
  suppression to kill long-press text/image popups.
- Canvas resizes live on orientation change and window resize (Phaser
  `Scale.RESIZE`); the sim never pauses, only the HUD re-flows.

### Touch gesture spec

All input via Pointer Events, so mouse and touch share one code path.
Exact, non-overlapping gestures:

| Gesture | On | Action |
|---|---|---|
| Tap | Own unit | Select it (replaces selection) |
| Tap | Own building | Select it (shows its build options) |
| Tap | Enemy / ground / scrap | With selection: attack / attack-move / harvest. Without: ping-select whatever's there |
| Double-tap | Own unit | Select all on-screen units of that type |
| Drag (one finger) | Empty ground | Pan the camera |
| Long-press (~250 ms) then drag | Anywhere | Box-select (haptic tick + visual rectangle on trigger) |
| Two-finger drag | Anywhere | Pan (always works, even over units) |
| Pinch | Anywhere | Zoom between min/max (two useful levels) |
| Tap | Minimap | Jump camera there |

Disambiguation rules: a touch is a *tap* if it moves < 8 px and lasts
< 250 ms; movement beyond the slop radius before the long-press timer
fires commits to *pan*; after the timer fires it commits to *box-select*.
Commands from taps are forgiving — target hit-testing uses an enlarged
(≥ 44 px) radius around units, nearest-match wins.

A compact **command chip row** appears above the build bar when units are
selected: Stop, and Rally (for buildings). Everything else is
context-from-tap — no mode buttons to fiddle with mid-fight.

### Mouse & keyboard (comes along for free, still supported properly)

Left-click select / left-drag box-select (no long-press needed — pointer
type is detected), right-click = move/attack command, wheel = zoom,
middle-drag or arrow keys = pan. No hotkey system in MVP beyond Esc =
deselect.

### HUD layout — portrait and landscape both first-class

The HUD is DOM overlaid on the canvas (crisper text, free layout engine,
easy safe-area handling) and re-flows by orientation via CSS:

- **Landscape:** build bar as a vertical column on the right edge
  (C&C-style sidebar, thumb-reachable), minimap top-right above it,
  scrap counter top-center.
- **Portrait:** build bar as a horizontal strip along the bottom,
  minimap bottom-right above the bar, scrap counter top-center. Portrait
  shows a taller slice of the map — good for the vertical
  bottom-left/top-right base layout of the MVP map.
- All buttons ≥ 56 px touch targets with visible cost labels; disabled
  (can't afford / prerequisite missing) states are dimmed with the reason
  on tap.
- The camera never hides under the HUD: the sim viewport is inset by the
  occupied HUD edges, so "tap ground" near the build bar can't misfire.

### Minimap

Top/bottom corner per orientation (see above); shows explored terrain,
friendly/enemy blips (fog-respecting), and combat pings. Tap to jump the
camera; drag on it to scrub.

## Sprite spec (for the artist)

All art on a **32 px grid**, PNG sprite sheets, transparent background.
Two factions: player (blue accents) and enemy (red accents) — either
separate sheets or grayscale + tint masks, artist's choice.

| Asset | Canvas | Frames |
|---|---|---|
| Ground units | 32×32 | 8 rotation directions (or 1 frame + engine rotation if the silhouette reads well), 2-frame move wobble optional |
| Air units | 32×32 + 8 px drop-shadow decal | Same as ground; shadow rendered separately so altitude reads |
| Harvester | 32×32 | Empty + loaded variants |
| HQ | 96×96 | Idle, damaged (≤50% HP), rubble |
| Fab Plant / Airpad | 64×64 | Idle, damaged, rubble; brief "working" flash optional |
| Turret | 32×32 base + rotating 32×32 head | Head rotates in engine |
| Terrain tiles | 32×32 | Ground ×3 variants, rock ×2, scrap field full/half/empty |
| FX | 32×32 | Muzzle flash, laser/bolt, small explosion (4–6 frames), selection ring (drawn in engine) |

Until real art lands, the game runs on programmer placeholders (colored
shapes with icons) sized exactly to this spec, so sprites drop in with no
code changes.

## Architecture

```
src/
  sim/        # Pure TS, no Phaser. The authoritative game state.
    world.ts        # entity store, tile grid, spatial hash
    balance.ts      # all tunable numbers in one table
    economy.ts      # scrap, harvesting, build queues
    movement.ts     # A* + steering
    combat.ts       # targeting, damage
    fog.ts          # per-side visibility maps
    ai/             # the enemy commander FSM
  game/       # Phaser scenes, rendering, input → sim commands
  ui/         # build bar, minimap, HUD (Phaser or DOM overlay)
```

- **Fixed-timestep simulation** (10 ticks/sec) decoupled from rendering
  (60 fps with interpolation). Input produces **commands** applied at tick
  boundaries. This keeps the sim deterministic and testable — and is
  exactly the structure future online multiplayer (lockstep) needs, at
  near-zero extra MVP cost.
- Entities are plain objects in typed arrays/maps — no heavyweight ECS
  framework; ~100 units max is trivial.
- Performance budget: 60 fps on a mid-range Android phone with 80 units on
  screen. Sprite batching via one atlas; fog rendered as a single
  RenderTexture overlay updated on the fog timer.

## Explicitly out of scope for MVP

- Online multiplayer, matchmaking, accounts (the deterministic sim keeps
  the door open).
- Territory-control zones (candidate for v2 — it fits the pitch, revisit
  after the core loop is fun).
- Campaign, missions, tutorials beyond a first-run hint overlay.
- Multiple maps, map editor, random maps.
- Tech tree / upgrades, superweapons, veterancy.
- Sound design beyond a handful of essential effect + one music loop
  (stretch goal).
- Difficulty levels, replays, saves mid-match.

## Milestones

1. **M1 — Moving dots:** Vite+Phaser skeleton, full-screen/viewport
   scaffold with portrait & landscape HUD shells, map renders, the full
   gesture spec (tap select, long-press box-select, pan, pinch), ground
   pathing. *Playable toy on a real phone.*
2. **M2 — Economy:** HQ, Harvesters, scrap loop, build bar, building
   placement, unit production. *You can build an army.*
3. **M3 — Combat:** all 6 units with the counter-triangle, turrets, HQ
   destruction, win/lose screen. *Two humans could theoretically fight (hot-seat via debug).* 
4. **M4 — The opponent:** fog of war + AI commander. *A real match.*
5. **M5 — Polish pass:** minimap, match stats, PWA install, performance on
   real phones, drop in real sprites when available. *Shippable MVP.*
