# Rush, greed, turtle: a rock-paper-scissors economy

Handoff plan (2026-10-29). Today two early depots are optimal in almost every
game, and no rush wins. This doc records why, what was measured, and the
changes that should make three openings counter each other:

- **Rush beats Greed.** Take four harvesters off mining to build a fast second
  depot, and a rusher should turn up at your door at the worst moment.
- **Greed beats Turtle.** Build a ring of turrets and race for the Goliath,
  and the greedy player's economy and map coverage should shut that down.
- **Turtle beats Rush.** Hold the rush, and you come out with the better
  economy and tech, then lash out.

The point is the guessing: what is the opponent doing? Do I spend time and
scrap to scout, and when do I scout again? When do I expand? Those are minigames
nested inside the opening choice. This is not a StarCraft copy: there is one HQ
until the Gantry, no extra command centres, and expanding means a depot at a
new field.

## Status (2026-10-29, end of session 4): where to pick up

**Everything is uncommitted on main.** Typecheck, `vite build` and the full
test suite (1653) pass. Read "Start here", then the session notes below it
(newest first) for the detail. Older sections further down are history: where
they disagree with "Start here", "Start here" wins.

### Start here

**The rules as they stand** (decided by the user):
- **Depot** (build menu, 250): an ordinary building, in the build zone.
  **⛏ Deploy Depot** (4+ Harvesters, chip or **V**): the way past it; the
  crew is used up, 250, 28 s to go up at 25% HP.
- **Build zone:** 6 tiles round the HQ, 3 round every other building;
  **a Turret reaches 2 farther** (`ECONOMY.turretReach`, `buildRadiusOf(b, kind)`;
  the ghost's zone overlay shows it). Wasteland rings every field.
- **Economy:** `harvestRate` 18, `scrapPerTile` 1250, `crystalPerTile` 1000.
- **Stinger:** speed 2.3 → **2.8**, buildTime 7 → **11**, armour medium →
  **light**. **Turret:** `lightMult` 1.5 (new `ArmedStats.lightMult`: ×1.5
  against light armour). A lone Stinger now loses a 1v1 to a Mortar by a hair
  (cost for cost it still wins).
- **Chokepoints (map design):** rock ridges wall each base on Riverlands,
  Dune Sea, Frostbite, Ashlands and Compass Rose, with 1–2 gates of 3–5 tiles,
  13–19 tiles from the HQ: one or two buildings (a Turret chained off a Turret)
  before a Turret covers a gate. The home field is inside; on Riverlands and
  Dune Sea the natural is **outside** (expanding means leaving your walls).
  Frostbite: a pass through the woods in the west lane and a gap on the road.
  Ashlands: a gate on each road (its bridges are the mid-map chokes); Riverlands
  has its bridge and fords, Dune Sea its mesas. Archipelago and Proving Grounds
  unchanged (bridges; tests pin Proving Grounds). Art re-rendered.
- **Marshal:** `ai/choke.ts baseEntrances` finds a base's gates (minimum
  vertex cut between the core and the map past 30 tiles; mirror-fair).
  **Rush** is now mass Stingers (Depot, 3 Fab Plants, 7 harvesters, one wave
  at 1500, then an expansion). **Turtle** holds its gate (`holdChoke`: guard
  and idle army there, Turrets anchored to it), a Turret per 2 tanks seen
  (`turretsVsGround`), Mortars (`mortarShare` 0.35), 6–7 harvesters. New
  knobs, unused by stock plans: `raidFrom`.

**The triangle now** (Hard, 24 games, stock plans): Rush–Greed **10–12**,
Rush–Turtle **14–9**, Greed–Turtle **16–8**. The user's call: Turtle at
about even with Rush is fine (it is the weaker plan); Rush and Greed are
level. Only on the walled maps does Turtle hold Rush; on open ones it loses.

