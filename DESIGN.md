# Battle Drones — Design

A mobile-friendly real-time strategy game in the Command & Conquer tradition.
Two armies of drones — flying and ground-based — battle for territory and
resources. Single-player skirmish against an AI commander (or watch two AIs
fight), playable in a mobile browser and installable as a PWA.

This document started as the MVP design (6 units, 4 buildings, one map);
the v2 overhaul expanded it to 11 units, 8 buildings, 5 maps across 4
biomes with gameplay-relevant terrain, a damage/armor model, AI
personalities and difficulty levels, painted art and procedural audio.

## Design pillars

1. **Readable at phone size.** Every unit, building, and state must be
   identifiable on a 6" screen. Big touch targets, high-contrast sprites,
   minimal chrome.
2. **A full match in a coffee break.** Target match length ~10 minutes
   against a human (AI-vs-AI games settle in 5–8).
3. **Air vs ground is the core tension.** The rock-paper-scissors between
   flying and ground drones is what makes this game *Battle Drones* and not
   a generic RTS. Every roster and map decision should feed it.

## Locked-in decisions

| Decision | Choice |
|---|---|
| Platform | Web PWA — TypeScript, Phaser 3 (WebGL), rendered at device pixel ratio (≤ 2×) |
| Opponent | Single-player vs scripted AI (6 personalities × 3 difficulties), or AI vs AI spectator |
| Core mechanics | Resource harvesting, base building, tech tree, fog of war, terrain |
| Win condition | Destroy the enemy HQ |
| Roster size | 11 units, 8 buildings |
| Art | Painted top-down sprites and terrain generated with OpenAI `gpt-image-2.5-sunburst` (see ART.md) |
| Controls | Full-screen touch-first (mouse also supported); portrait and landscape both first-class |

## Tech stack

