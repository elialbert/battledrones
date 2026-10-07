# Battle Drones

A mobile-friendly real-time strategy game in the Command & Conquer
tradition: two armies of drones — flying and ground-based — battle for
territory and resources. Single-player skirmish against an AI commander,
built for phone browsers (touch-first, portrait or landscape) and
installable as a PWA.

**Play it: <https://simonw.github.io/battledrones/>**

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
  rules and fog of war as you — or watch two AIs fight.
- **Veteran heroes**: units that rank up earn callsigns ("★★ Viper ·
  Lancer · 9 kills"), promotions pop over the unit, elites shimmer gold, and
  you hear about it when a named unit falls; the AI pulls its wounded
  veterans back too.
- **A cinematic HQ kill** (slow motion, camera glide, rolling blasts, white
  flash) and an **after-action report**: an army-strength timeline with
  first blood, the biggest battle and the turning point marked, your MVP
  unit, correct kill stats and one tip for next time.
- **Last Stand** survival mode: hold your base against endless, announced
  waves — Air Raids, Armour Columns, Artillery, Mixed Assaults and a Boss
  every fifth wave — from shifting map edges. Call waves early for bonus
  scrap; your best per map and difficulty is saved.
- **A Commander career**: XP and ten ranks from Cadet to Marshal, 13
  medals (Lightning War, Comeback, Ace, Giant Slayer…) popping in on the end
  screen, three stars per map and difficulty, and a **Daily Op** — one seeded
  match a day, the same for everyone, with a win streak.
- **Seven mutators** to twist a skirmish for both sides: Blitz, Gold Rush,
  Glass Cannons, Rapid Fab, Air War, Veterans and Clear Skies.
- **Ops**: a campaign of eight short missions with a twist and three stars
  each — hold the Riverlands bridge against a Rush, deliver 10,000 scrap under
  Air Swarm raids, decapitate a base with a fixed strike group, win on a
  frozen 3,000-scrap budget, raid with aircraft only, survive Ironclad on Hard,
  and a 10-wave Last Light. A goal pill with live stars, a briefing sheet,
  "Next op" on the end screen; ops unlock as you clear them.
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
npm run balance matches [map]   # AI-vs-AI round robin
npx vite-node tools/survival.ts [ai|human|both] [map|all] [easy|normal|hard|all] [seeds]
                       # Last Stand: waves survived by an AI / scripted-player defender
npx vite-node tools/ops.ts [op|all] [seeds]
                       # Ops: can the stand-in pilots clear each op, and with how many stars
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