**Next, in order**
1. **Play it by hand**: the walls and gates on each map (art and minimap),
   chaining a Turret to a gate (the overlay's longer reach for a Turret),
   Deploy Depot, the faster/slower Stinger's feel, Turtle and Rush as opponents.
2. ~~`MARSHAL_POOL`s~~ Done 2026-10-29: every difficulty now draws from
   every plan (Skyforce included). Easy's 5:00 peace still holds Rush's wave.
3. **Commit, then push with care:** `CODEC_VERSION` is 2, so the site and the
   relay must be redeployed together (a push to main deploys the site; the
   relay is manual). Decide whether `tools/rps/` (untracked) goes in.

**Session 4 (2026-10-29): Stingers, Rush, chokepoints** (harness: `BAL`,
`WALL=R,gap,n` in `tools/rps/rush.ts`; `tools/rps/reach.ts` checks maps)
- Raid-first rushes failed (Greed builds Stingers from 0:00); a sim-only
  3.8-speed "Outrider" raider, likewise (removed). Mass Stingers worked:
  `m3` beat Greed once Stingers were faster (2.8–3.2).
- Turtle lost to it whatever it built (turret buffs, more turrets, Mastodons,
  air, tech first) until bases had gates; then holding the gate, towering it
  (turretReach) and mining as hard as Rush brought it to about even.
- Turret `lightMult` 2.0 or HP 900 helped Turtle against Greed more than
  against Rush (the wrong leg): left at 1.5 / 650. Stinger buildTime 12 made
  Rush lose to Greed 5–16.
- Tests changed for these rules: units placed where the new ridges stand
  (versus-feed lift party, Last Stand sniper), Stinger as "the vehicle"
  (now a Lancer where medium armour mattered), a Turret's longer reach (a
  Radar in the outpost test), Turtle's fast harvesters 7, Nomads test on Dune
  Sea (Riverlands now ends in a mined-out stalemate past 25 min), Robot Love
  lift test on AI seed 2. Ops: Frozen Assets 3,000 → 4,000 scrap (two gates
  each made it a base race), Sky Pirates' second star 4:30 → 5:00.
- A venv for the art lives in `.venv/` (gitignored).

**Re-rendering map art** (only if map layouts change again): `art/terrain.py`
needs numpy, Pillow and scipy, which aren't installed system-wide. Make a
venv (`python3 -m venv <dir> && <dir>/bin/pip install numpy pillow scipy`),
run `npm run maps`, then `<dir>/bin/python art/terrain.py <map ids>` (about
6 min for six maps in parallel). Proving Grounds' layout is pinned
tile-exact by tests: leave it.

