# Battle Drones

A mobile-friendly real-time strategy game in the Command & Conquer
tradition: two armies of drones — flying and ground-based — battle for
territory and resources. Single-player skirmish against an AI commander,
built for phone browsers (touch-first, portrait or landscape) and
installable as a PWA.

**Play it: <https://simonw.github.io/battledrones/>**

- **Pick an opener, play from second one**: every match starts on three
  cards — Blitz (Fab Plant + 3 Stingers), Industry (a third harvester +
  scrap) or Air Wing (Airpad + 3 Wasps) — and the AI picks its own.
- **Battlefield salvage**: destroyed vehicles and downed drones leave
  burning wrecks worth 30% of their cost — roll any ground unit over one
  to scoop up the scrap. Hold the field after a fight and it pays.
- **Fight for the middle**: capturable 📡 **Uplink relays** on every map
  pay scrap, light up the fog and charge your calldowns while you hold
  them, and from 1:30 a pair of 📦 **supply drops** parachutes in every
  75 s, announced to both sides 10 s ahead: first unit there takes it
  (scrap, Veterans, Field Repair, ⚡ charge, or a rare free Lancer).
- **Commander calldowns**: a meter that fills mostly from your losses pays
  for a Barrage, an EMP or a Drop Pod — tap the button, tap the map — and
  at 6:00 both sides get the **Sky Hammer** orbital strike. Every strike is
  telegraphed with a public warning circle: land yours, dodge theirs.
- **11 units** across a real counter web: Stinger light tanks, Flak
  Crawlers, long-range Mortars, super-heavy Titans, water-crossing Lancer
  hover tanks, Scouts, Wasp strike drones, Raptor interceptors, Hornet
  bombers, Mender repair drones and Harvesters.
- **8 buildings** with a tech tree: HQ, Fab Plant, Airpad, Tech Lab,
  forward Depots, Turrets, SAM Sites and Radar.
- **5 maps in 4 biomes** — Riverlands, Dune Sea, Frostbite, Ashlands and
  the classic Proving Grounds — with terrain that matters: roads, mud,
  woods (cover), fords, bridges, water/lava that only hover and air units
  cross, and rich crystal fields.
- Armor classes and damage types, dodgeable artillery shells and bombs,
  splash damage, veterancy, retaliation AI for idle units.
- An AI commander with **6 personalities** (Balanced, Rush, Air Swarm,
  Boom, Skyforce, Ironclad) and **3 difficulties**, playing by the same
  rules and fog of war as you — it gathers real waves, fights for the
  Uplinks and calls down strikes — or watch two AIs fight. Matches are
  tuned for comebacks: the side ahead at 4:00 now wins 78% of AI-vs-AI
  games, not 90%.
- Painted art generated with OpenAI's `gpt-image-2.5-sunburst`, rendered
  at device resolution with turrets that track their targets, shadows,
  particles, smooth fog of war — and fully synthesised sound effects.

## Development

```bash
npm install
npm run dev            # Vite dev server
npm test               # Vitest suite for the simulation layer
npm run build          # typecheck + production build into docs/
npm run smoke          # headless Playwright test of the real touch flow (against docs/)
npm run balance duels  # cost-equal unit duel matrix
npm run balance matches [map]   # AI-vs-AI round robin (openers + objectives; --classic / --no-objectives)
npx vite-node tools/pacing.ts run out.jsonl --seeds 8 --shard 0/4   # pacing & snowball panel (shard across processes)
npx vite-node tools/pacing.ts summary out*.jsonl                    # …the table in DESIGN.md "Balance & pacing"
npm run maps           # export map grids to art/maps/*.json (--ascii to preview)
node tools/shots.mjs   # screenshot tour against the dev server (SPECTATE=1, MAP=...)
node tools/showcase.mjs  # staged close-up skirmish for checking weapon effects
```

The built site in `docs/` is committed so GitHub Pages serves it directly
with no build step — rebuild and commit `docs/` when shipping changes.

Art pipeline (Python 3 + Pillow/numpy/scipy, `OPENAI_API_KEY` for
generation) — see **ART.md**:

```bash
npm run art:generate   # call the OpenAI Images API for any missing raw art
npm run art:process    # raw art → sprite atlas, icons, key art, PWA icons
npm run art:terrain    # paint every map's terrain from its grid
```

- **`DESIGN.md`** — the game design: roster, terrain, combat model, AI,
  controls spec, architecture.
- **`ART.md`** — how every image was generated and processed, and the
  asset contracts the engine relies on.

## Architecture

- `src/sim/` — the deterministic game simulation: pure TypeScript, no
  engine imports, fixed 10 Hz tick, command-queue input. All tunable
  numbers live in `src/sim/balance.ts`; maps in `src/sim/maps.ts`. The AI
  commander (`src/sim/ai/commander.ts`) plays by the same rules and fog as
  the player. Fully unit-tested.
- `src/game/` — Phaser 3 rendering and input: hi-DPI canvas, interpolated
  view of the sim (`render/`), gesture recognizer (`gestures.ts`,
  engine-free and tested), camera, particles, procedural audio
  (`audio.ts`).
- `src/ui/` — DOM-overlay HUD and menu, with portrait/landscape layouts in
  CSS.
- `art/` — the image-generation and processing pipeline; `tools/` — map
  export, balance harness, smoke test and screenshot tour.
