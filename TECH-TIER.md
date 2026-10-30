# Faster balance runs, then a real tech tier

Handoff plan (2026-10-29). Two parts, **in this order**:

1. **Make the matrix runs fast** (rps harness, `tools/rps/`). Right now a
   24-game matchup takes about 40 s and a five-pair matrix about 3 min,
   and much of that is waste. The user's time is the cost: speed this up first.
2. **Make tier 2 a real step**: a dearer, slower Tech Lab; a longer-range
   Lancer; a slower, tougher Mastodon; a stronger Hornet (the airship, "the
   zeppelin"); tier-2 units a little dearer across the board. Test them with
   the faster harness.

Background: RUSH-RPS.md ("Start here") has the rush/greed/turtle triangle
these changes have to keep working, and how the harness works.

## Start here

**Status (session 3, 2026-10-30, committed):** the Tech Lab needs all three
factories and Turtle times a tier-2 push (below, "Applied in session 3").
All tests pass. Earlier: session 2 (committed 8702c16).

*Part 1, built:* `tools/rps/sweep.mjs` (bundle once, one queue, `P=12`,
result cache, longest games first, W–L–D + 95% table, tier-2 table);
`xbatch.sh`/`matrix.sh` now bundle and default to the stock triangle;
`perTick` memo for `depotSite`/`expansionSite` (`ai/expansion.ts`). A game
went 6.6 s → 2.9 s. The fixed 24-game set gave identical `END` lines after
each step. The full triangle (72 games) went from about 2 min to **44 s**; a
4-config × 48-game confirm run took 6.5 min. `rush.ts`'s END line now ends
with `t2 lab… first… share3m/5m | …` (ours | theirs).

*Part 2, what was measured (Hard, stock triangle):*
- The planned Tech Lab (560, 25 s) delayed tier 2 by only **5 s** (Greed's
  first tier-2 unit 1:25 → 1:30). The 1:45–2:30 goal needed about 700–900
  scrap and 30–40 s (12-game timing screen: 700/30 → 1:45, 650/40 → 1:55,
  900/35 → 2:00). Chosen: **750 / 35 s**.
- Lancer range 5.5 hardly moves duels (Marshal doesn't kite): vs Stinger
  −0.41 → −0.37. Added hp 405 → 450 and dps 28 → 31. Duels can't judge cost
  changes: 1800 / cost is rounded to whole units (525 → 3 Mastodons, 475 → 4).
- **Hornet as a glass cannon** (the user's idea, 2026-10-29: "weak, light
  armour, but even stronger"): armour heavy → light, hp 505 → 280, dps
  36 → 72, splash 1.1 → 1.5, speed 2.1 → 2.4, cost 400. Duels: beats every
  ground unit (Stinger +0.89, Mastodon +0.56, Lancer +0.68, Rocket Squad
  +0.52), loses to Raptors (−0.93) and Flak (−0.31).

| 48 games/matchup (score = left plan) | R–G | R–T | G–T | Greed / Turtle / Rush first tier-2 unit |
|---|---|---|---|---|
| base | 44% | 70% | 61% | 1:25 / 1:40 / 2:25 |
| Lab 750/35 only | 63% | 55% | 65% | 1:45 / 2:25 / 2:40 |
| Lab + Lancer 5.5, Mastodon, Hornet hp 600 + costs | 72%* | 59% | 71% | same |
| Lab + glass Hornet + costs | 60% | 65% | 76% | same |
| Lab + glass Hornet, no costs | 55% | 58% | 78% | same |
| Lab 650/30 + glass + Lancer+ + costs | 53% | 63% | 67% | 1:40 / 2:20 / 2:30 |
| **Lab 750/35 + glass + Lancer+ + costs (applied)** | **56%** | **57%** | **66%** | **1:45 / 2:25 / 2:40** |

(±19 at 48 games; * = outside it.) The applied set pulls Turtle–Rush toward
even, keeps Greed > Turtle, and Rush–Greed stays near level.

*Applied in `balance.ts`:* Tech Lab 750 / 35 s; Mortar 300; Mastodon 525,
hp 1250, speed 1.0; Lancer 300, hp 450, dps 31, range 5.5; Hornet as above;
Sniper 220. Role text: Mastodon "Slow…", Hornet glass cannon, Rocket Squad
no longer "kills Hornets". Op Sky Pirates scrap 900 → 1500 (no pilot won
it at 900 or 1400: red's Lancers now shred the raid; at 1500 the raider wins
at 3:42 with 5 stars, a knife edge: **hand-play it**).

*Tests fixed for the new numbers:* aaWeight(Lancer) 0.7; Tech Lab refusal
"need 750"; retaliation test's Mortar moved to 7.9 tiles (Lancer acquire is
now 7); the depot test starts with a Tech Lab; the 5-minute session test
plays Balanced vs Boom (Rush now wins by 3:43).

**Lockstep test, fixed by a seed:** `versus-lockstep` "re-order a 30-unit army
every 1 s" on seed 8 had one order land in 64 ticks (bound 60), at tick 750 in
the mid-game fight; blue's Stingers now win at 1275. The old balance peaked
at 54 there. Seeds 1–9 under the new balance: 33–53, seed 8 the outlier. Now
seed 7, which (like seed 8 used to) runs the full 1500 ticks; bounds unchanged.

**Next tuning goal (the user, 2026-10-30): the defence that barely holds.**
Rush losing to a player who speeds to tech *without* static defence is fine.
The suspense we want: Rush hits with ~15 Stingers; the defender has 4 Turrets,
5 Stingers and a Tech Lab 25% built, sees it coming, adds a Turret and more
Stingers, *just* holds, and comes out of it closer to tier 2 and set up to
win. Plan: a scripted scenario (like `tools/balance.ts duels`, but a base
defence: placed Turrets, a Lab under construction, a Stinger wave on a
timer, a defender that reacts) swept over Turret stats and Lab cost/time,
reading hold rate, the margin it holds by, and the Lab's progress afterwards;
then confirm on the triangle with `sweep.mjs`. Deferred until then: a
Hornet dps 54–60 / splash 1.3 sweep, a later Lab (~1000 / 45 s), kiting.

*Session 3 (2026-10-30), first measurements* (nothing in `src/` changed):
- `HIT=1` on `rush.ts` prints, the first time 6+ of our combat units are within
  12 tiles of the foe's HQ, what both sides have (Turrets, Lab, the building
  going up and how far, scrap, income/s), plus the foe's base at 2:00.
- **Real Rush waves** (Hard, 5 maps × 2 seeds): 12–18 Stingers at 1:35–2:10.
  **Greed** has 1 Turret, ~5 Stingers, and its **Lab already standing**
  (1:15–1:30). **Turtle** has 3–5 Turrets at 2:00, and Rush mostly **never
  commits** (no hit in 7 of 12). Income at the hit: 70–95 scrap/s, so the
  Lab's price is ~9 s of mining; it gates little.
- **`tools/rps/hold.ts`**: the scripted defence (each map's real blue base,
  Turrets in an arc at the entrance, Lab part-built, red Stingers attack-moving
  in, blue reinforcing from its Fab Plants on steady income). 15 runs a policy
  in ~3 s. With stock Turrets:

  | red Stingers | 4T + 5S, Lab kept | 4T + 5S, Lab cancelled for a 5th Turret | 0T + 11S (same scrap) |
  |---|---|---|---|
  | 15 | 15/15 held | 15/15 | 11/15 |
  | **18** | **11/15** | **13/15** | **1/15** |
  | 21 | 1/15 | 7/15 | 0/15 |

  At 18 the Turret defence just holds and the same scrap in Stingers breaks:
  the wanted property, inside the real wave range, with no Turret change.
  Turret **HP** matters far more than its dps (dps 26 → 16 barely moves it;
  Turrets that can't shoot still hold 5/15 by soaking fire: kinetic does 0.65×
  to structures). Weaker Turrets flip the result rather than thin the margin.
- **The one-build-slot rule** means a defender can't add a Turret while the
  Lab goes up without cancelling it (refunded, progress lost), and Marshal
  never cancels. Cancelling holds better (13 vs 11 of 15) but the Lab stands
  17 s later: a real choice, worth keeping.
- **Lab timing in real games barely moves:** Greed starts its Lab ~0:40–1:00
  whatever it costs. Lab standing (Greed): 750/35 → 1:15–1:30; 1200/35 →
  1:25–1:45; 750/60 → 1:40–1:55; 1100/50 → 1:40–1:55. Only on the fastest
  hits (1:35, dune-sea, proving-grounds) is the Lab still going up (70–96%).
  For ~25% at a ~1:50 hit the Lab would have to stand ~2:20–2:45.
- **Open for the user:** (1) no Marshal plan plays the "4 Turrets + Lab" hybrid
  (Greed: tech, no static D; Turtle: Turrets, and Rush declines to attack it),
  so the moment needs a plan or tweak that does, and Rush willing to hit it;
  (2) how to push the Lab start later: price barely works, so the levers
  are prerequisites (e.g. a Depot or a second Fab Plant) or build time ~60 s+.
  Driver for the real-game screen: `HIT=1 BAL=… rush.ts <map> <seed> hard blue rush greed q`.
- **Lab needs all three factories** (it needed any one: `requires` is an
  any-of list; `requiresAll` is all-of, as the Gantry's). Uncommitted code,
  no-ops under today's data: a banned prerequisite doesn't count (Air War,
  Infantry War keep tier 2); `nextBuilding` moves a missing prerequisite up
  ahead of what needs it (the Gantry's old special case, generalised);
  `player.ts` pilots check `requiresAll`. Also a **Turtle fix** that is not a
  no-op: `expandEarly` factories no longer go in ahead of a Lab still to come
  (without it, banked scrap during the prerequisites bought Fab Plant after
  Fab Plant ahead of the Lab: Turtle's Lab at 3:35–5:45). 48 games/matchup:

  | | R–G | R–T | G–T | Lab Greed / Turtle |
  |---|---|---|---|---|
  | today (committed) | 56% | 57% | 66% | 1:30 / 1:55 |
  | today + Turtle fix | 56% | 70% | 59% | 1:30 / 1:40 |
  | all-three, no fix | 44% | 65% | 58% | 1:55 / 4:15 |
  | all-three + fix | 44% | 69% | 64% | 1:55 / 2:40 |
  | all-three + fix + Lab 45 s | 43% | 75% | 46% | 2:05 / 2:50 |

  Turtle's early extra factories are part of its strength (the fix alone
  costs it ~13 points vs Rush). Rush beats Turtle *without* hitting it early
  (no hit in most games): it out-builds it later.

*Applied in session 3:* Tech Lab `requiresAll` (all three) with the Turtle
fix. Turtle (marshal.ts) times a **mid-game tier-2 push**: new
`Strategy.techAssault` (the all-in also goes once that much of the army's
value is tier 2), Turtle 1800, its `assaultValue` 3000 → 6000 so the Stinger
mass no longer sets it off (on Hard 3000 × 0.9 was passed at ~3:00 by
Stingers alone, so a tier-2 bar alone changed nothing). First wave: 1:56–3:36
before, 3:27–3:59 after (one ashlands game still goes on army value at 2:42).
Variants tried (48 games each; `ta*`/`tb*` in `variants.ts`): push at
1200 / 1800 / 2400 → R–T 49 / 52 / 48%, G–T 61 / 60 / 65%; 1800 with
mortarShare 0.15 → R–T 54%, G–T 42% (Turtle over Greed: dropped).
Final triangle (48 games/matchup), vs session 2's committed numbers:

| | R–G | R–T | G–T | Lab Rush / Greed / Turtle |
|---|---|---|---|---|
| session 2 (8702c16) | 56% | 57% | 66% | 2:15 / 1:30 / 1:55 |
| **session 3** | **44%** | **52%** | **60%** | **2:20 / 1:55 / 2:40** |

Also: tests for the new rule (features: the Lab needs all three; arena's
refusal now "Needs Airpad and Assembly Bay"; versus-session's five-minute
match is Balanced vs Ironclad (Balanced vs Boom now ends at 4:47); Nomads ashlands on
seeds 5/6: 1 of 10 seed pairs stalls past 25:00, 3/4 among them, 0 of 10
before); `player.ts` pilots build an Assembly Bay before the Lab;
`arena/observe.ts`'s building table shows all-of prerequisites (it showed
"-" for the Gantry too). DESIGN.md's tech table updated.

*Why Rush now loses to Greed:* not the rule but what it does to Greed's order.
Under the old any-one rule, Greed given the Airpad and Assembly Bay before its
Lab by hand (`greed+gab`) scores exactly the same, 44% (20–26–2). Its
expansions are untouched (2nd depot 1:45 → 1:50, 3rd 2:50 → 2:40, 3.4 → 3.6
by 5:00). A greedier Greed doesn't help Rush: `g1` (three depots first) plays
the same games as stock (the depot count comes from its mining, not the
order); `g1n` (no early Turret) R–G 43%, G–T 44%.
Rush's all-in earlier, smaller (48 games each; Rush's wave already launches
~1:05 at ~1450 and doesn't break off; `HIT=1` misses waves that fight at the
expansions, 12+ tiles from the HQ):

| Rush assaultValue | R–G | R–T |
|---|---|---|
| 1400 (stock) | 44% | 52% |
| 1000 | 53% | 65% |
| 800 | 55% | 59% |
| 600 | 50% | 53% |

None separates Greed from Turtle: an earlier wave helps Rush against both.

**Next:** Rush now loses to Greed (44%): if Rush should beat Greed, look
there first (Greed gets Airpad + Bay production on the way to its Lab).
Hand-play the Turtle push; check `hold.ts`'s knife edge still reads the
same (it fixes the Lab at 25%, so the rule change doesn't touch it).

**Next:** hand-play (does the glass Hornet feel right, or oppressive? only
Raptors, Flak and SAMs answer it); the Hornet Strike plan still loses a lot
(24 games: vs Greed 4–20, vs Turtle 8–16; old Hornet 3–21, 5–19); confirm the applied set
on 72 games (`SEEDS="1 2 3 4 5 6"`); APM-BOTS.md has no stat tables to
update; then commit. Pushing needs the relay redeployed with the site.

*Original plan (session 1), for reference:*

**Ground rules**
- A speed-up must not change results. Before and after, the same games must
  print identical `END` lines (winner, map, seed, side, game clock, depot
  times). Check this on a fixed 24-game set (below).
- Sim code is lockstep online code. A cache in `src/sim` must give the same
  answer as no cache, on every client, every tick.
- Keep head-to-heads short (memory: fast experiments). Time a game before
  estimating a run.

## Part 1: faster matrix runs

### Where the time goes (measured)

Machine: Ryzen 9 3900X, 12 cores / 24 threads, 30 GB.

| What | Time |
|---|---|
| One game (rush–greed, Riverlands 1, 8:41 game clock) under `npx vite-node` | 6.6 s |
| …of which vite-node starting up and compiling TypeScript | 1.65 s (imports alone 0.4 s) |
| The same game as one esbuild bundle under plain `node` | **3.5 s** (bundle loads in 0.04 s) |
| A 24-game matchup, vite-node, 24 in parallel (today's `xbatch.sh`) | 39.6 s |
| The same, bundled, 24 in parallel | 25.3 s |
| The same, bundled, **12** in parallel | **21.3 s** (16: 23.5 s) |

The bundled runs gave the same 24 results as vite-node.

Under 24-way load one game takes 7–25 s (3.5 s alone): the hyperthreads
don't help, and the batch waits for its slowest game. The slow ones are long
games: 15–20 min game clock (20:00 is the draw cap, `maxTicks`).

CPU profile of one bundled game (`node --cpu-prof`), inclusive time:

| Code | Share | Notes |
|---|---|---|
| `tickAi` (Marshal, both sides) | 30% | |
| ↳ `depotByCrew` (`ai/commander.ts:1313`) | **23%** | `depotSite` plus `expansionSite` |
| ↳↳ `expansionSite` (`ai/expansion.ts:54`) | 14% | a `findPath` from the HQ every call: 10% |
| ↳↳ `depotSite` (`ai/commander.ts:1354`) | 9% | `fieldIds` floods the whole map; `nearestDropOff` for every resource tile |
| `tickMovement` | 29% | `findPath` for units 10%, `separate` 8% |
| `tickCombat` | 14% | `findTarget` 5% |
| `tickFog`, `tickHarvest` | 4% each | |

`depotByCrew` runs once per depot in the build order inside `nextBuilding`
(up to 3), and again at `commander.ts:544`, on every think, for both sides.
None of it changes within a tick. It was added in the last session (Deploy
Depot) and is the biggest single hotspot. It costs the real game on phones
too, not just the harness.

### The changes, most value first

1. **Bundle once per batch** (about 2× per game). In `xbatch.sh`: `npx esbuild
   tools/rps/rush.ts --bundle --platform=node --format=esm
   --outfile=$OUT/rush-<stamp>.mjs`, then run `node <bundle> …` for each game.
   `BAL` patching still works (it mutates nested objects of the balance module).
   Bonus: the bundle is a snapshot, so you can edit `src` while a batch runs.
   That drops the worktree dance in RUSH-RPS.md (`RPS_TREE`). Keep `RPS_TREE`
   working for comparing against a git worktree (the Marshal h2h harness memory).
2. **12 games at a time, not 24** (`-P ${P:-12}`): one per physical core.
   Measured 25.3 s → 21.3 s.
3. **One queue for the whole run.** `matrix.sh` runs each matchup as its own
   batch of 24 and waits for that batch's slowest game before starting the next.
   Feed every game of every matchup (and every config, see 5) into one
   `xargs -P 12`, then tally by matchup afterwards. Expect ~20–30% off a
   multi-matchup run. Start the longest games first if a game's length is
   known from an earlier run.
4. **Cache the AI's depot scan** (about 20% of sim time). Memoise
   `depotSite` and `expansionSite` per `(world, tick, faction, reach)` in a
   `WeakMap<World, …>` that is cleared when the tick changes. That gives the same
   answers (same inputs within a tick), and the `WeakMap` respects
   `fieldIds`' "not memoised" comment: a world rebuilt from a checkpoint gets
   a fresh entry. Optionally also cache `fieldIds` until terrain changes (a
   mined-out tile), but the per-tick memo is the safe first step. Check:
   identical `END` lines on the fixed set, and `npm test`.
5. **A sweep driver, so nobody sits watching.** `tools/rps/sweep.sh` (or
   `.ts`): takes named configs (`base={}`, `tech={"BUILDINGS.tech-lab.cost":560,…}`)
   × matchups, bundles once, runs it all in one queue (3), and writes one result
   line per game to `$OUT/<run>/results.txt`, tagged with the config and git
   hash. It ends with a table: each config × matchup W–L–D, the change
   against `base`, and a 95% interval. Run it in the background; read the table
   when it's done.
6. **Fix stale defaults.** `matrix.sh` still defaults to `rush+r1`, `turtle+t4`
   and Ironclad pairs. The current reference is the stock triangle:
   `rush:greed rush:turtle greed:turtle`.
7. **Stop when the answer is clear.** 24 games carry about ±5 games of noise.
   Screen candidate configs on seed 1 only (12 games: one round on 12
   cores); run 48 (seeds 1–4) only for the configs worth confirming. The
   sweep table's interval says which is which.

Later, only if it's still too slow:
- **Unit movement** (`tickMovement` 29%): a spatial grid for `separate`, and
  fewer `findPath` calls for units. This is engine code with lockstep risk, so
  it needs a broader determinism check (the replay and versus tests).
- **Early adjudication** (call a game decided once one side leads by, say,
  3× in army and economy for 60 s). It changes results: use it only after
  checking it agrees with full games at least 95% of the time. The 20:00 draws
  are the most expensive games.

**Target:** the stock triangle (3 matchups × 24 games) in under 45 s, against
about 2 min today; a 4-config sweep of the triangle (288 games) in about 3 min.

**Fixed check set:** `rush:greed`, 6 maps × seeds 1–2 × both sides (the 24
games above). Save the vite-node `END` lines before changing anything, then
compare after each step: `diff <(cut -d' ' -f1-9 a | sort) <(cut -d' ' -f1-9 b | sort)`.

## Part 2: a real tech tier (after Part 1)

### Why (measured)

- **There's barely a tier-1 phase.** The Tech Lab costs 450, takes 20 s and
  needs any one factory. Marshal has it by about 0:50. In a Greed–Turtle game
  (Riverlands 1) both armies were mostly Lancers, Mortars and Mastodons by 2:00.
- **Factories, not scrap, limit the army** (both sides spend everything). Each
  factory builds one unit at a time; more factories build in parallel. Army
  value per factory-second: Stinger 14, Lancer 25, Mastodon 32. So tech wins
  through throughput even where it loses cost for cost.
- **Cost-equal duels** (`npx vite-node tools/balance.ts duels`, 1800 scrap,
  open ground; + means the row unit wins):

| | vs Stinger | vs Mortar | vs Lancer | vs Mastodon | Row sum (10 matchups) |
|---|---|---|---|---|---|
| Stinger (150) | — | +0.40 | +0.41 | −0.53 | +1.9 |
| Mastodon (475) | +0.53 | +0.61 | −0.30 | — | +1.7 |
| Hornet (375) | +0.42 | +0.86 | +0.10 | +0.20 | **+2.3** |
| Lancer (275) | −0.41 | +0.52 | — | +0.30 | +1.0 |
| Mortar (275) | −0.40 | — | −0.52 | −0.61 | −0.1 |
| Sniper (200) | −0.81 | −0.89 | −0.89 | −0.91 | −3.5 |

- **Why a Lancer loses to Stingers:** per 100 scrap a Stinger brings 170 HP
  and 14.7 DPS, a Lancer 147 HP and 10.2 DPS, and there's no damage-type edge
  (laser 1.0× vs light, kinetic 1.0× vs medium). By the square law (count² ×
  DPS × HP), 12 Stingers ≈ 808k against 7 Lancers ≈ 556k. The Lancer's price buys hitting
  air, hovering, speed and range, and only range counts against Stingers.

### The changes to try (decided by the user; the numbers are starting points)

| Change | Now | First try | Range to explore |
|---|---|---|---|
| **Tech Lab cost** | 450 | **560** (+25%) | 500–650 |
| **Tech Lab buildTime** | 20 s | **25 s** (+25%) | 22–30 s |
| **Lancer range** | 4.5 | **5.5** | 5.0–6.0 (sight is 6: raise it if range passes 6) |
| **Mastodon speed** | 1.2 | **1.0** | 0.9–1.05 |
| **Mastodon toughness** | hp 1050, dps 46 | **hp 1250** | or dps 46 → 54, or a bit of both |
| **Hornet** | cost 375, hp 505, speed 2.1, dps 36, splash 1.1 | **hp 600** | splash 1.1 → 1.4; speed 2.1 → 2.4 |
| **Tier-2 costs** (~+10%) | Mortar 275, Lancer 275, Mastodon 475, Hornet 375, Sniper 200 | 300, 300, 525, 400, 220 | 0 to +15% |

Notes per change:
- **Tech Lab:** each side builds one structure at a time, so its build time
  holds up everything else (Turrets, Depots, factories), not just tech. That's
  a window to scout and punish. Expect **Rush to get stronger** (its Stinger
  wave lands before Lancers and Mortars) and **Turtle weaker** (its Mortars,
  `mortarShare` 0.35, and its Gantry race sit behind the Lab; its Turrets
  share the build slot). Not planned, an alternative if price and time
  aren't enough: require two kinds of factory.
- **Lancer range 5.5 outranges the Turret (4.5)** and comes close to the SAM
  (6.5). Lancers could then shoot down Turtle's towers without being hit. Watch
  rush–turtle and greed–turtle; if the Turtle falls apart, cap the range at
  5.0 or give the Turret +0.5 range. Marshal doesn't kite, so in duels range
  only buys the first shots.
- **Mastodon:** use HP or damage for "tougher", not the `heavy` column of
  `DAMAGE_VS`. That column also covers the Hornet and the Goliath. Slower means
  rushers can outrun it and Rocket Squads get more time on it.
- **Hornet:** the duels already rank it best (row sum +2.3). It loses only
  to Raptors (−0.41), Flak (−0.21) and Rocket Squads (−0.31). So whatever is
  weak about it is in-game: SAM sites, focus fire, or how Marshal flies it
  (`hornetStyle`, the Hornet Strike plan). **Open question for the user:**
  what feels weak about it in play? Before buffing, trace a few games for
  Hornets built, how long they live and scrap killed per Hornet. HP is the
  first try because it fits a big airship.
- **Tier-2 costs:** these partly cancel the unit buffs per scrap. That's
  intended: the buffs give each unit its identity, the costs keep tech a
  commitment.

### How to measure

1. **Duels first** (seconds each): `tools/balance.ts duels --tune '{…}'` for
   each unit change, against the table above. Look for the Lancer going from
   losing to roughly even against Stingers, the Mastodon keeping its edge
   over Stingers and Mortars, and nothing new dominating.
2. **Add a tech-timing readout to `rush.ts`:** each side's Tech Lab time and
   first tier-2 unit time on the `END` line, and the tier-2 share of army
   value at 3 and 5 min. The goal is a visible tier-1 phase: the first tier-2
   unit at about 1:45–2:30 instead of about 1:00.
3. **Sweep** (Part 1's driver), stock triangle, Hard:
   `base`; `tech` (Tech Lab only); `units` (Lancer, Mastodon, Hornet);
   `tech+units`; `tech+units+costs`. Screen on 12 games, confirm on 48.
   Keep the triangle as in RUSH-RPS.md "Start here": Rush–Greed level, Greed
   beats Turtle, Turtle about even with Rush. Retune if a leg flips.
4. Then `npm test`. 13 test files mention the Tech Lab (ops such as Iron
   Tide give one, openers, Marshal timing tests). Expect some timing tests to
   move, as in RUSH-RPS.md session 4.
5. Update the tables in DESIGN.md and APM-BOTS.md, and the Tech Lab and unit
   role text in `balance.ts` if roles change.

**Pushing:** a push to main deploys the site live (memory: push deploys
live). Ask the user before pushing, and check whether balance changes need
the relay redeployed with the site (both sides of an online game must run the
same numbers).

## Also noted this session (not planned)

- **Autobuild keeps one of a type in production across all your factories**
  (`controller.ts:463`, `queueAutoBuild`): with 2 Fab Plants on Stinger
  autobuild, one plant builds and the other idles. The user may remove the
  feature; per-factory autobuild is the alternative. Undecided.
- The Sniper loses to almost everything outside its niche (row sum −3.5). Left alone.