**Session 3c: expanding made important (user's call: option 1, keep the simple rules)**
- **Build reach:** the HQ keeps `ECONOMY.buildRadius` 6; every other building
  extends the zone by only `ECONOMY.extendRadius` 3 (`economy.ts buildRadiusOf`,
  used by `inBaseRange`, `placement.ts`, Marshal's `findPlacementSpot`).
  `tools/rps/chain.ts` measures chaining turrets to each field: the new
  outlying patches take 4–6 turrets (900–1,350 scrap, 32–48 s of the build
  queue) against a deploy's 250 + 4 harvesters, ~60 s, no build queue. Radius
  2 only adds 1–3 turrets: distance is the bigger lever.
- **Fields:** `harvestRate` 21 → 18, `scrapPerTile` 1500 → 1250,
  `crystalPerTile` 1200 → 1000.
- **Maps:** two outlying patches per side on riverlands, dune-sea, frostbite,
  ashlands, compass-rose (21–33 tiles from the HQ), two small 2×2 ones on
  archipelago. Proving Grounds unchanged (tile-exact for tests, the "one
  contested field" map). Re-exported (`npm run maps`) and **art re-rendered**
  (`art/terrain.py`, run from a venv with numpy/Pillow/scipy: about 6 min for
  the six in parallel; chunk sizes within ±5% of before; rock textures came
  out identical).
- Marshal's expansion reach (`MAX_FIELD`, `expansionFields`) 30 → 36 tiles.
- Tests updated: archipelago scarcity bound (≤20 tiles a side), Proving
  Grounds total scrap (38 tiles' worth), the outpost test's coordinates
  (shorter reach), the Archipelago lift tests strip the new patches (`liftOnly`:
  otherwise the Goliath walks to a mainland field instead of being lifted);
  op "sky-pirates" starts with 900 scrap (was 800: its 4:30 star slipped by
  5 s). All 1653 pass.
- **Matrix** (stock plans): rush–greed **8–15**, greed–turtle **18–2**,
  rush–turtle **9–12 (Turtle wins now)**, rush–ironclad 8–14, greed–ironclad
  10–14. Rush variants vs greed: `r5` 7–15, `r1` 3–20; deploy 550: 10–14;
  buildTime 45: 8–13. So: Greed>Turtle and Turtle>Rush hold, **Rush>Greed is
  the open leg** now (expanding dominates a Rush that can't stop it).

**Session 3b: no home-depot rule (asked by the user)**
- Depots are an ordinary sidebar building again (250, as many as you like, in
  the build zone). Past the zone, 4+ Harvesters **deploy** one ("⛏ Deploy
  Depot", V; they unpack their rigs into it, used up, 28 s to go up). The
  deploy now costs the same 250 (`ECONOMY.expansion.cost`): the crew is the
  price. A Depot ghost out of range says "Too far: 4 Harvesters can deploy it".
  `isExpansion` and the "Found more with 4 Harvesters" lock are gone.
- Marshal: builds a Depot from the sidebar when there's a spot in range by an
  unserved field, deploys a crew when there isn't (`depotByCrew`). Fixed in
  `depotSite`: a field counts as served if a drop-off reaches **any** of its
  tiles (`fieldIds`), so it builds one Depot per field, not a ring of 3–4 round
  the home field in the first minute.
- **Fixed a session-2 bug:** the FFA protocol's whitelist (`src/ffa/protocol.ts`)
  didn't accept `found`, so 4-player online games dropped Deploy Depot orders
  (caught by the ffa relay test).
- **Matrix** (stock plans): rush–greed 11–11, greed–turtle(`t4`) 11–9,
  rush–turtle(`t4`) 12–12, rush–ironclad 9–13, greed–ironclad 13–11. Everything
  is ~even: both sides take the home field and the next one from the sidebar
  by 0:25, since the next field is inside the build zone on most maps. Not
  fixed by: deploy at 550 (11–11), depots not extending the zone (10–13),
  Wasteland ring 3 (10–10), build radius 5 (13–11).
- **Two tests fail** with the one-depot-per-field fix (pass without it), both
  knife-edge seeds: goliath-feedback "stays as pleasant" (12 radio lines in the
  busiest minute, budget 10: ordinary Goliath fighting) and ops "sky-pirates"
  (no pilot earns a second star). Left open pending the rules decision.

**Session 3a: Wasteland look, browser check, raids that scout**
- **Wasteland look, done.** The ground shader (`terrain-glsl.ts`, the
  `uWaste` block) draws a baked crust of cracked plates from the noise
  texture's cell channel (B = border distance, A = per-cell tone), warped,
  with fine hairline cracks, slag specks and a charred rim at its frayed
  edge. Per-biome colour and crack glow: `BiomeLook.waste` (`terrain.ts`):
  dusty brown, red-brown on sand, grey slush on snow, and on volcanic black
  crust with **glowing cracks**. Checked by eye on all 7 built-in maps and
  generated desert/volcanic maps, close and zoomed out.
- **Minimap and map preview show it.** Generated maps: `paintMapPixels` now
  paints the grid through `withWasteland` (new pure function in `maps.ts`;
  `paintWasteland` uses it), and the 2D painter has a real `WASTELAND` case
  (`Palette.waste`), so the menu preview and their thumbs have it. Built-in
  maps' thumbs are pre-rendered, so the in-game minimap lays
  `wastelandOverlay` (`terrain-paint.ts`) over them (`hud.ts`). The 3D chunks
  of generated maps still paint plain ground under the shader (their grid
  has no Wasteland), as before. `art/terrain.py` is unchanged (no re-render
  of the built-in art needed).
- **Found Depot, driven in the browser** (`tools/rps/play-found.mjs <out> [w h map]`):
  chip and V, the ghost refused on wasteland ("Can't build on wasteland")
  and legal off it, crew walks, 550 charged, 4 used up, the site rises from
  25% to full. Phone width (390): the chip row fits ("⛏ Depot 550", Stop,
  Move, ✕); "✓ Found Depot here" on the ghost. **Fixed:** selecting more
  than 4 left the rest of the crew idle by the site: now they go back to
  mining the nearest field (`tickFoundCrews`; test "sends the crew it
  didn't need back to work"). Noted, not changed: the ghost can sit in
  unexplored fog (no build range), so you can't see the wasteland under
  it; and founding before any home depot locks the cheap sidebar Depot
  afterwards (the "first depot is home" rule).
- **Marshal raids now punish expansions** (`commander.ts`): every other
  harass raid looks in on where the foe would expand (`expansionFields`: our
  fields past the home field, mirrored; `AiState.raids` counts raids), and
  raids and waves go first for a known enemy Depot still going up
  (`enemyExpansions`), raids next for a known outlying one. Before this,
  Rush never once saw Greed's expansions. Test: "Marshal's raids go for an
  expansion they've seen going up".
- **Rush beats Greed now: 14–8–2 (`r5`), 15–9 (stock Rush).** Killing the
  first expansion is what decides it: when Rush killed it, Rush won 6 of 8.
- **Turtle vs Rush is still not solved** (see below). Plans unchanged.

**Matrix, session 3** (Hard, 24 games; "scout" = the raid change above):

| Matchup | Result | Note |
|---|---|---|
| `rush+r1`–greed, before the raid change | 11–13 | no change from `g1`/`g2`/`g3` greed variants, cost 900, buildTime 45, harvestRate 17 (5–17) |
| `rush+r5`–greed (scout) | **14–8–2** | `r5` = `r1` + an expansion after its order |
| stock rush–greed (scout) | **15–9** | |
| greed–`turtle+t4` | **16–6–2** | the leg that works |
| `rush+r5`–`turtle+t4` | 12–9–3 | Turtle should win this |
| `rush+r5`–ironclad / greed–ironclad | 16–6–2 / 10–13–1 | |
| `rush+r5`–balanced / airswarm / juggernaut / strike | 14–5 / 10–13 / 13–8 / 17–7 | stock rush: 13–9 / 11–12 / 5–16 / 18–6 |
| released crew (`consume: false`): `r5`–greed, greed–`t4` | 15–8, 14–9 | no real difference: keep consumed |
| expansion buildTime 40, cost 700 (`r5`–greed) | 11–12, 13–10 | no better: keep 550 / 28 |

**Turtle against Rush, what was tried** (all vs `rush+r5`):
- Leaner orders: `t8` (no extra factories, no expansion) 14–7, `t10` (stock,
  no expansion) 19–5.
- Fighting only under its guns, with harvesters running to the guns from
  raiders (a `holdCover` strategy flag, **since removed**): 17–4 to 20–2.
  The army stops trading and the harvesters stop mining.
- Turret buffs: dps 40 (and range 5.5) 17–7 / 13–7 with `t8`; HP 900 or dps 34
  with `t14` 10–11 / 12–11. Turrets don't decide it: the fights happen away
  from them.
- **What moved it:** expand once it's safe and strike late. `t12` (harvesters
  6, a second depot late in the order, `maxDepots: 2`) 13–8; `t14` (and
  `assaultValue: 6000`) 11–12, `t15` (9000) 10–11. But `t14` is just
  stronger, not a counter: Rush beat it 16–7 on seeds 3–4 (27–18 over 48), and
  it beats Greed 14–8 (the wrong way round).
- Diagnosis: stock-ish Turtle (`t4`) dies by over-building (4 Fab Plants, 4
  turrets, 2 SAMs, radar, Airpad, Bay, Gantry by 4:30, army 2,390 against
  7,050 at 3:00) and by founding an expansion under pressure; a Turtle that
  holds (`t9`) wins the early trades (13 lost to 32 at 3:00) but sits on 7
  harvesters and one field and is out-mined.

**Decided by the user (session 2; superseded by "Start here")**
- An expansion's crew is **used up** (they become the depot). Founding is a
  harvester command (chip and V), never a sidebar build. (Session 2 also had
  a "home depot" rule; the user dropped it in session 3b.)

**Built (session 2)**
- Wasteland (`Terrain.Wasteland = 11`, "b" in `art/maps/*.json`, "-" in the
  arena's ASCII maps): a 2-tile ring (`ECONOMY.wastelandRing`) round every
  field, painted by `paintWasteland` (`src/sim/maps.ts`) after every map's
  painter, so it's symmetric by construction. `placementBlocker` says
  "Can't build on wasteland". **Goliaths may dig in on it**
  (`anchorGround`, `src/sim/goliath.ts`), so they still walk up to a field.
  Ops clear it under their pre-placed bases (`src/sim/ops.ts`).
- Wasteland's look: a per-tile mask texture (`uWaste`, `Terrain3D.wasteTexture`)
  under which the ground shader draws the crust (session 3, above), plus
  extra loose boulders. It works on painted (built-in) and generated maps
  alike; `art/terrain.py` and the 3D chunks paint plain Ground under it.
- Expansion depots (`ECONOMY.expansion`: cost 550, buildTime 28, crew 4,
  crewRadius 3.5, siteHp 0.25, consume true), `src/sim/economy.ts`:
  - `found` command (`orderFound`): 4+ harvesters get order
    `{ type: "found", tx, ty }`. `tickFoundCrews` walks them to the site.
    Once 4 are within crewRadius and the scrap is there, it charges the cost,
    deletes the 4 (fx `founded`) and spawns the depot with `founding` ticks.
    A crew below 4, or a lost site, calls it off and nothing is spent.
  - `foundBlocker`: the ground rules (on your land, buildable, not Wasteland,
    no building, Goliath or Uplink). No build range needed.
  - `tickFounding`: HP climbs from 25%; no drop-off (`world.ts`
    drop-off finders skip it) and no build range (`inBaseRange`) until done;
    "built" fires when it's up.
  - `isExpansion`: the side has a depot (or one in its sidebar).
- HUD: chip and key V (`src/ui/hud.ts`, `GameScene.ts`), `Controller.foundCrew`,
  `startFound`, `crewSelected`; placement ghost starts among the crew, with no
  build-zone overlay (`placement-view.ts`); help text and the Shift+? list.
  **Not yet checked by eye** in the browser.
- Online: `found` is in the versus codec; `CODEC_VERSION` is now 2 (old
  clients won't match: redeploy the site and relay together).
- Arena (LLM agents): `{"found": [ids], "at": [x, y]}` order and rules text.
- Marshal (`src/sim/ai/expansion.ts`, hooked in `commander.ts`): when its
  build order's next depot is an expansion (`expands`), it skips past it so
  the order keeps going, trains the crew **on top of** its normal miners,
  holds 550 back once the crew is ready, never starts one under attack, and
  sends the 4 nearest harvesters with `found` to the open spot by the
  nearest field no drop-off serves within 10 tiles (`expansionSite`).
- Tests: `tests/expansion.test.ts` (ring, refusal, home vs expansion,
  founding, called off, Marshal founds one); `tests/ai.test.ts`,
  `arena.test.ts` and `versus-codec.test.ts` updated.

**Measured (session 2)**
- Per-harvester income with Wasteland, depot by the home field
  (`tools/rps/econ.ts`): 765–940 a minute at 4 harvesters, 575–870 at 8
  (was about 1,000 and 825). Without a depot it's unchanged (400–550).
  So the home depot's bonus at 8 harvesters went from +80% to +45%.
  `harvestRate` is still 21.
- Matrix, Hard, 24 games each (noise is about ±5 games):

| Stage | Rush–Greed | Rush–Turtle | Greed–Turtle | Rush–Ironclad | Greed–Ironclad |
|---|---|---|---|---|---|
| Before (session 1) | 9–13 | 20–4 | 13–7 | 13–9 | 9–14 |
| Wasteland only | 8–15 | 16–6 | 12–10 | 8–16 | 8–14 |
| + expansions (Marshal stalled its order on them) | 22–2 | 22–2 | 17–4 | 24–0 | 7–17 |
| + expansions alongside the order, crew on top | 10–14 | 20–4 | 17–4 | 13–11 | 11–8 |
| + crew command (current), Turtle = `t4` | 11–13 | 15–6 | 14–7 | 14–10 | 9–14 |

  Rush is `rush+r1` throughout. Greed beats Turtle as it should. Rush
  doesn't beat Greed yet, and Turtle still loses to Rush.
- Turtle variants against `rush+r1` (`tools/rps/variants.ts`, all with
  `expandEarly: true`): t1 (only that) 18–6; t2 (three turrets in the order)
  14–5; t3 (t2, 6 harvesters) 20–4; **t4 (fab, turret, depot, fab, turret,
  tech, turret, sam, radar) 11–9**; t5 13–9; t6 (t4 attacking at 2200)
  21–3. A 175-scrap turret with t4: 12–9, no change. Stock Turtle floated
  scrap because extra factories only come once its long order is done
  (`expandEarly` fixes that). Now it spends, but its army dies fighting
  outside turret cover against the rush's mix (Stingers, squads, Menders,
  Wasps); see the dune-sea 1 trace with `COMP=1`.

## Why depots win today (measured)

All numbers are Hard Marshal against Hard Marshal: 6 maps × 2 seeds × both sides, 24 games per matchup.

- **A harvester pays for itself in 13–23 s.** It mines about 500 scrap a
  minute from the home field (fields 6–8 tiles from the HQ). The number falls
  with crowding: 600 for one harvester, 525 each for 4, 450 for 8, 400 for 12.
- **A depot next to the home field doubles that.** Each harvester mines about
  1,000 a minute (825 each for 8). For 250 scrap, with 8 harvesters, that is
  about +3,000 a minute, paid back in about 5 s.
- **Harvester count is capped by the HQ, not by scrap.** The HQ builds one
  every 10 s, so Rush and Greed both have 9 harvesters at 3:00. The depot is
  the whole economic gap: with no depot, a rush mined 8k by 3:00 against
  Greed's 14.5k.
- **Both sides spend everything** (they bank 100–300 scrap). A rush's army
  lead is only what the greedy side put into economy. A 250-scrap depot is
  about 5% of a minute's income at 1:00, so skipping it buys almost nothing.

| Rush build vs Greed | W–L |
|---|---|
| Stock Rush (Marshal adds 2 depots on its own via `depotReach`) | 14–9 |
| Stock Rush, no depots (`spend.maxDepots: 0`) | 5–19 |
| Stock Rush, 1 depot | 6–16 |
| 2 Fab Plants, 3 harvesters, attack at 700, no depot | 1–23 |
| 2 Fab Plants, 8 harvesters, no depot | 5–18 |
| **`r1`: Fab, home depot, Bay, Fab, … (1 depot, 6 harvesters)** | **9–13** |

With the home depot taken, a rush is close to viable (`r1` also beat
Turtle 20–4). Experiments on top of that, with `r1` as the rusher:

| Change | Rush–Greed | Rush–Turtle | Rush–Ironclad | Greed–Turtle | Greed–Ironclad |
|---|---|---|---|---|---|
| None | 9–13 | 20–4 | 13–9 | 13–7 | 9–14 |
| Each extra depot +400 | 15–9 | 23–1 | 18–4 | 8–14 | 7–16 |
| `harvestRate` 21→14 | 12–11 | 14–9 | 11–12 | 18–5 | 9–14 |
| Rate 14, +250 per depot, depot `buildTime` 20 | 17–6 | 19–4 | 12–12 | 14–8 | 6–17 |
| …and turret HP 950 | (no change: Turtle still loses 19–4) | | | | |

What these show:

- **A slow-building expansion is what lets Rush punish Greed.** The window
  while it goes up is the opening the rusher needs.
- **A lower harvest rate pulls every matchup toward even.** It's a good
  base, but it doesn't make a triangle by itself.
- **Turtle losing to Rush is an AI problem, not balance.** Marshal's Turtle
  sits on 1,850–2,340 unspent scrap at 1:30–2:00 with one Fab Plant, and its
  harvesters die while it waits. Turret buffs changed nothing.

A dead end: forbidding depots within 12 tiles of the HQ (no home depot for
anyone) made Greed stronger. It just built its depots further out, and Rush
still lost 4–20.

## The plan

### 1. Wasteland around every field (built, art done: see Status)

A new terrain, **Wasteland**: you can drive and fight on it, but you
can't build on it. It rings every Scrap field and every Crystal field. A depot
then stands a few tiles off the field, so harvesters drive a short haul
instead of clumping round a depot touching the field. That looks better, and it
trims harvest income on its own.

- `src/sim/types.ts` `Terrain`: add `Wasteland = 11` (maps export as base-36
  chars, so it becomes `b`; add it to the `CH` legend in `tools/export-maps.ts`).
- `src/sim/balance.ts` `TERRAIN`: `{ name: "Wasteland", ground: true, hover: true, speed: 1, hoverSpeed: 1, footSpeed: 1, buildable: false, cover: 1 }`.
  Full speed, so it only blocks building.
- **Paint it in one post-pass, not by hand in each map.** After a map's
  painter runs (`createMapWorld` in `src/sim/maps.ts`, and the random maps in
  `src/sim/mapgen.ts`), turn every Ground tile within `ECONOMY.wastelandRing`
  tiles of a Scrap or Crystal tile into Wasteland.
  - Only overwrite Ground. Leave roads, woods and other terrain alone.
  - Keep the pass mirror-exact: the painter mirrors, but a post-pass over the
    whole grid is symmetric only if it runs on the mirrored result. Check it
    with the map symmetry tests.
  - Start the ring at 2 tiles. Try 2–3: wide enough to move the depot off the
    field, narrow enough that the home field still sits in build radius.
  - The tile stays Wasteland after the field is mined out (it's the ground,
    not the scrap).
- **The refusal message:** "Can't build on wasteland". The HUD's refused
  placement is a bare `cant-build` cue ("Cannot build there",
  `src/game/callouts.ts:279`). Give it a reason: placement can say which
  rule refused it, and Wasteland gets its own line, as the request was.
  Find where the build ghost decides red/green (`canPlaceBuilding`,
  `src/sim/economy.ts:99`) and return a reason from a sibling function rather
  than changing the boolean's callers.
- **Rendering:** the three.js terrain (`src/game/three/terrain.ts`,
  `src/game/terrain-paint.ts`), the minimap and map preview
  (`src/ui/map-preview.ts`), and the art pipeline (`art/`: textures are per
  biome, `tex-<biome>-*.webp`) all switch on terrain. Wasteland needs a
  look in each biome: scorched, cracked, slag-strewn ground. To start with,
  draw it as a darker or desaturated tint of the biome's Ground, and add real
  textures later.
- **AI:** `depotSite` (`src/sim/ai/commander.ts`) requires a placement spot
  within 5 tiles of the field. Check that it still finds one past the ring.
  Raise that 5 by the ring width if it doesn't.
- **Every check that looks for buildable ground has to agree:**
  `findPlacementSpot`, Goliath anchoring (needs buildable ground), Uplink
  and crate sites, and `src/sim/placement.ts`. Run the full test suite: map
  tests pin terrain counts and placements.
- Re-export `art/maps/*.json` with `tools/export-maps.ts`.

### 2. Retune the harvest rate around Wasteland

Wasteland lowers income by itself, because hauls get longer. Measure
before changing `ECONOMY.harvestRate` (21 now).
`harvestRate: 14` was too blunt on its own. Expect to land somewhere around
17–21, maybe unchanged. Measure per-harvester income with the scratch
`econ.ts` method below (no depot, depot at the nearest legal spot; 4 / 8 / 12
harvesters) on each map, then run the matrix. Crystal (`crystalValue` 1.6)
gets the same ring, so check its premium still makes taking it worth it.

### 3. Second depot: expensive and slow, built by four harvesters (built, then reworked: see "Start here")

No escalating price. The home depot stays as it is (cheap and quick: both
Rush and Greed take it). Every **expansion** depot, at a field not served by
the home depot, is a real commitment:

- **It takes four harvesters to build.** They have to be at the site, and
  are tied up while it goes up: not mining, and exposed to whatever rushes
  in. That is the "grab four harvesters quick to super-charge my eco"
  moment the rusher punishes.
- **It is slow:** start at 25–30 s to build.
- **It costs more:** start at 500–600 scrap, and tune it.
- **Decided: consumed.** The four harvesters turn into the depot (600 scrap
  of harvesters plus about 30 s of HQ production to replace them).
  `ECONOMY.expansion.consume: false` keeps the released version for a
  comparison run.
- **How a home depot is told apart from an expansion:** the first depot, or any
  depot whose nearest field is the one nearest the HQ, is a home depot.
  Alternatively, all depots after the first are expansions. That is simpler,
  and there's only one home field.
- This replaces chaining buildings out to the next field as the quick
  expand. An expansion depot doesn't need build radius: four harvesters at
  a field are enough to found it. Keep it off Wasteland, and keep the
  existing `onHomeLand` rule. Building out the base still works, and still
  needs no harvesters.
- **UI:** the build bar's Depot button needs to show the harvester
  requirement, and the ghost needs to say why it's refused ("Needs 4
  Harvesters here").
- **AI:** Marshal's depot logic (`depotReach`, `SPEND.maxDepots`,
  `depotSite`) has to gather four harvesters at the site before ordering the
  build, and must not count them as income meanwhile. That is the bulk of the AI work.

### 4. Fix Marshal's Turtle (Turtle now beats Rush: see "Start here")

It banks about 2,000 scrap at 1:30–2:00 with one Fab Plant (trace:
`riverlands 1`, Turtle as red against `r1`). Find out why it doesn't spend.
Likely causes: the build order stalls on a building it can't place, or
`spendDown` doesn't add factories before the order is through
(`expandEarly` is off). Turtle should
spend the bank on turrets, a second factory and tech, then hit back once
the rush breaks. Check it against `r1` before and after.

### 5. Retune the plans and run the matrix

The three archetypes are Marshal plans (`MARSHAL_PLANS`, `src/sim/ai/marshal.ts`):

- **Rush:** like `r1`: Fab Plant, home depot, Assembly Bay, second Fab
  Plant, turret, Airpad, Tech Lab; 6 harvesters; no expansion before it
  attacks (`spend.maxDepots: 1`). Make it the new `rush` plan.
- **Greed:** home depot, then the four-harvester expansion as early as it
  can, a fifth and sixth harvester, little army until it pays back, then a
  big push.
- **Turtle:** turrets and a SAM round home, Tech Lab, and the Gantry fast
  (like Juggernaut's early Gantry, but sitting behind towers).

Run each pair (and Ironclad, Balanced and Air Swarm against each, so the
rest of the pool stays sane) at Hard and Normal. Target: each leg's winner
takes about 65–75% of its matchup, not 95% (guessing wrong should hurt, not end
the game at once). Expect a few rounds of tuning the expansion's cost, build
time and the ring width against each other.

Then update `APM-BOTS.md` with the results, and check every difficulty's
`MARSHAL_POOL` (since 2026-10-29 every level draws every plan, Rush
included: Easy's peace holds its wave till 5:00).

## Later, not in this pass

- **Scouting as its own minigame.** Scouting today means an Airpad (350) and
  a Scout (75), which is expensive early. Maybe a cheaper first look, like an
  HQ-built scout or a short radar ping. An expansion under way should be
  visible only to someone who looks: don't make it `alwaysVisible`.
- **A Marshal that scouts and reacts:** today it draws a plan per game and
  sticks to it. Reacting to a scouted expansion or rush would make the
  triangle playable against the AI too.
- **Crystal fields** (the later, richer patches): the same ring for now;
  maybe a wider one, so taking them needs a real outpost.

## Test harness (how the numbers above were made)

It's in `tools/rps/` (untracked: commit it or not, as you like):

- `rush.ts <map> <seed> <diff> <side> <ourPlan> <foePlan> [q]` plays one
  game. A plan is a Marshal plan name, optionally `plan+variant`, with a
  variant from `variants.ts` (a `Partial<Strategy>`, e.g. `r1`, `t4`). It
  prints the build timings, and harvesters, depots, mined scrap and army
  value at 3/4/5/6/8 min. `COMP=1` dumps every side's buildings, units and
  losses every 30 s (consumed crews show up as lost harvesters).
  `BAL='{"ECONOMY.expansion.cost":450,"BUILDINGS.turret.cost":175}'`
  patches any balance constant for that run.
- `xbatch.sh <diff> <ours> <theirs>` runs 24 games (6 maps × `SEEDS` × both
  sides), one process each, 24 in parallel, `timeout 180` each.
- `matrix.sh <tag>` runs each `PAIRS` matchup (`"a:b c:d"`; the default is
  the five above) and prints W–L–D; results go to `$OUT` (default
  `/tmp/rps`). One game takes about 5–8 s, a matchup about 30 s, the
  five-pair matrix about 2.5 min.
- `rush.ts`'s END line also lists each side's depot times and, for the
  foe's expansions, `k` (we saw it going up), `h` (hit), `x` (killed).
- `chain.ts [maps]` (`EXTEND=3`): turrets needed to chain the build zone to
  each of blue's fields. `ascii.ts <map>`: the map as text, with coordinates.
- `play-found.mjs <out> [w h map]` (needs `npx vite --port 5173`): drives
  the Found Depot flow in headless Chrome and saves screenshots.
  `shots.mjs <out> [maps]` (`ZOOM=60`): each map's home field and middle
  field, fog off.
- `econ.ts <map> <n> [d]`: per-harvester income, `n` harvesters on the field
  nearest the HQ, optionally a depot beside it (30 s warm-up, 60 s measured).
- **Don't edit `src` while a batch runs**: each game loads `src` as it
  starts. To keep editing during a run, make a worktree
  (`git worktree add --detach /tmp/rps-tree HEAD`, symlink `node_modules`,
  rsync `src/` and `tools/rps/` into it) and run with `RPS_TREE=/tmp/rps-tree`.
- zsh: `${=var}` to word-split.
