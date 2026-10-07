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
| Opponent | Single-player vs scripted AI (6 personalities × 3 difficulties), AI vs AI spectator, Last Stand waves, or the Ops campaign |
| Core mechanics | Resource harvesting, base building, tech tree, fog of war, terrain |
| Win condition | Destroy the enemy HQ (Last Stand: survive as many waves as you can; Ops: the op's objective) |
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
- **Battlefield salvage** (below): wrecks are the second income stream,
  ~18% of all scrap earned in AI-vs-AI play.

### Battlefield salvage

Every destroyed combat unit leaves a burning wreck worth **30% of its
cost** (Stinger 45, Titan 143, Hornet 113 …; harvesters leave none) for
**60 s**. After 2.5 s it has cooled enough to touch, and the first ground
unit of *either* side — harvesters included — whose centre comes within
0.9 tiles scoops it up (income multipliers apply). Fights leave loot worth
holding the field for, a defender who breaks a wave gets paid for it, and
the losing side has a way back in.

- Aircraft wrecks land where they fall; a death spot no tank could reach
  (rock, water, lava, a building) slides to the nearest passable point
  within 2 tiles, else the wreck is lost. Wrecks never block movement or
  placement (a building placed on one clears it for its owner).
- At most 60 wrecks at once (the oldest burns out first).
- Looks: the dead unit's own sprite, charred, turret blown off its ring;
  embers and smoke while hot, then a gold glint and a faint warm glow that
  say "loot"; it fades over its last 10 s. Downed aircraft tumble from
  flying height first. Pickups pop a gold "+52" (merged when several land
  together) with a coin blip; the enemy's pickups show in muted red.
  A sweep of 400+ in a few seconds calls out a "SALVAGE HAUL" banner.
  Wrecks show only where you have vision and are remembered like buildings
  until you see they're gone; gold minimap dots. The income rate (+N/m)
  includes salvage, and the end screen has a Salvaged row.
- Measured (AI-vs-AI round robin with openers, all 5 maps, 300 games
  per setting): about 6,100 scrap salvaged per match (18% of income);
  stalemate draws 30 → 17; the side ahead by 200+ value at 2:00 / 3:00
  went on to win 88% / 92% → 84% / 88%; median length 5.5 → 5.7 min, mean
  8.8 → 7.8. Shares of 25% and 35% were tried too: 35% removes more draws
  but hands the leader its edge back (87% / 88%); 25% was within noise
  of 30%.

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
and place it on a valid spot within 6 tiles of your base (see "Command UX"
below). One construction at a time. Buildings can be **sold** for 50%
(scaled by health).

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
  each +15% damage, rank 3 self-repairs. Shown as gold chevrons. Ranked
  units become heroes (see *Veteran heroes* below).
- **Fights you can play.** Combat units carry 1.5× their original HP
  (Hornets 1.3×, so Flak still beats them; Harvesters, Scouts and
  buildings unchanged): half of an 8-v-8 Stinger brawl now dies in 7.5 s
  instead of 5, Wasps vs Flak 4.7 s instead of 2.4 — time to select, retreat
  or focus-fire on a phone. The duel matrix keeps the counter web below.
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

### Voices & announcer

Every player action gets a voiced answer, and the big moments are called
out without eating screen space (C&C's EVA, arena-shooter streaks).

- **Unit chirp-voices** (`src/game/voices.ts`): each unit class has a
  synthesized robot voice: a carrier glides through two formant
  band-passes, plus a dry share so thin voices carry on phone speakers.
  Titans growl at 80 Hz, Hornets drone with FM buzz, Wasps buzz at 60 Hz,
  Lancers shimmer, Menders ring like bells and Harvesters go "boop-boop".
  Lines: *select* (two rising syllables), *move* (two short, then a fall),
  *attack* (a noise bark and three fast syllables), *ready* (three rising,
  replacing the generic chime), *rank* (four ascending with a sparkle,
  replacing the rank chime) and *death* (a falling wail with crackle, own
  units in view only). Pitch is jittered ±6% by unit id, so a group sounds
  like a chorus. A group answers in its majority kind's voice, with one
  echo voice 6 dB down. Every line is under 400 ms. Lines start at least
  250 ms apart; unprompted ones keep their own spacing (ready 2 s, rank
  1.5 s, death 2.5 s) and stay 600 ms clear of the player's chirps. Lines
  are balanced to about −30 dBFS RMS.
- **Radio announcer** (`announcer.ts`, rules in the engine-free, tested
  `callouts.ts`): a squelch and key-up beep on the voice bus, then
  `speechSynthesis` (pitch 0.6, rate 1.08, an English, preferably male,
  on-device voice), then an "over" click. The music ducks 5 dB under it.
  It reads every `announce()` banner (`Announcement.say` overrides the
  spoken text) plus its own lines from the fx stream:

  | Line | Priority | When / cooldown |
  |---|---|---|
  | Warning: our HQ is under attack | 0 | HQ hit; 30 s (60 s if it's on screen) |
  | Our base is under attack | 1 | other building hit off screen; 30 s |
  | Squad lost | 1 | 3 own deaths within 3 s; 20 s |
  | Enemy aircraft detected | 1 | first visible enemy combat aircraft; re-armed after 2 min unseen |
  | Structure lost: X | 1 | own building destroyed; 15 s |
  | Our units are under fire | 2 | own unit hit off screen; 60 s |
  | Harvester lost / Titan lost | 2 | off screen; expensive (≥ 350) or veteran units |
  | Enemy X destroyed | 2 | enemy building; 15 s |
  | Construction complete / X promoted (rank ≥ 2) / Insufficient scrap | 3 | |
  | Enemy HQ destroyed. Victory! / Our HQ has fallen. Mission failed. | 0 | last word; nothing after it |

  Delivery goes through `RadioQueue`: most important first, ≥ 2.5 s between
  lines, at most two waiting, and lines dropped after waiting 3 s (6 s for
  P0). A chatter budget allows at most 3 routine (P2–P3) lines per 30 s;
  warnings always get through. Lines wait, without ageing, while the game
  is paused. Radio-only news also gets a small coloured **radio caption**
  (a slim toast; tap to jump there). Lines that already have a toast or
  banner get no caption. Speech
  must be unlocked inside a gesture on iOS (primed on the first tap). Where
  speech is missing, failing, or set to **Chirps**, a two-tone radio code
  stands in: falling for warnings, rising for good news.
- **Kill-streak banners** (through `announce()`, so they also get music
  stingers and are read out): *First blood* (the player's first kill),
  *Double kill* / *Triple kill* / *Rampage* for 2 / 3 / 5 kills within a
  4 s sliding window. The tier is called after a 0.6 s hold, so a fast
  third kill upgrades the line. Tier cooldowns are 30 / 30 / 45 s.
  Expensive kills get their own banner ("TITAN DOWN", spoken "Enemy Titan
  destroyed"), or ride along under a streak. Kill banners are at least 6 s
  apart; a streak climbing a tier needs only 2 s.
- **Spectators** hear a neutral caster ("Red HQ under attack", "Double
  kill for Red", "Blue Fab Plant destroyed", "Blue wins the battle"), with
  full information.
- **Measured** over six AI-vs-AI matches (32 min,
  `callout-rates.ts`): 4.5 delivered lines/min (at most 9 in any 60 s, in
  end-game sieges), 1.2 banners/min (at most 5 in 60 s), and 9–13
  unprompted chirps/min with a follow-cam. Spectators: 3.1 lines/min and
  1.7 banners/min. The test suite replays a match and fails if this drifts.

### Battle awareness & tempo

On a 6" screen you can't see the fight you should react to, warnings used
to come after the damage, toasts covered the battlefield, and the build-up
dragged. Rules in `src/game/awareness.ts` (engine-free, tested), wired up
in `awareness-view.ts`, widgets in `src/ui/awareness.ts`. Everything is
fog-respecting: hits on your own things, shots your units fire, and only
enemies you can currently see.

- **Game speed:** a chip beside the clock cycles 1× → 1.5× → 2× (spectators
  also 4×), remembered per mode in `localStorage` (`battledrones.speed`);
  **press and hold the clock** for 3× while held; `.` cycles. At most 8 sim
  ticks run per frame and a backlog beyond that is dropped, so a slow phone
  slows down instead of spiralling. Weapon and impact sounds space out by
  the speed factor (`sfx.setTempo`) and get 11 voices instead of 14 above
  1×. Detection windows everywhere are sim seconds, so nothing else changes.
- **Inbound warning:** when visible armed enemies (anything that can hit a
  ground target) come within 12 tiles of a building or harvester, the group
  (single-link, 5 tiles) is warned once, with counter advice by domain and
  lead kind: "Enemy drones inbound — Flak, Raptors or a Turret", "Enemy
  Titans inbound — Lancers, Wasps or Hornets"… A group seen in the zone
  within 20 s isn't new; one that has been shooting your things for 1.5 s is
  a fight, not a raid; loud warnings are at least 12 s apart (quieter ones
  still get an arrow). The first raid of each kind per match is a banner
  ("DRONES INBOUND", sub-line with the counters, read out by the
  announcer); later ones are a ticker line plus the radio. Each sounds a
  two-whoop siren and pulses the minimap with amber rings. An air raid
  stands in for "Enemy aircraft detected". Measured over 8 AI-vs-AI matches
  (67 min, blue's view): 1.2 loud warnings/min; warning → that group's first
  hit median 3.8 s (p10 0.9, p90 8.0). Lead time is bounded by vision: a
  harvester sees 4 tiles and a Wasp shoots from 3, so the first raid on a
  mining line gets well under a second, while Radar, the HQ's 8.5-tile
  sight or units on watch buy several seconds.
- **Hotspots and edge arrows:** hits on your things (HQ 0.6, other
  buildings and harvesters 0.45, units 0.35 heat), your losses (0.6), and
  shots/kills by your units (0.2/0.4, at the shooter) heat 6×6-tile cells
  that cool 15% per second; warm cells within 8 tiles cluster and a cluster
  over 1 heat is a hotspot, named by the most important thing hit (HQ! >
  Base > Harvesters > Units; only your own shots: Attack). Off-screen
  hotspots (by priority, then heat; at most 3, one per direction) become
  pulsing, tappable 46 px arrows at the edge of the visible battlefield,
  red when you're being hit (dashed for an inbound raid), amber when you're
  attacking. Each slides along the edge past HUD widgets (minimap, zoom
  stack, ticker, chips, banner, anything marked `data-edge-avoid`). Tapping
  one glides the camera there in 350 ms (ease-out) and flashes a ring. The
  **⚡ button** under the zoom buttons cycles through all hotspots, most
  urgent first (a red dot when something of yours is under threat).
  Spectators get amber "Fight" / "Red HQ" arrows for both sides. Measured:
  a camera parked on the HQ has at least one hotspot elsewhere 51% of the
  match.
- **Battle meter:** while at least 2 of your armed units and 2 visible
  enemy ones are in view and shots were fired there in the last 3 s, a slim
  tug-of-war bar under the clock compares Σ cost × HP fraction (turrets and
  SAMs count, harvesters don't), easing over 300 ms and lingering 1.5 s. A
  swing of more than 20 points within 4 s flashes **Turning point!** (green
  toward you, red away; at most every 8 s; ignored when the camera jumps).
- **Ticker:** toasts left the battlefield's centre for a compact,
  left-aligned stack under the scrap pill (portrait) or under the pause
  button (landscape): 13 px, at most two lines each, at most two at once
  (the newest pushes the oldest out), 2.2 s by default, still tappable.
  While a banner shows only the newest line stays. Big moments remain
  `announce()` banners.

### Command UX: squads, build advisor, placement

Commanding on a phone shouldn't be a chore. Rules in engine-free, tested
modules (`src/game/squads.ts`, `src/game/advisor.ts`, `src/sim/placement.ts`);
widgets in `src/ui/command.ts` and `src/game/placement-view.ts`.

- **Squads** (control groups for thumbs): three 42 px chips at the head of
  the chip row. Hold one (400 ms, with a fill, a buzz and a chirp) to save
  the selection; tap to select it; tap twice within 400 ms to glide the
  camera to the member nearest the squad's middle. Each chip shows the most
  common unit's icon (ties: the pricier kind), a count and a health bar
  (Σ HP / Σ max), and glows red for 1 s whenever a member is hit. A unit is
  in at most one squad; holding a chip with nothing selected clears it. A
  one-time hint teaches the gesture the first time two or more combat
  units are selected.
- **Counter advisor:** remembers the enemy units you have actually seen
  (standing on tiles you see right now; scouts and harvesters ignored),
  each for 60 s after its last sighting, plus enemy Turrets and SAM Sites
  from the fog memory. A build button whose counters (from the duel matrix:
  Flak → Wasps, Raptors, Hornets, Menders; Stingers → Flak, Mortars,
  Lancers; Titans → Stingers, Flak, Mortars; Lancers → Titans; Wasps →
  Stingers, Mortars, Titans, Lancers; Raptors → Wasps, Hornets, Menders;
  Hornets → Titans, Mortars; Mortars → Turrets, SAMs; SAM Site → Hornets,
  Wasps) have been seen at least twice gets an amber ⚔ corner (pulsing for
  its first 6 s), and its tab a ⚔ dot, until your own force of that kind
  (built + queued) is worth 75% of what it counters. The long-press card
  says "Counters Wasps (seen ×4)". It is advisory: the same fog-limited
  knowledge the AI adapts its production to.
- **Idle factories:** a Fab Plant or Airpad with an empty queue for 6 s
  while you can afford its cheapest combat unit puts a pulsing amber
  **IDLE** tag on the Vehicles or Aircraft tab.
- **Placement on touch:** tapping a ready structure drops the ghost on the
  best valid spot near the middle of the view (closest to it, avoiding
  spots that would wall a lane shut), gliding there if it's off screen; the
  build-range zone is tinted and outlined. A tap on the map moves the ghost
  (snapping one tile onto a valid spot when that's all it takes), dragging
  the ghost slides it, and tapping the ghost or **✓ Place X** builds. A bad
  spot says why above the ghost and on the chip — *Too far from base*,
  *Blocked*, *Unit in the way*, *Not on water / rock / mud / lava…* — and
  trying to build there shakes the ghost with a low buzz and the radio's
  "Cannot build there". The ghost draws above the fog. A mouse keeps
  one-click placement.

### Commander calldowns

Once an army is sent, the commander still has moves: a **Command meter**
(⚡, 0–100) fills slowly on its own and mostly from *losses* (0.1/s; 0.02
per scrap of your own units and buildings destroyed, 0.007 per scrap you
destroy), and pays for three map-targeted calldowns, each on its own
cooldown. Numbers live in `POWERS` in `balance.ts`.

| Power | Charge / cooldown | Warning | Effect |
|---|---|---|---|
| **Barrage** | 60 / 45 s | 2.5 s | 3 shells over 0.6 s, seeded scatter ±0.9 tiles, 170 explosive splash r 2 each (ground units and buildings) |
| **EMP** | 40 / 40 s | 0.8 s | Enemy units and buildings within 3 tiles freeze for 4 s: no moving, firing, healing or production |
| **Drop Pod** | 70 / 60 s | 2 s | 2 Stingers + a Flak Crawler (2 Lancers + Flak with a Tech Lab) land on open ground you can *see*; a light 60-damage thump under the pod |
| **Sky Hammer** | — / 120 s | 3 s | Online for both sides at 6:00. Units within 2.5 tiles take 260 × (1 − 0.5·d/r), air included; buildings a flat 700 (an HQ loses 22%) |

- **Same rules for both sides.** One `calldown` command, validated by
  `calldownBlocker` (charge, cooldown, the HQ alive, an *explored* target —
  a *visible*, ground-passable one for the pod) for the player and the AI
  alike. Calldowns only hurt the enemy; kills are credited to the firing
  side (its HQ is the killer, so faction stats count them; no unit XP).
- **Every calldown is telegraphed, publicly.** `World.powers.active` and the
  `calldown` FxEvent are visible to both sides through the fog: a reticle
  shrinks to the moment of impact, so landing one and dodging one are both
  skill moments. EMP + Barrage is a real combo (frozen units can't dodge).
- **Looks and sounds:** red reticles and an air-raid siren for the enemy's
  (loud when it threatens your stuff, with a tap-to-jump toast and a
  minimap ping if it's off-screen); gold / cyan / blue for yours, with a
  radio chirp. Shells streak in, the EMP throws a blue-white shockwave and
  leaves frozen things crackling, pods fall in a flame trail and burst open
  in a ring of dust, and the Sky Hammer charges a lance from orbit (rising
  hum) before a beam, a white-out flash and a rolling boom. The camera
  shakes when it lands on screen. Banners: "Sky Hammer online" at 6:00,
  "Enemy Sky Hammer inbound!" (tap to jump), "Direct hit!" when one of
  yours kills 3+ units or 700+ scrap.
- **HUD:** four round 52 px buttons on the right edge (a 2×2 block beside
  the sidebar on landscape phones) under the ⚡ meter, each with a conic
  ring — charge in the power's colour, cooldown in white — and its cost,
  cooldown seconds or the Sky Hammer's unlock countdown. Tap a ready one to
  arm it ("Tap map: Barrage ✕" chip, radius preview under the pointer /
  finger, grey with ✕ where it can't go), tap the map to fire; an illegal
  tap explains why. Long-press for details. Reticles show on the minimap;
  the end screen counts calldowns.
- **AI:** a per-tick dodge reflex (before the decision gate) moves every
  unit inside an enemy reticle ~4 tiles out after 1.1 / 0.6 / 0.4 s
  (Easy / Normal / Hard) — if there's still time. It Barrages the best
  visible ground clump worth ≥ 450 (Easy never), answers a superior force
  at its base or mining line with a Drop Pod (else an EMP), EMPs turrets in
  front of an assault from surplus charge, pods in reinforcements only when
  a fight away from home hangs in the balance, and aims the Sky Hammer at a
  clump worth ≥ 700, else the best production-building hit, else the HQ.
- **Measured** (AI-vs-AI round robin with openers, 5 maps × 30 pairings ×
  2 seeds, 300 games, before → after): 25-minute draws 17 → 1; median
  length 5.7 → 6.0 min, mean 7.8 → 7.3, p90 15.9 → 12.1; the side ahead by
  200+ value at 2:00 / 3:00 / 4:00 went on to win 84 / 88 / 90% → 80 / 84 /
  86%; games where a clear leader lost the lead 11 → 15. About 8.7
  calldowns per AI per match (median 7: Barrage 4.1, EMP 2.7, Sky Hammer
  1.3, Drop Pod 0.7), 56% fired by the side that was behind. The design
  panel's prototypes had burst powers *feeding* the snowball; here the
  meter is loss-weighted and damage telegraphed, and one rule mattered:
  free Drop Pod units for a wave that is already winning pushed the
  2:00–4:00 leader's win rate *up* 2–3 points, so the AI only reinforces a
  contested fight.

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
menders escorting the army; wounded veterans (rank ≥ 2 under 35% HP) falling
back to a Mender behind them or to the HQ, with an idle Mender sent to patch
them up (`ai/veterans.ts`); commander calldowns and a reflex for
dodging the enemy's (see Commander calldowns); salvage sweeps once a fight near home is
over (idle ground units within 8 tiles go for visible, cooled wrecks that
no visible enemy or known turret covers, and harvesters with a light load
detour to a wreck within 3 tiles — never into the enemy for loot).

Difficulty: **Easy** (slow reactions, 75% income, no raids), **Normal**,
**Hard** (fast reactions, +30% income, an extra harvester — shown in the
menu, never hidden). Each difficulty also picks from its own pool of
personalities: AI-vs-AI tournaments (`tools/balance.ts matches`) show
Ironclad, Boom and Balanced are the strongest, so Easy draws from Balanced,
Rush, Air Swarm and Skyforce, and Hard from Balanced, Air Swarm, Boom and
Ironclad. AI-vs-AI games settle in a median of ~6 minutes.

### Match flow

1. Menu: pick a mode (Skirmish | Last Stand | Ops), a map, a difficulty and
   any mutators → Play (or watch the AI play), or play today's Daily Op; in
   Ops, pick an op card → briefing → Start op.
2. Skirmish (and the Daily Op): opener cards over the frozen battlefield
   (Blitz / Industry / Air Wing; tap, or keys 1–3; cards a mutator bans are
   greyed out). The camera already frames the HQ, its home field and the
   factory site, clear of the HUD. Spectated AIs pick instantly. Last Stand
   and Ops have their own set-ups and no cards.
3. The pick rolls out (factory, units, harvesters already mining) and the
   clock starts. Real-time play until one HQ is destroyed (or an op's goal
   is met). Pause any time. Calldowns charge from the first losses; at 6:00
   the Sky Hammer comes online for both sides, so a stalemate can't last.
4. The HQ kill plays as a short cinematic, then the after-action report
   → Rematch (back to the cards) or Menu.

First-time players get contextual hints (command your opener units — or
build a Fab on a classic start — then counters, tech), plus one-time hints
for squads, touch placement, calldowns and salvage.

### Veteran heroes, the finale and the after-action report

Presentation only — the sim just counts `Unit.kills` and faction stats.

- **Callsigns** (`game/heroes.ts`): every unit has one of 48 callsigns,
  chosen by a hash of its id, skipping names its side already used this
  match (then "Viper II"). Shown from rank 2: selection panel "★★ Viper ·
  Lancer · 9 kills", toasts, the report.
- **Promotions** (`game/hero-fx.ts`): a gold VETERAN / HARDENED / ELITE title
  rises over the unit (enemies' only from rank 2, at most 8 at once) and the
  new chevron pops; rank 3 units get a pulsing gold shimmer. Your unit
  reaching rank 2 gets a "earned a callsign" toast; rank 3 an announcement.
  Your named unit dying gives "✝ Viper (Lancer, 9 kills) destroyed" (one
  toast per tick); a visible enemy ace (rank 3 or ≥ 3 kills) dying gives
  "🎯 Enemy ace … down".
- **Finale** (`game/finale.ts`): when an HQ falls the render clocks (tweens,
  sprite anims, particles, tracers) drop to 0.3×, the camera glides and
  zooms onto the wreck (centred in the area the dock leaves free), five
  staged blasts roll across it, then a white flash, a shake, the result
  banner and the stinger at 1.5 s; time eases back and the report appears at
  2.8 s. Input and pause are locked meanwhile; everything runs on the real
  frame delta.
- **After-action report** (`ui/report.ts`, data from `game/chronicle.ts`,
  which samples both armies every 5 s with full information and logs every
  death): an army-strength timeline (SVG, both sides, tap or drag for
  values) with numbered markers for up to three moments — *first blood*,
  the *biggest battle* (most deaths within 20 s and 10 tiles, with each
  side's losses and where), and the *turning point* (the lead passing to the
  other side and holding 30 s) or, if it never changed hands, when the
  winner *pulled ahead* (≥ 1.5× and 400 up to the end); the MVP card (most
  kills, fallen or alive) and the enemy's ace; stats with correct kill
  counts plus any numeric stats other features add to `FactionStats`; and
  one rule-picked tip (no anti-air vs an air force, harvesters lost, idle
  factories, banked scrap, Titans unanswered, …). Spectators get both
  MVPs and a one-line story per commander instead of a tip. Buttons stay
  pinned at the bottom of the scrolling panel; landscape uses two columns.
  `addReportSection()` lets later features add blocks (career medals).
  The Last Stand end screen shows the run's MVP card too.

### Last Stand (survival mode)

A second mode for short, replayable sessions: no enemy base or economy, just
endless themed waves against your base. The score is **waves survived**; the
best per map and difficulty is saved on the device and shown on the menu
(selector line and map-card badges) and on the end screen ("New record!").

- **Waves** (`src/sim/modes/survival.ts`, a pure, seeded wave director called
  from `step()` only when `World.survival` is set): the first lands at 1:35
  (Easy 1:50, Hard 1:25), then one every 50 s (60 s after a boss). Each block
  of five is a seeded shuffle of **Air Raid** (wasps, then hornets and
  raptors), **Armour Column** (stingers, lancers, titans), **Artillery**
  (mortars with escorts) and **Mixed Assault**, then a **Boss** wave (Titan
  Spearhead, Bomber Wing or Elite Strike Force, in a seeded order). Wave 1 is
  always a small ground wave.
- **Budgets** grow as (240 + 228·n^1.3) scrap × difficulty (0.7 / 1 / 1.3),
  boss waves ×1.1; units arrive at veterancy rank 1 from wave 6 and rank 2
  from wave 12, bosses one rank higher. They are ordinary units under the
  normal rules — no stat cheats.
- **Spawning**: waves enter from map-edge sites (corners and edge midpoints
  far from the HQ, each snapped to ground the HQ can be driven to from) picked
  per wave, never the same edge twice running. At most **30** wave units live
  at once (phone frame rate); the rest queue off-map and stream in.
- **Marching**: a wave moves as a formation — units more than 3 tiles ahead of
  its rear wait — until it is within 12 tiles of its objective, under fire,
  or 50 s old. Then each unit picks targets: air raids hunt harvesters,
  artillery shells turrets and SAMs, columns hit the nearest structure,
  bosses go for the HQ. (Measured: strung-out waves were trivially farmed.)
- **Announcements**: the next wave's theme is in the top-bar pill from the
  start of its countdown ("Wave 8 · 0:42 / ✈ Air Raid"); 15 s ahead a banner
  names it and its edge, the pill pulses red, a minimap arrow and an
  above-the-fog map marker point at the entry. Clearing the field pays
  60 × wave scrap ("Wave 7 cleared · +420") with a counter tip for the next
  theme, and brings the next wave within 30 s. With the field clear, the
  **Call wave** chip brings it now for (5 + n) scrap per second skipped.
- **AI**: a defending commander (spectator "Watch AI defend", and the tuning
  harness) never raids or assaults, adds turrets and SAMs to its build,
  holds a line toward the announced edge, engages wave units it can see near
  the base, and calls waves early when its army is ≥ 1.8× the next budget.
- **Tuning** (`npx vite-node tools/survival.ts both all all 3`): a scripted
  "decent phone player" survives a median of ~10 waves on Normal (8–16), ~9
  on Hard and ~18 on Easy; the Normal Balanced AI ~15. Proving Grounds (30k
  scrap in total) is the hardest map; the rich Dune Sea the easiest.

### Career, medals, mutators and the Daily Op

Reasons to come back between matches. Spectated games never count.

- **Medals** (`sim/awards.ts`, pure functions of an end-of-match recap built
  from the chronicle): ⚡ Lightning War (win < 5:00), 🛡️ Untouchable (win, no
  building lost), 🔄 Comeback (win after your army fell to ≤ ½ of theirs and
  800+ behind, after 1:30), 💎 Flawless (win losing ≤ 5 units), 💰 Tycoon (win
  harvesting 2× theirs), and — in defeat too — 🎖️ Ace (one unit, 9 kills),
  🗿 Giant Slayer (3 Titans), ✈️ Air Superiority (30 aircraft), 🧱 Iron Wall
  (defences kill 30), ☠️ Exterminator (60 kills), 🏚 Wrecking Crew (12
  buildings); Last Stand 🏰 Holdout (10 waves) and 🗼 Unbreakable (20).
  Thresholds were calibrated on 40 AI-vs-AI matches so a typical win earns
  one or two and the rest are goals.
- **Career** (`game/career.ts`, localStorage `battledrones.career`, pure math
  + try/catch storage): XP = win 100 / loss 30 (scaled down for losses under
  5:00) × difficulty (Easy 1, Normal 1.5, Hard 2.2), Last Stand 10 per wave
  × difficulty, +25 per medal, +100 for the day's first Daily Op win. Ten
  ranks — Cadet, Private, Corporal, Sergeant, Lieutenant, Captain, Major,
  Colonel, General, Marshal (100 … 6,000 XP) — with chevron / bar / star
  insignia. Three **stars** per map × difficulty: win, win under 8:00, win
  without losing a building (classic rules only). Wins/losses, medal counts,
  Last Stand totals (bests stay in `battledrones.laststand`) and the Daily
  streak. Banked once when the HQ falls (`game/meta.ts settleCareer`).
- **Menu** (`ui/career.ts`): rank badge with XP bar under the logo (tap: the
  Career sheet — medals, star grid, Last Stand bests, rank ladder), the Daily
  Op card, a mutator picker, ☆☆☆ on each map card for the chosen difficulty.
  Landscape puts these in a column over the key art.
- **End screen**: a career block heads the after-action report (and the Last
  Stand screen): XP counts up and the bar fills, a promotion swaps the
  insignia with a PROMOTED ribbon and glow, medals pop in one by one (NEW on
  a first), new stars pop, the Daily streak shows. Spectators see each
  side's medals instead.
- **Mutators** (`sim/rules.ts`, `World.rules`, via `MatchOptions.mutators`;
  absent = classic, read through `rulesOf(w)`): ⚡ Blitz (3,000 starting
  scrap), 💰 Gold Rush (income ×1.5, multiplied on top of the AI's own
  `incomeMult`), 💥 Glass Cannons (damage ×2), 🔧 Rapid Fab (build progress ×2
  per tick), ✈️ Air War (no ground combat units, Fab Plants or SAM sites —
  measured: with SAMs every AI-vs-AI air war drew at 25:00), 🎖️ Veterans
  (combat units roll out at rank 1), ☀️ Clear Skies (no fog for either side).
  Skirmish only; both sides obey them (`unitBlocker`/`buildingBlocker` say
  "Disabled: Air War", the HUD shows ⛔). The AI picks a personality whose
  plan survives the rules (`strategyFits`: no Rush/Ironclad in Air War) and,
  in Air War, plays the air-only plan with more bombers and one big wave.
  Shown in an opening banner, the pause screen and the end screen.
- **Daily Op** (`game/daily.ts`): the local date hashes into a map, an AI
  personality, Normal or Hard, two compatible mutators and the match seed —
  the same match for everyone. Its own rematch, +100 XP for the first win of
  the day, and a win streak that survives until a whole day passes without
  a win. No stars (it is always mutated).
- AI-vs-AI sanity (50 matches each, 25:00 cap): classic 48/50 decisive,
  median 5.6 min; Blitz 47, Gold Rush 46, Glass Cannons 43, Rapid Fab 48
  (median 4.2), Veterans 46, Clear Skies 47; Air War 13/20. The next 21
  Daily Ops all finished (median 4.7 min).

### Ops (a short scenario campaign)

Eight handcrafted 3–7 minute missions on the existing maps and units, each
with a twist objective and three stars: ★ complete it, ★★ and ★★★ two harder
conditions. They teach the counter web through play and give the game a
completion goal.

- **Data, not code paths** (`sim/ops.ts`): an `OpDef` is a map, an enemy (an
  AI commander with a fixed personality and difficulty, optionally tweaked —
  e.g. one that never attacks — the Last Stand wave director, or nobody),
  rules (per-side bans, a frozen economy, mutators: `World.rules` gained
  `sideBans`, `sideIncome` and `banLabel`, so `unitBlocker`/`buildingBlocker`
  say "Disabled in this op" and bind the AI on its side too), a `setup` that
  pre-places buildings and units and tags what must be protected, primary
  goals and two star conditions. `createMapWorld(map, { op })` builds it.
- **Goals** are pure functions of the world, checked once a second by
  `tickOps()` (called from `step()` only when `World.ops` is set): destroy the
  HQ, destroy N of a kind, survive N seconds, survive N waves, deliver N
  scrap, protect a tagged group (or ≥ N of a kind), within N seconds, lose at
  most N units / of a kind / buildings. Meeting every achievement goal wins;
  breaking a condition (time, protected group, losses) loses; an HQ kill still
  ends it the classic way. The result sets `World.winner`, so the finale
  (without HQ blasts when no HQ died), report and career run unchanged.
- **The ops** (verified by `tests/ops.test.ts`: each sets up on legal ground,
  runs, is completed with ★★+ by at least one stand-in pilot — an AI
  commander or a scripted player from `tests/ops-pilots.ts` — and is *lost*
  by doing nothing; `npx vite-node tools/ops.ts` prints the numbers):

| # | Op | Map | Enemy | Objective | ★★ / ★★★ |
|---|---|---|---|---|---|
| 1 | 🌉 Bridgehead | Riverlands | Rush, Hard, bigger waves | Hold 4:00 with a bridge turret standing (forward outpost pre-placed) | lose ≤ 6 · both turrets |
| 2 | 🌙 Harvest Moon | Dune Sea | Air Swarm, Hard, early Wasps | Deliver 10,000 scrap by 5:00 | ≤ 1 harvester lost · by 4:00 |
| 3 | 🎯 Decapitation | Proving Grounds | Balanced, Easy, never attacks | Strike group, no production: HQ by 3:00 | lose ≤ 4 · under 2:00 |
| 4 | ❄ Frozen Assets | Frostbite | Boom, Normal | 3,000 scrap, no income or harvesters: HQ by 6:00 | 4 harvesters killed · under 4:00 |
| 5 | 🏴‍☠️ Sky Pirates | Ashlands | Balanced, Easy, digs in on half income | No Fab Plants (air only), pre-placed SAMs: HQ by 7:00 | lose ≤ 12 · under 4:30 |
| 6 | 💥 Glass Jaw | Dune Sea | Rush, Normal | Glass Cannons + Rapid Fab: HQ by 6:00 | lose no building · under 4:00 |
| 7 | 🛡 Iron Tide | Frostbite | Ironclad, Hard | Hold 6:00 (Fab Plant + Tech Lab given) | 2 Titans killed · ≤ 1 building lost |
| 8 | 🕯 Last Light | Riverlands | Last Stand waves (Easy budgets, first at 0:45, every 40 s) | Survive 10 waves from a dug-in base | ≤ 2 buildings lost · under 7:00 |

- **Measured** (stand-in pilots, `tools/ops.ts`, 3 seeds): idle play loses
  every op; the scripted pilots clear all eight every time (Bridgehead ★★–★★★
  at 4:00, Harvest Moon ★★ ~4:05, Decapitation ★–★★ ~1:45, Frozen Assets ★★
  ~1:50, Sky Pirates ★★ ~3:05, Glass Jaw ★★★ ~3:00, Iron Tide ★★★, Last
  Light ★★ ~7:25); a stock Balanced AI commander clears six of the eight at
  least once — it leaves the bridge to attack in Bridgehead and wastes its
  fixed budget in Frozen Assets.
- **Campaign**: the first three ops are open; every op completed opens one
  more. Progress (best star mask, best time, attempts) lives in the career
  (`CareerData.ops`); XP: 60 per clear, +100 the first time, +40 per new star,
  a little for a failure. Ops award no medals, map stars or skirmish W/L.
- **Menu** (`ui/ops.ts`): a third mode, 🎖 Ops: progress line, op cards in
  the map-card style (number, icon, stars or 🔒), the picked op's tagline and
  enemy; tapping the picked card or Play opens the briefing sheet (brief,
  rules, objective, star conditions with your best, a tip, Start op; two
  columns in landscape).
- **In match**: a briefing banner (`op-start`); a goal pill under the clock
  in portrait (top-left corner under the pause button in landscape, where the
  top bar is a full row): the objective and its clock, the other conditions,
  and three live stars (gold while the condition holds, struck out when
  lost). Tapping it opens the objectives card. "★★ lost" / "★★★ secured"
  toasts, a one-minute call-out (`op-timer`), the camera opens on the action
  (`OpDef.focus`). No tutorial hints in ops. The pause screen lists the goals.
- **End screen**: "OP COMPLETE" / "OP FAILED" heads the after-action report,
  with the reason, big stars (new ones pop), the star conditions, your best,
  "New op unlocked", the op's tip after a failure, and Next op / Retry / Main
  menu. Rematch tokens are `op:<id>`.

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
| Tap | Map, while placing | Move the ghost there (no build yet) |
| Tap / drag | The ghost | Build it / slide it |
| Long-press / tap / double-tap | Squad chip 1–3 | Save the selection / select the squad / fly the camera there |

Disambiguation: a touch is a *tap* if it moves < 8 px and lasts < 250 ms;
movement beyond the slop radius before the long-press timer fires commits
to *pan*; after the timer fires it commits to *box-select*. Hit-testing
uses an enlarged (≥ 24 CSS px) radius, and aircraft are tested where they
are drawn (lifted above their shadows).

Context **chips** above the build bar, after the three squad chips: Stop /
Move only / deselect for units; Sell (+refund) for buildings (producers
show "Tap the map to set a rally point" in the selection panel instead of a
chip); "Select army" and "💤 Idle N" when nothing is selected;
"✓ Place X" (or why not) + cancel while placing. Under 400 px wide the
labels shorten ("Move", "Army") so everything stays on one row down to
360 px.

### Mouse & keyboard

Left-click select, left-drag box-select, right-click command, wheel zoom,
middle-drag or arrows/WASD pan, +/− zoom, P or Space pause, Q select army,
Delete sell, Esc cancel/deselect, `.` game speed, J jump to the action,
1–3 select a squad (twice quickly: fly there), Ctrl/Cmd/Shift+1–3 save
one (Shift for browsers that keep Ctrl+digit for tabs). While placing, the
ghost follows the mouse, a click builds and a right-click cancels. Hold
the clock to fast-forward. Right-click a build button for its card, or a
squad chip to save into it.

### HUD layout — portrait and landscape both first-class

DOM overlaid on the canvas, re-flowing by orientation:

- **Portrait:** a bottom dock — selection panel and chips above a tabbed
  build bar (Base / Vehicles / Aircraft) with unit portraits, costs, lock
  icons, queue badges and progress fills. Minimap top-right; scrap,
  income rate and clock top-left.
- **Landscape:** the build bar becomes a right-edge sidebar with a 2-column
  grid; selection panel and chips sit bottom-right beside it.
- **Calldown buttons:** the ⚡ meter and four round power buttons, right
  edge and vertically centred in portrait; a 2×2 block under the minimap,
  beside the sidebar, on landscape phones.
- A ticker of short toasts top-left for "building ready", attacks (tap to
  jump there) and hints; minimap pings where you're being hit (amber double
  rings for an inbound raid). The clock row carries the game-speed chip, a
  battle meter hangs under it during on-screen fights, edge arrows point at
  off-screen fights, and ⚡ under the zoom buttons jumps to the action. The scrap pill bumps when a
  harvester delivers and flashes red when scrap is spent.
- **Sound:** the top-left speaker (in game and on the menu) is a one-tap
  master mute. The pause menu has four toggles, persisted in
  `localStorage` (`battledrones.audio`): Sound (master), Music (score and
  ambience), Effects, and Voice. Voice cycles through Voice (announcer
  speech and unit chirps), Chirps (no speech: unit chirps and radio codes)
  and off, and plays a "radio check" sample.

### Minimap

Painted-map thumbnail under the fog, resource fields, salvageable wrecks
(gold dots), buildings and unit blips (fog-respecting), calldown reticles
(red = enemy, gold = yours, shown through the fog), attack pings and the
camera frame.

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
    modes/survival.ts # Last Stand wave director (pure, seeded)
    rules.ts        # match mutators (World.rules) and their hooks
    ops.ts          # the Ops campaign: op definitions, goals, tickOps
    awards.ts       # medals from an end-of-match recap (pure)
    economy.ts      # scrap, harvesting, depots, tech rules, build queues, selling
    movement.ts     # terrain-weighted A* (ground/hover/air), steering
    combat.ts       # targeting, armor, splash projectiles, healing, veterancy
    fog.ts          # per-side visibility maps + building memory
    placement.ts    # why a spot can't be built on, and a suggested spot

    salvage.ts      # battlefield wrecks: spawn, cool, pick-up, burn-out
    powers.ts       # command meter, calldowns (Barrage/EMP/Drop Pod), Sky Hammer, EMP stuns
    ai/commander.ts # the enemy commander: strategies, difficulty
    ai/veterans.ts  # wounded veterans fall back to a Mender or the HQ

    ai/salvage.ts   # the commander's wreck sweeps
    ai/powers.ts    # the commander's calldowns and its dodge reflex
  game/       # Phaser: scene, camera, input, rendering
    render/         # world-view (terrain, piles, fog), entities, fx, juice-view, wrecks, powers (reticles, strikes)
    juice.ts        # hit flash / damage trail / combat ring / cue rules (tested)
    audio.ts        # AudioContext, sfx/music/voice buses, settings, procedural SFX
    score.ts        # music rules: harmony, patterns, stingers, battle mood (tested)
    music.ts        # adaptive score: lookahead scheduler + synth voices
    ambience.ts     # biome ambience beds
    voices.ts       # unit chirp-voices: formant synth, line plans, rate limits
    callouts.ts     # announcer moments, kill streaks, radio queue (tested)
    announcer.ts    # radio announcer: squelch + speechSynthesis / radio code
    awareness.ts    # game speed, hotspots, inbound warnings, battle meter rules (tested)
    awareness-view.ts # wires them to the camera, HUD, radio; camera glide
    squads.ts       # squad (control group) rules (tested)
    advisor.ts      # counter advisor + idle-factory watch (tested)
    placement-view.ts # placement ghost: suggested spot, touch move/drag/confirm
    heroes.ts, hero-fx.ts  # callsigns; promotion titles and hero toasts
    chronicle.ts    # match recorder + story analysis for the report
    finale.ts       # the cinematic HQ kill
    career.ts, daily.ts, meta.ts  # XP/ranks/stars storage, the Daily Op, match glue
    ops.ts          # Ops narration: briefing banner, countdowns, star notices
  ui/         # DOM HUD (hud.ts; awareness.ts: speed chip, edge arrows, meter; command.ts: squad chips, advisor badges; powers.ts: calldown buttons), after-action report (report.ts), career UI (career.ts), Ops UI (ops.ts), menu styles
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
  open), a story campaign (Ops are standalone missions), map editor,
  replays, saves mid-match.
- Upgrades research, buildable superweapons (the Sky Hammer is a timed
  HQ power), walls.
