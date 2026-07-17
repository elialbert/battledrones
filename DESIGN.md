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
| Controls | Tap-select / drag-box, tap-to-move/attack, two-finger camera |

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

## Controls & UI (mobile-first)

- **Select:** tap a unit; drag on empty ground for box-select; double-tap a
  unit to select all visible units of that type.
- **Command:** with units selected, tap ground = attack-move, tap enemy =
  attack, tap scrap field with Harvesters = harvest. A small floating
  "stop" button appears when units are selected.
- **Camera:** one-finger drag on empty space pans (box-select requires
  starting the drag on a selected-empty area with a short hold —
  playtest and tune), pinch to zoom (two zoom levels is enough), edge
  minimap tap to jump.
- **Build bar:** persistent bottom bar with building/unit buttons and
  costs, C&C sidebar style but horizontal for portrait/landscape phones.
  Buttons ≥ 56 px touch targets.
- **Minimap:** top corner, shows explored terrain, radar blips, and combat
  pings. Tap to move camera.
- Landscape is the primary orientation; portrait should be playable but is
  not tuned in MVP.
- Desktop niceties (mouse box-select, edge scroll, hotkeys) come free from
  pointer events but are not an MVP goal.

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

1. **M1 — Moving dots:** Vite+Phaser skeleton, map renders, tap/drag
   selection, ground pathing, camera controls. *Playable toy.*
2. **M2 — Economy:** HQ, Harvesters, scrap loop, build bar, building
   placement, unit production. *You can build an army.*
3. **M3 — Combat:** all 6 units with the counter-triangle, turrets, HQ
   destruction, win/lose screen. *Two humans could theoretically fight (hot-seat via debug).* 
4. **M4 — The opponent:** fog of war + AI commander. *A real match.*
5. **M5 — Polish pass:** minimap, match stats, PWA install, performance on
   real phones, drop in real sprites when available. *Shippable MVP.*