- **Language:** TypeScript, strict mode.
- **Engine:** [Phaser 3](https://phaser.io/) for WebGL rendering, texture
  atlases (mipmapped), particles, tweens and camera. Game *logic* stays in
  plain TS modules that don't import Phaser, so the simulation is
  unit-testable headlessly.
- **Build tooling:** Vite + `vite-plugin-pwa` (service worker, installable,
  offline-capable after first play of each map).
- **Testing:** Vitest for the simulation (economy, pathfinding, combat,
  terrain, tech tree, AI, maps); a Playwright smoke test that drives the
  real touch input paths; a headless balance harness (`tools/balance.ts`).
- **Audio:** every sound is synthesised live with WebAudio — no audio files.
- **No server.** Everything runs on-device. Settings persist in
  `localStorage`.

## The game

### Maps & terrain

Five 2-player maps, all point-symmetric (rotated 180°) so both sides are
equal, painted procedurally from a seed in `src/sim/maps.ts`:

| Map | Size | Biome | Character |
|---|---|---|---|
| Riverlands | 56² | Temperate | A river splits the valley: one bridge, two muddy fords, woods on the banks |
| Dune Sea | 56² | Desert | Open sands between mesas, a palm oasis in the middle, three lanes |
| Frostbite | 48² | Arctic | A frozen sea in the centre — short, brutal, hover-friendly |
| Ashlands | 64² | Volcanic | Lava rivers carve three plateaus joined by bridges; air rules |
| Proving Grounds | 48² | Temperate | The original MVP map: rock ridges, one contested field, an expansion field out on each flank |

Terrain matters (numbers in `TERRAIN` in `src/sim/balance.ts`):

| Terrain | Tanks | Hover | Air | Notes |
|---|---|---|---|---|
| Ground | ✓ | ✓ | ✓ | Buildable |
| Road / Bridge | ✓ fast (1.35×) | ✓ | ✓ | Roads are buildable, bridges not |
| Rough (mud, scree, slush, cinders) | ✓ slow (0.6×) | ✓ full speed | ✓ | |
| Woods | ✓ slow (0.55×) | ✓ slow | ✓ | Ground units inside take 30% less damage |
| Shallows (fords) | ✓ slow (0.5×) | ✓ | ✓ | |
| Water / lava | ✗ | ✓ | ✓ | The Lancer's party trick |
| Rock | ✗ | ✗ | ✓ | |
| Scrap field | ✓ | ✓ | ✓ | Resource: 1500 per tile |
| Crystal field | ✓ | ✓ | ✓ | Rich resource: mines 1.6× faster per load |

Ground pathfinding is A* weighted by terrain speed, so tanks prefer roads
and skirt mud. Air units fly straight over everything.

### Economy

- Single currency: **Scrap**. Harvesters haul 100 per trip from scrap piles
  or glowing crystals back to the nearest **drop-off** (HQ or Depot).
  Harvesters flee home when shot and auto-mine when built.
- Each HQ also salvages a trickle of 2 scrap/second, so no side can be left
  permanently broke.
- Starting stockpile: 600 scrap and one harvester, plus the side's opener
  (below) — so in practice two or three harvesters and a factory.

### Openers (quick start)

Every skirmish opens on three cards and the clock waits for the pick, so
there is no dead "wait for the first factory" stretch (the old opening had
a 14 s idle gap and the first combat unit at 0:51):

| Opener | You get | Plays like |
|---|---|---|
| **Blitz** | Fab Plant + 3 Stingers + 2 harvesters, −100 scrap | Army on the field at 0:00; raid early |
| **Industry** | Fab Plant + 3 harvesters + 200 scrap | Out-mine now, out-build later |
| **Air Wing** | Airpad + 3 Wasps + 2 harvesters | Fast strike drones; dies to Flak |

Blitz and Industry are worth 650 scrap; the Airpad is a side-grade (you
still want a Fab for anti-air), so Air Wing carries a third Wasp (950). A
720-game AI-vs-AI opener matrix (every opener pair, both sides, six
personality pairings, five maps) has them winning 53% / 55% / 42% of
decided games — Air Wing rewards a human's micro more than the AI's.

`src/sim/openers.ts` places the factory deterministically ~4.5 tiles from
the HQ toward the map centre (legal, off the roads and the harvest route,
never walling anything in), with every search done in the side's own
frame so both sides get mirror-image setups. `createMapWorld(id, { openers: { blue, red } })` applies them for
tests and the balance harness; without the option the classic start is
unchanged. The AI picks by personality (Rush → Blitz, Boom → Industry,
Air Swarm / Skyforce → Air Wing, Balanced → any, Ironclad → Blitz or
Industry, seeded) and holds its raiders home for the first 45 s. The
cards name the enemy personality, so the pick can be a counter-pick.

### Buildings (8)

| Building | Role | Requires |
|---|---|---|
| **HQ** | Pre-placed. Builds Harvesters, takes scrap, point-defence gun vs aircraft. Lose it, lose the game. 3×3. | — |
| **Fab Plant** | Builds ground vehicles. 2×2. | — |
| **Airpad** | Builds aircraft. 2×2. | — |
| **Tech Lab** | Unlocks Mortar, Titan, Lancer, Hornet. 2×2. | Fab Plant or Airpad |
| **Depot** | Forward scrap drop-off for distant fields. 2×2. | — |
| **Turret** | Autocannon, hits ground and air. 1×1. | — |
| **SAM Site** | Long-range anti-air missiles. 1×1. | — |
| **Radar** | Reveals a 13-tile radius through the fog. 1×1. | — |

C&C build flow: pick a structure → it constructs on a timer → tap it again
and tap a valid spot within 6 tiles of your base. One construction at a
time. Buildings can be **sold** for 50% (scaled by health).

### Units (11)

| Unit | Built at | Domain | Hits | Role |
|---|---|---|---|---|
| **Harvester** | HQ | Ground | — | Economy |
| **Scout** | Airpad | Air | — | Fast, big sight radius |
| **Stinger** | Fab | Ground | Ground | Cheap fast light tank |
| **Flak Crawler** | Fab | Ground | Air | The anti-air answer |
| **Mortar** ⚗ | Fab | Ground | Ground | Long-range splash artillery with a minimum range; shells are real projectiles and can be dodged |
| **Titan** ⚗ | Fab | Ground | Ground | Super-heavy twin-cannon tank |
| **Lancer** ⚗ | Fab | Hover | Both | Anti-armour laser that also hits air (at reduced effect) and crosses water |
| **Wasp** | Airpad | Air | Ground | Rocket strike drone |
| **Raptor** | Airpad | Air | Air | Interceptor |
| **Hornet** ⚗ | Airpad | Air | Ground | Heavy bomber: splash vs ground and bases |
| **Mender** | Airpad | Air | — | Repair drone: heals units and buildings |

⚗ = needs a Tech Lab.

The counter web (verified by the cost-equal duel matrix in
`tools/balance.ts duels`): **Stingers** beat Flak, Mortars and Lancers ·
**Lancers** burn through Titans · **Titans** crush Stingers, Flak and
Mortars · **Flak** beats all aircraft · **Wasps** beat tanks and artillery ·
**Raptors** beat aircraft · **Hornets** smash bases and armour but die to
Flak/Raptors/SAMs. Stinger › Lancer › Titan › Stinger is the ground
triangle; air vs anti-air sits across it.

### Combat

- **Damage types × armor classes.** Every weapon has a damage type
  (kinetic, cannon, flak, missile, explosive, laser) and every target an
  armor class (light, medium, heavy, structure); `DAMAGE_VS` in
  `balance.ts` is the multiplier table.
- **Splash & projectiles.** Mortar shells and Hornet bombs are simulated
  projectiles aimed at where the target *was* — fast units can dodge.
  Splash falls off from 100% to 50% at the edge.
- **Cover.** Ground units in woods take less damage.
- **Veterancy.** Units earn XP from kills (in scrap value); three ranks,
  each +15% damage, rank 3 self-repairs. Shown as gold chevrons.
- **Fights you can play.** Combat units carry 1.5× their original HP
  (Hornets 1.3×, so Flak still beats them; Harvesters, Scouts and
  buildings unchanged): half of an 8-v-8 Stinger brawl now dies in 7.5 s
  instead of 5, Wasps vs Flak 4.7 s instead of 2.4 — time to select, retreat
  or focus-fire on a phone. The duel matrix keeps the counter web below.
- **Retaliation.** Idle units hit by something out of reach go after the
  attacker, and nearby idle allies join in.
- Auto-acquire targets in range; attack-move is the default command, with
  a "Move only" chip for retreats.

### Fog of war

- Unexplored (black), explored-but-unseen (dimmed; remembers enemy
  buildings), visible. Rendered as a smoothly fading soft-edged overlay.
- The AI does *not* cheat: it keeps its own visibility map and reacts only
  to what it has seen.

### AI opponent

A commander that runs a decision pass every 1.2–3.5 s (by difficulty) and
emits ordinary commands. Six personalities, picked at random each match:

| Strategy | Plan |
|---|---|
| Balanced | Factory, airpad, tech; steady macro |
| Rush | Two factories early, attacks at half the usual army size |
| Air Swarm | Airpad first, wasp raids, bombers later |
| Boom | Greedy economy, forward depot, huge late push |
| Skyforce | Air force first; the Fab Plant only guards home |
| Ironclad | Rushes the Tech Lab for Titans, Lancers and Mortars |

Behaviours: build orders with reactive SAM sites and extra factories when
scrap piles up; forward depots at distant fields; adaptive production
(flak/raptors vs air it has seen, mortars vs defences, air vs heavy
armour); defend-the-economy guard squads; threat response against
intruders; home defence (a force at the HQ that outguns the home guard
recalls the army from raids and waves — openers make 1:00 pushes real);
wasp raids that avoid remembered anti-air; staged assault waves
that go for harvesters, then production, then defences, then the HQ;
menders escorting the army.

Difficulty: **Easy** (slow reactions, 75% income, no raids), **Normal**,
**Hard** (fast reactions, +30% income, an extra harvester — shown in the
menu, never hidden). Each difficulty also picks from its own pool of
personalities: AI-vs-AI tournaments (`tools/balance.ts matches`) show
Ironclad, Boom and Balanced are the strongest, so Easy draws from Balanced,
Rush, Air Swarm and Skyforce, and Hard from Balanced, Air Swarm, Boom and
Ironclad. AI-vs-AI games settle in a median of ~6 minutes.

### Match flow

1. Menu: pick a map and difficulty → Play (or Watch AI vs AI).
2. Opener cards over the frozen battlefield (Blitz / Industry / Air Wing;
   tap, or keys 1–3). The camera already frames the HQ, its home field and
   the factory site, clear of the HUD. Spectated AIs pick instantly.
3. The pick rolls out (factory, units, harvesters already mining) and
   the clock starts. Real-time play until one HQ is destroyed. Pause any time.
4. Victory/defeat screen with stats → Rematch (back to the cards) or Menu.

First-time players get contextual hints (command your opener units — or
build a Fab on a classic start — then counters, tech).

## Controls & UI (mobile-first, full-screen)

### Full-screen behavior

The game owns the entire screen — no page chrome, no scrolling, no
accidental browser gestures:

- **Installed as PWA:** `display: "fullscreen"` in the manifest.
- **In-browser play:** the Play tap requests the Fullscreen API where
  available (Android); on iOS Safari we rely on `100dvh` layout.
- **Viewport hygiene:** `100dvh`/`100dvw` sizing, `viewport-fit=cover` +
  `env(safe-area-inset-*)` padding, `touch-action: none`,
  `overscroll-behavior: none`, `user-select: none`, context-menu and iOS
  gesture/page-zoom suppression (with a rescue button if iOS zooms anyway).
- **Hi-DPI:** the canvas renders at the device pixel ratio (capped at 2×)
  and is CSS-scaled down, so painted art is crisp on phones.

### Touch gesture spec

| Gesture | On | Action |
|---|---|---|
| Tap | Own unit | Select it |
| Tap | Own building | Select it (production queue, sell, rally) |
| Tap | Enemy / ground / scrap | With selection: attack / attack-move / harvest |
| Tap | Ground, building selected | Set rally point |
| Double-tap | Own unit | Select all on-screen units of that type |
| Drag (one finger) | Anywhere | Pan (with momentum) |
| Long-press then drag | Anywhere | Box-select (prefers combat units over harvesters) |
| Two-finger drag / pinch | Anywhere | Pan / zoom |
| Tap / drag | Minimap | Jump / scrub the camera |
| Long-press | Build button | Info card: stats, counters, cancel queued |

Disambiguation: a touch is a *tap* if it moves < 8 px and lasts < 250 ms;
movement beyond the slop radius before the long-press timer fires commits
to *pan*; after the timer fires it commits to *box-select*. Hit-testing
uses an enlarged (≥ 24 CSS px) radius, and aircraft are tested where they
are drawn (lifted above their shadows).

Context **chips** above the build bar: Stop / Move only / deselect for
units; Sell (+refund) / rally hint for buildings; "Select army" when
nothing is selected; placement hint + cancel while placing.

### Mouse & keyboard

Left-click select, left-drag box-select, right-click command, wheel zoom,
middle-drag or arrows/WASD pan, +/− zoom, P or Space pause, Q select army,
Delete sell, Esc cancel/deselect. Right-click a build button for its card.

### HUD layout — portrait and landscape both first-class

DOM overlaid on the canvas, re-flowing by orientation:

- **Portrait:** a bottom dock — selection panel and chips above a tabbed
  build bar (Base / Vehicles / Aircraft) with unit portraits, costs, lock
  icons, queue badges and progress fills. Minimap top-right; scrap,
  income rate and clock top-left.
- **Landscape:** the build bar becomes a right-edge sidebar with a 2-column
  grid; selection panel and chips sit bottom-right beside it.
- Toasts for "building ready", attacks (tap to jump there) and hints;
  minimap pings where you're being hit.

### Minimap

Painted-map thumbnail under the fog, resource fields, buildings and unit
blips (fog-respecting), attack pings and the camera frame.

## Art

See **ART.md** for the generation pipeline (prompts, processing, atlases,
terrain painting). Summary: every sprite, terrain material, decoration,
the key art and the app icon were generated with OpenAI's
`gpt-image-2.5-sunburst` using native transparency; sprites are drawn
top-down facing north and rotated in engine, with separately rotating
turrets, drop shadows, and red team colours derived by hue-shifting the
blue originals.

## Architecture

```
src/
  sim/        # Pure TS, no Phaser. The authoritative game state.
    world.ts        # entities, tile grid, occupancy, passability
    balance.ts      # every tunable number: units, buildings, terrain, damage table
    maps.ts         # the 5 maps (seeded painter) + createMapWorld
    economy.ts      # scrap, harvesting, depots, tech rules, build queues, selling
    movement.ts     # terrain-weighted A* (ground/hover/air), steering
    combat.ts       # targeting, armor, splash projectiles, healing, veterancy
    fog.ts          # per-side visibility maps + building memory
    ai/commander.ts # the enemy commander: strategies, difficulty
  game/       # Phaser: scene, camera, input, rendering
    render/         # world-view (terrain, piles, fog), entities, fx
    audio.ts        # procedural WebAudio sound effects
  ui/         # DOM HUD, menu styles
art/          # image generation + processing pipeline (Python)
tools/        # map export, balance harness, smoke test, screenshot tour
```

- **Fixed-timestep simulation** (10 ticks/sec) decoupled from rendering
  (interpolated at display rate, driven by the raw frame delta so the game
  keeps real time even when the browser throttles its smoothed clock).
  Input produces **commands** applied at tick boundaries; the sim is
  deterministic and testable.
- One 2048² mipmapped sprite atlas (WebP, ~1.3 MB); painted terrain as
  1024 px chunks per map (48 px per tile).

## Explicitly out of scope (for now)

- Online multiplayer (the deterministic command-driven sim keeps the door
  open), campaigns, map editor, replays, saves mid-match.
- Upgrades research, superweapons, walls, control groups.
- Music (sound effects only).
