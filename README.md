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
  telegraphed with a public warning circle: land yours, dodge theirs. The
  radio shouts "Incoming artillery!", the music swells on impact, and
  kill streaks, hero toasts and the after-action report name the strike.
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
- **A Commander career**: XP and ten ranks from Cadet to Marshal, 16
  medals (Lightning War, Comeback, Ace, Giant Slayer, Orbital, Scavenger,
  Steady Hands…) popping in on the end
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
- **A 3D battlefield in three.js.** Every unit, building and map objective
  is a procedural low-poly 3D model in the painted style (gunmetal hulls,
  royal-blue or crimson team panels, amber lights): turrets track their
  targets and kick on recoil, rotors spin, aircraft fly at altitude, bank
  into turns and cast shadows on the ground, tanks tilt over the terrain,
  buildings rise out of the ground when placed and smoke when hurt. The
  landscape is a heightfield draped with each map's painted terrain — rock
  outcrops rise into mesas whose cliffs and crags are textured with the
  painted stone of their biome, rivers and lava cut real channels under
  animated water, drifting ice floes or crusted, glowing lava, fords dip
  under a shallow skin of water, bridges are decks laid along each
  crossing, and the land carries on past the map's edge — with instanced
  trees per biome, salvage heaps and glowing crystal clusters that shrink
  as they're mined, real-time sun shadows, drifting cloud shadows, layered
  GPU explosions and smoke, and a fog of war that drapes unexplored ground
  in a drifting shroud. A tilted RTS camera steepens as you zoom out;
  resolution adapts to keep weaker phones smooth. Terrain, menu art and
  icons were painted with OpenAI's `gpt-image-2.5-sunburst`; every sound
  is synthesised live.
- An **adaptive soundtrack** synthesised live: each biome has its own mode,
  chords and instruments; bass, drums and an arpeggio join as fights heat up
  near your camera, an alarm motif plays when your base is under attack,
  and matches end on a fanfare or a lament. Quiet biome ambience (wind,
  birds, desert hiss, lava rumble) fills the lulls; Music / Effects / Voice
  toggles live in the pause menu.
- Punchy, readable fights: hit flashes, damage-trail health bars, team
  rings under units in combat, kill and loss cues that sound different,
  on-screen-only camera shake, and gold "+100" pops with a rising coin
  chime when your harvesters deliver.
- **Voices and a radio announcer.** Every unit class answers in its own
  synthesized robot voice when selected, ordered, built or promoted. Titans
  growl, Wasps buzz and Menders ring. A radio commander calls out what
  matters: "Warning: our HQ is under attack", "Enemy aircraft detected",
  "Squad lost", "Construction complete". Kill streaks get banners: First
  blood, Double kill, Triple kill, Rampage, Titan down. Spectators get a
  neutral caster.
- **Battle awareness and game speed.** Pulsing arrows at the screen edge
  point at off-screen fights (red when you're hit, amber when you attack);
  tap one, or ⚡, to glide there. "Enemy drones inbound — Flak, Raptors or a
  Turret" warns before a raid lands, a tug-of-war meter shows who is
  winning the fight on screen, and alerts sit in a slim ticker instead of
  over the battlefield. Play at 1×, 1.5× or 2× (4× when watching), or hold
  the clock to fast-forward — the game drops back to 1× by itself when an
  enemy strike, a raid or an attack on your HQ needs your hands. First-time
  tips arrive one at a time, never over a banner.
- **Thumb-friendly command.** Three squad chips: hold to save a group, tap
  to select it, double-tap to fly there; each shows its unit, count and
  health and flashes red when hit (keys 1–3). Build buttons glow with ⚔
  when they counter enemies you've seen ("Counters Wasps (seen ×4)"), tabs
  flag an idle factory, and building placement on a phone puts the ghost
  on a good spot for you: tap or drag to move it, tap it to build, and a
  bad spot tells you why.

## Development

```bash
npm install
npm run dev            # Vite dev server
npm test               # Vitest suite for the simulation layer
npm run build          # typecheck + production build into docs/
npm run smoke          # headless Playwright test of the real touch flow (against docs/)
npm run balance duels  # cost-equal unit duel matrix
npm run balance matches [map]   # AI-vs-AI round robin (openers + objectives; --classic / --no-objectives)
npx vite-node tools/survival.ts [ai|human|both] [map|all] [easy|normal|hard|all] [seeds] [--calldowns]
                       # Last Stand: waves survived by an AI / scripted-player defender
npx vite-node tools/ops.ts [op|all] [seeds]
                       # Ops: can the stand-in pilots clear each op, and with how many stars
npx vite-node tools/beginner.ts [novice|beginner|decent] [easy|normal|hard] [seeds]
                       # difficulty on-ramp: a scripted phone player vs the AI on every map
npx vite-node tools/pacing.ts run out.jsonl --seeds 8 --shard 0/4   # pacing & snowball panel (shard across processes)
npx vite-node tools/pacing.ts summary out*.jsonl                    # …the table in DESIGN.md "Balance & pacing"
npx vite-node tools/pacing.ts run out.jsonl --seeds 8 --mirror      # side fairness: each personality vs itself
npm run maps           # export map grids to art/maps/*.json (--ascii to preview)
                       # model gallery: npm run dev, then open /tools/models.html
                       # vehicles reference page: /vehicles.html (built into docs/ too)
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
npm run art:terrain    # paint every map's terrain from its grid (then refreshes the rock textures)
npm run art:textures   # just the biome rock textures the 3D cliffs and crags use
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
- `src/game/` — three.js rendering and input: the 3D engine in `three/`
  (stage and adaptive resolution, RTS camera rig, procedural models,
  heightfield terrain, fog-of-war shader patch, instanced particles, ground
  marks, screen overlay), the interpolated view of the sim (`render/`),
  gesture recognizer (`gestures.ts`, engine-free and tested), procedural
  audio (`audio.ts`).
- `src/ui/` — DOM-overlay HUD and menu, with portrait/landscape layouts in
  CSS.
- `art/` — the image-generation and processing pipeline; `tools/` — map
  export, balance harness, smoke test and screenshot tour.
