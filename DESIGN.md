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
- **Audio:** every sound — effects, the adaptive score and the ambience — is
  synthesised live with WebAudio; no audio files.
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
| Proving Grounds | 48² | Temperate | The original MVP map: rock ridges and one contested field |

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
- Starting stockpile: 600 scrap and one harvester.

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
- **Retaliation.** Idle units hit by something out of reach go after the
  attacker, and nearby idle allies join in.
- Auto-acquire targets in range; attack-move is the default command, with
  a "Move only" chip for retreats.

### Combat readability & feedback ("juice")

Fights must read at a glance on a phone (units die ~3.7 s after first
being hit), and kills, losses and income must each feel distinct. Rules in
`src/game/juice.ts` (engine-free, unit-tested), drawn by
`src/game/render/juice-view.ts`:

- **Hit flash:** a hit unit flashes a white silhouette (hull and turret)
  for 70 ms, at most once per 120 ms per unit; buildings get a warm
  additive glow (100 ms, once per 280 ms) so a siege flickers rather than
  strobes. Wall-clock timed, so pausing never freezes a unit white.
- **Health bars:** recently lost HP stays as a pale chunk for 300 ms, then
  drains at 1.5× max HP/s (a new burst only re-arms the hold once the trail
  has caught up). Enemy bars brighten as HP falls and blink at 2 Hz below
  25%. Bars snap to device pixels, keep a 22 CSS px minimum width, and stay
  4 CSS px tall at every zoom.
- **Team ground rings:** any unit that fired or was hit in the last 3 s
  sits on a thin blue/red ellipse (fading over its last second), so mixed
  clumps read even at the default zoom. Aircraft rings sit under the craft.
- **Deaths:** small hulls get a smaller fireball and glow (Titans and
  Hornets keep their big one); impacts are trimmed so explosions stop
  hiding the clump. An expanding ring in the victim's colour says whose
  unit just died. Camera shake only for deaths the player can see inside
  the camera view, scaled by what died (stinger ≈ 1 px, HQ biggest).
- **Sound:** a bright two-note *kill* "ting" on enemy deaths you can see; a
  low *lost* power-down for your own units (quieter and throttled when off
  screen). Both may use two voices reserved above the 14-voice battle cap.
  Losing a building buzzes the phone (`navigator.vibrate(20)`, Android).
- **Economy:** each delivery pops a gold "+100" over the drop-off with a
  coin blip; deliveries within 2.5 s of each other climb a pentatonic
  scale (retuned into each biome's music key, `coinKey` in score.ts), and
  arrivals at one drop-off within 400 ms merge into one label.
  The scrap pill bumps on income and flashes red when you spend.
- Spectators get the visuals for both sides but no kill/loss/coin cues.

### Music & ambience (adaptive score)

The battle used to be silent half the time. A procedural score
(`src/game/music.ts`, rules in the engine-free, tested `src/game/score.ts`)
now follows it, scheduled 200 ms ahead on the AudioContext clock at 96 BPM
(menu 80), in 16th-note steps with one chord per two bars:

- **Layers**, each opened only on a bar line: a voice-led **pad** (always;
  four gliding voices, no muddy seconds or sevenths in the bass), a calm
  **melody** that plays call-and-answer phrases while you build, a **bass**
  groove once your units are in contact, **drums** (with a crash on entry
  and fills every fourth bar) when a fight is on screen, and a 16th-note
  **arp** when it gets big. While your base is under sustained attack
  (3+ building hits in 4 s) the arp swaps in a tritone and the filters open
  — for at most 15 s per attack, so it stays a warning.
- **Biomes:** temperate D dorian (Dm7–Fmaj7–Cmaj7–G7, kalimba pluck),
  desert E phrygian dominant (E–F–Am–Dm, oud pluck, tresillo bass, tabla),
  arctic F lydian (Fmaj7–G7–Dm7–Am7, FM glass bells, half-time drums),
  volcanic C aeolian (Cm–Ab–Eb–Bb, marimba, driven chugging bass, toms).
- **Intensity** (`BattleMood`, from the sim's fx stream):
  `I = audibleShots4s/32 + 0.5·(base under attack) + 0.25·min(1, losses10s/3)`,
  floored at 0.3 while your units fought anywhere in the last 8 s; attack
  0.5 s, release 6 s. Shots count by the same earshot rule as the SFX and
  only if you can see them. Bass enters around I 0.15–0.35, drums 0.42–0.6,
  arp 0.72–0.9. Spectators hear on-screen combat from both sides (1.5× the
  shots for full) with no alarm. Measured over six AI-vs-AI matches with a
  follow-cam: calm 24% / bass 15% / drums 33% / arp 28% of match time
  (HQ-parked camera 24/42/23/11); first drums at 36–138 s.
- **Stingers** on the next beat: a I–IV–V–I fanfare (victory, which then
  holds the tonic major for a quiet coda), a descending minor lament
  (defeat), and for `announce()` lines a rising call (`epic`), two low stabs
  a semitone apart (`bad`, which also lifts the tension for 8 s), a light
  lift (`good`, priority ≤ 1) or a tom hit (keys matching `first-blood`).
  At most one per 3.5 s. When music is off, the old SFX jingles play instead.
- **Mix:** the score ducks 6 dB under big explosions and alarms (`sfx.duck`,
  also for announcer lines), is muffled to a 420 Hz lowpass while paused,
  and stops with the tab hidden (the AudioContext is suspended). Budget:
  8 persistent pad oscillators plus ≤ 10 transient voices (14 during a
  stinger), shared noise buffers; the scheduler costs ~0.07 ms per 25 ms
  tick. Offline renders: calm ≈ −34 dBFS RMS, intense ≈ −26, peaks ≤ 0.6.
- **Ambience** (`src/game/ambience.ts`): a quiet looped bed per biome —
  wind and birdsong, desert roar and sand hiss, a sliding arctic whistle, a
  volcanic rumble with crackles — at about −44 dBFS, ducked by
  `1 − 0.7·I`. It plays under the Music switch.
- **Menu:** a gentle pad/melody/arp take on the selected map's biome,
  starting on the first touch (browsers block audio until a gesture).

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
intruders; wasp raids that avoid remembered anti-air; staged assault waves
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
2. Both HQs pre-placed, one harvester each (it starts mining at once).
3. Real-time play until one HQ is destroyed. Pause any time.
4. Victory/defeat screen with stats → Rematch or Menu.

First-time players get four contextual hints (build a Fab, move units,
counters, tech).

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
  minimap pings where you're being hit. The scrap pill bumps when a
  harvester delivers and flashes red when scrap is spent.
- **Sound:** the top-left speaker (in game and on the menu) is a one-tap
  master mute. The pause menu has four toggles — Sound (master), Music
  (score and ambience), Effects and Voice (the announcer) — persisted in
  `localStorage` (`battledrones.audio`).

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
    render/         # world-view (terrain, piles, fog), entities, fx, juice-view
    juice.ts        # hit flash / damage trail / combat ring / cue rules (tested)
    audio.ts        # AudioContext, sfx/music/voice buses, settings, procedural SFX
    score.ts        # music rules: harmony, patterns, stingers, battle mood (tested)
    music.ts        # adaptive score: lookahead scheduler + synth voices
    ambience.ts     # biome ambience beds
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
