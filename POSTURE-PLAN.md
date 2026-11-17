# Posture: one army / economy / tech slider for Marshal (plan, 2026-11-17)

Status (2026-11-17): stage 0 and 1.1 shipped (`b6c9010`); idle-producer fix shipped (`c8a7583`); stage 1.2, fix 2,
stage 3's consumers and the Dune Sea SAM move measured and **rejected**. The posture is still traced and read by nothing. See §10–13.

## 1. Why

Replay `replay.json` (Dune Sea, the player against Brutal Air Swarm, `e84b110`, the player won at 4:28):

| At 3:30 | Player | Marshal |
| --- | ---: | ---: |
| Mined | 25.8k | 24.1k |
| Spent | 22.8k | 22.8k |
| Army alive | 14.1k | 8.3k |
| Scrap sitting in paid queues (3:00) | 1.3k | 4.9k |
| Production buildings (2:30) | 6 | 3 |

Marshal mined and spent as much as the player and fielded half the army. Three things did it:

1. **Queue lock.** `spendDown` queues go `1 + min(3, scrap / 400)` deep (`commander.ts:942`), and a
   queued unit is paid for upfront. The scrap was spent, but it sat in queues instead of buying
   factories.
2. **Depots before factories.** Depots 2–4 (0:42, 1:08, 1:20) and a turret went up before the third
   factory (1:38). Depots 3–4 come from the `depotReach` rule "one more while there's a field", which
   chains straight to `SPEND.maxDepots` (4) (`commander.ts:1783`). The home field still had 13k at
   1:30 and 7k at the end.
3. **Nothing listened to scouting.** Around 2:00 the pokes saw the player's army pass Marshal's. No
   building decision changed. Factories 3 and 4 came at 2:28 and 2:40 only because scrap piled up.

The bigger point: **"how much army, how much economy, how much tech" is not decided anywhere.** It
comes out of a dozen independent rules, each with its own trigger, none of them reading the enemy.

## 2. What exists today

The memory and the levers are already there. What's missing is something that connects them.

**What Marshal knows about the enemy** (all within its fog of war, all fair):

| Signal | Where | Used for today |
| --- | --- | --- |
| Remembered enemy army value (`rememberEnemyArmy`, `s.sightings`, 45 s TTL) | commander.ts:1696 | Wave launch (WAVE_EDGE 1.2), Gantry while behind, contested fields, finishing push |
| Enemy composition (`seenAir/Ground/Heavy/AA/Infantry`) | `observeEnemy` | Unit mix, extra SAMs/turrets, no air into flak, doctrine (from 6:00) |
| Known enemy buildings (`knownBuildings`) | fog.ts | Targeting, Feint, mortar count vs defences |
| Threats at home (`findThreats`, `raidValue`) | commander.ts | Defence, expansion delay |

**The levers, and who sets them now:**

| Lever | Set by | Reads enemy? |
| --- | --- | --- |
| Number of factories | build order + `extraProduction` (+1 when scrap > 600 and every queue busy, max 5) | no |
| Queue depth | scrap banked (`spendDown`) | no |
| Number and timing of Depots | build order, `depotReach` chain to `maxDepots`, cap lifted when fields run low | no |
| Harvester count | `strategy.harvesters + extra + depots` | no |
| Tech Lab timing | position in the build order, `factoryBeforeLab` | no |
| Gantry / Goliath | `wantGantry` | yes (not while behind) |
| Army composition | `observeEnemy`, doctrine | yes |
| Attack timing | `assaultValue`, WAVE_EDGE, finish | yes |

Marshal already adapts **what** it builds and **when it attacks** to the enemy. It does not adapt
**how much it invests in each area**. That is the gap this plan fills.

## 3. The model

### 3.1 State

A new `AiState.posture`, in a new file `src/sim/ai/posture.ts`:

```ts
interface Posture {
  /** Shares of investment, summing to 1. */
  army: number; economy: number; tech: number;
  /** The plan's target before scouting nudged it (for traces). */
  base: { army: number; economy: number; tech: number };
  /** The lean it's committed to, and since when: "army" | "economy" | "tech" | null. */
  lean: Lean | null; leanSince: number;
  /** Why it moved last (trace/debug only, never read by decisions). */
  reasons: string[];
}
```

It is updated once per think, is deterministic (no `Math.random`, only `s.rng`), and is plain data in
`AiState`, so replays and the seat-rebuild re-run (`seatMarshal`) work as they do now.

### 3.2 The plan sets a timeline

Each plan gets a few keyframes (seconds → shares), interpolated linearly. These are the plan's
intended emphasis over time. Starting values, to be tuned:

| Plan | 0:00 | 2:00 | 4:00 | 7:00 |
| --- | --- | --- | --- | --- |
| Balanced | A .45 E .45 T .10 | A .50 E .30 T .20 | A .55 E .25 T .20 | A .55 E .20 T .25 |
| Rush | A .75 E .25 T 0 | A .75 E .20 T .05 | A .60 E .25 T .15 | A .55 E .25 T .20 |
| Boom / Greed / Land Grab | A .25 E .70 T .05 | A .35 E .55 T .10 | A .50 E .30 T .20 | A .55 E .20 T .25 |
| Air Swarm / Skyforce | A .45 E .35 T .20 | A .50 E .30 T .20 | A .55 E .20 T .25 | A .55 E .20 T .25 |
| Ironclad / Turtle / Siege | A .35 E .40 T .25 | A .40 E .30 T .30 | A .50 E .20 T .30 | A .50 E .20 T .30 |

Fun plans with their own machinery (Wall, Feint, Hornet Strike, Juggernaut) get a curve that matches
what they do today, so the slider doesn't fight them. Easy and Casual use the curve **without**
scouting nudges (§3.3): predictable, readable opponents.

### 3.3 Scouting moves it

Every think computes **reads** from fair information, then nudges the shares away from the plan's
curve. Each nudge is bounded, and the total pull from the plan is bounded (±0.25 per share), so
every plan keeps its character.

| Read | Measured as | Nudge |
| --- | --- | --- |
| **Outnumbered** | `ourArmy < 0.8 × enemyArmy` remembered, with a minimum read (DOCTRINE.minRead 800) | toward **army**, strongly; tech down first, then economy |
| **Under attack** | `threatened` or a Depot lost in the last 45 s | toward **army**, hard (overrides the rest while it lasts) |
| **Enemy greedy** | known enemy Depots > ours, or no enemy wave or raid seen in 90 s while their army reads small | **depends on our lean, below** |
| **Enemy teching** | tier-2 or tier-3 units seen, Gantry seen | toward **army** if we're ahead (hit before it pays off), toward **tech** if not |
| **Safely ahead** | `ourArmy > 1.5 × enemyArmy` and no threat | toward **economy** or **tech** (bank the lead) |
| **Fields running low** | `fieldsRunningLow` | toward **economy** (that rule already lifts the Depot cap) |

**The greed rule (as specified):** an enemy that's out-expanding us or sitting at home doesn't push
the posture in a fixed direction. It **amplifies the lean we're already committed to, if that lean is
winning**:

- **Leaning economy and ahead on it** → further toward **economy**. Out-greed them.
  "Ahead on economy" = our income over the last 60 s ≥ their estimated income × 1.1. Their income is
  estimated from what we know: known enemy Depots plus the HQ, times the harvesters remembered per
  drop-off (fog-limited; never `w.factions[enemy]`).
- **Leaning army (rushing) and could just win** → further toward **army**, and the wave threshold
  drops to the finishing push's. "Could just win" = `ourArmy ≥ FINISH_EDGE × enemyArmy` (Brutal's
  `fight.finish`, 1.5) and their known defences are few (turrets + SAMs ≤ 2 near their HQ).
- **Neither** (our lean isn't winning, or we have no clear lean): small nudge toward **army**, so the
  pressure punishes the greed. *(Open question 1.)*

**Lean and commitment.** `lean` is whichever share is above the plan's curve by more than 0.1. Once
set, it holds for at least 45 s (like the doctrine's `hold`), so the posture doesn't flip on every
sighting. A switch costs real buildings, and the hold is what makes it a decision.

**Smoothing.** Shares move toward their target by at most 0.05 per think. A single poke sighting
moves them a little; a sustained read moves them a lot.

### 3.4 Fairness rules (non-negotiable)

- Only `seenEnemies`, `s.sightings` and `knownBuildings`: never the enemy's scrap, income or units
  out of sight. Bots play fair: no peeking, as with no income cheat.
- No new income multipliers.
- Every read gets a unit test showing it can't see through fog (a hidden enemy army must not count).

## 4. Where each share is used

The posture sets **targets**. The existing code still decides what and where; it just reads the
targets instead of its own ad hoc triggers.

### 4.1 Army share → production capacity (fixes the queue lock)

Target number of producers:

```
spendRate   = income over the last 60 s (scrap/s)
perFactory  = scrap/s one busy factory consumes (≈ mean cost / build time of its line: Fab ~22/s, Airpad ~25/s, Bay ~18/s)
wantFactories = ceil(army × spendRate / perFactory), clamped to [plan minimum, 8]
```

- When `have < wantFactories`, a factory goes into the build order next (replaces the
  `extraProduction` counter and its "scrap > 600 and all queues busy" trigger).
- **Queue depth caps at 2** for Hard and Brutal: one building, one waiting. Spare scrap buys factories
  instead. This is fix 1 from the replay.
- **APM caveat.** Deep queues were partly an APM saver ("each order worth more when it buys more").
  Shallow queues mean more `produce` commands. Depth comes from the action budget:
  `depth = clamp(ceil(think interval × factories / (spare APM per think)), 2, 4)`. At 175 APM this
  stays 2; at Normal's 30 APM it may stay deeper. Measure at both (§6).
- **Outnumbered** also pulls money from the economy: the harvester target stops growing past the
  current count while the read holds.

### 4.2 Economy share → Depots and harvesters (fixes the Depot chain)

- **Depot cap** = `round(economy × K)` instead of the fixed `SPEND.maxDepots` 4, with K tuned so a
  Boom curve at 0:00 allows 4 and Balanced 2–3. The "fields running low" lift stays as it is.
- **No new Depot while the fields we serve are rich**: if the fields our drop-offs serve hold more
  than `RICH_PER_HARVESTER × harvesters` (start at 900, three times `RUNNING_LOW`), the next Depot
  waits, unless economy share > 0.55 (Boom out-greeding someone). This is fix 2 from the replay.
- **Order**: when the army share is above the plan curve, a Depot can't jump ahead of a factory still
  wanted (the reverse of today's "Depot goes before anything put in ahead of it", `commander.ts:1816`,
  which stays for the economy-leaning case, since it fixed Juggernaut's starved Depot).
- **Harvesters**: `strategy.harvesters + extra + depots`, scaled by `0.8 + 0.4 × economy`
  (so ±20% around today's count).

### 4.3 Tech share → Tech Lab, Gantry, doctrine

- **Tech Lab** goes into the order when `tech ≥ 0.15` and at least two factories stand, instead of a
  fixed slot. `factoryBeforeLab` becomes "army share high → factory first".
- **Gantry**: `wantGantry` also needs `tech ≥ 0.2` (it already won't while behind).
- **Doctrine** starts when `tech ≥ 0.2` or at 6:00, whichever is first, instead of only at 6:00.
- **Tier-2 mix** (Lancer/Mastodon/Hornet chances in `runFabs`/`runPads`) scaled by tech share. Today
  these use `rich`, which becomes rarer once the scrap goes into factories.

### 4.4 Attack timing (stage 4, optional)

The greed rule's "rushing and could just win" lowers the wave threshold to the finish edge. Waves
are otherwise left alone: WAVE_EDGE, forward staging and the finishing push are tuned and working.

## 5. Observability (built first, in stage 0)

Without a trace we can't tell whether "poke sees a bigger army → more factories" happened.

- `posture` goes into the observer trace (`tools/ai/observer.ts`) every 5 s: the three shares, the
  base curve, lean, reasons, wantFactories, depot cap.
- A replay tool, `tools/ai/posture-trace.ts <record.json>`: re-seats Marshal from `seats.red.bot`
  (seed and plan), drives the recorded human side, checks the bot's orders match the record (the
  2026-11-17 re-run matched with 0 mismatches), and prints the posture timeline next to army, mined,
  factories, Depots and scrap in queues. This is the script from today's investigation, made
  permanent.
- Note: a record from before this change replays through the old bot's orders. The posture tool is
  for records made after it, or for "what would the new bot have thought at this moment" against
  the old world (shown, not acted on).

## 6. Stages

Each stage lands only if it holds up in a head-to-head against the stage before (or `e84b110` for
the first). Same battery as FORWARD-STAGING.md:

- **Panel A**: every Brutal plan × Proving Grounds, Dune Sea, Frostbite, Ashlands, Riverlands, fresh
  seeds, both sides, 175 APM burst 5, 12 min cap. ~330 games, ~3 min on 22 workers.
- **Panel B**: Hard at 100 APM, same maps, 6 plans (checks the APM caveat).
- **Panel C**: Normal at 30 APM, 4 plans (must not get worse; Normal should stay beatable).
- **Fixtures**: the pressure and raid fixtures (frozen baseline Marshal), plus a new **greed
  fixture** (§6, stage 3).
- **Replay check**: re-seat the new Marshal on `replay.json`'s map and seeds against a scripted blue,
  and confirm the queue lock and factory timing are gone (scrap in queues < 1.5k, 5+ producers by
  2:30).

Gate: the score ≥ 0.55 on Panel A with no plan clearly worse (below 0.45 at 30+ games gets a closer
look), B ≥ 0.5, C not below 0.45. Mined and army at 3:00/5:00 are reported for every run.

### Stage 0: scaffolding, no behaviour change

- `posture.ts`: the type, plan curves, `updatePosture(w, faction, s, reads)`, all reads computed.
- Wired into `AiState` and the observer trace, **read by nothing**.
- `tools/ai/posture-trace.ts`.
- Tests: curves interpolate; shares sum to 1; bounds hold; reads are fog-limited (hidden army isn't
  counted); smoothing and hold.
- Gate: the harness's tick-for-tick equivalence check against `e84b110` passes (proves it changes
  nothing).

### Stage 1: army share → factories and queue depth

- `wantFactories` replaces the `extraProduction` trigger. Queue depth from the APM budget (2 at
  Brutal).
- Outnumbered read live (the only read wired so far, plus Under attack).
- Measure separately, so we know which part helps:
  1. depth cap 2 alone (the simple fix 1),
  2. `wantFactories` with fixed plan curves (no reads),
  3. with the outnumbered read.
- Trace check: in a game where the poke sees a bigger army, the army share and factory count rise
  within ~20 s.

### Stage 2: economy share → Depots

- Depot cap from economy share, "fields still rich" hold (fix 2), the ordering rule, harvester scaling.
- Riverlands Boom needs a separate check: that plan **wants** early Depots. RIVERLANDS-BOOM.md
  showed that making expansions more cautious lost badly (4–34), so the rich-fields hold must not
  fire for an economy share above 0.55.
- Measure the hold alone first (fix 2), then the share-driven cap.

### Stage 3: the greed rule and the remaining reads

- Enemy greedy (with the momentum rule from §3.3), enemy teching, safely ahead, fields low.
- A new **greed fixture** in `tools/ai/scenarios.ts`: a frozen-baseline Marshal with
  `maxDepots: 5`, a token army and no waves before 4:00. Expected:
  - Boom Marshal (economy lean, ahead) out-expands it and is ahead on mined at 5:00;
  - Rush Marshal (army lean, could win) kills it before 4:00 more often than today;
  - Balanced (no lean) attacks it earlier than today.
- Also run the pressure fixture: the outnumbered read must still win out against the greed rule when
  the "greedy" enemy is actually massing.

### Stage 4: tech share, doctrine start, wave threshold

- Tech Lab timing, Gantry gate, doctrine from the tech share, tier-2 mix, "could just win" lowers
  the wave threshold.
- Highest risk of a regression; each piece measured alone.

### Stage 5: cleanup

- Remove what the posture replaced: `extraProduction`, `spendDown` depth, the `depotReach` chain,
  `factoryBeforeLab`, `expandEarly`'s factory insertions (each only once its replacement has passed).
- Decide separately about the disabled `secureEconomy` code (~800 lines). Recommendation: delete it.
  Its useful findings (army traded away at home) are covered by forward staging and the outnumbered
  read.
- BOTS.md / APM-BOTS.md section on the posture.

## 7. Risks and lessons

- **secureEconomy failed** as a large planner rewrite. This plan avoids that by adding the posture
  with no effect first (stage 0, proven equivalent), then moving one lever at a time, each measured
  on its own.
- **Bot mirrors hide economy changes**: B+C (Riverlands) "rarely fire in bot mirrors". The greed
  fixture, the replay check and human games are where these show up; win rates alone can mislead.
- **APM**: shallow queues cost actions. Panels B and C exist for that.
- **Oscillation**: smoothing, the 45 s hold and bounded nudges. The trace shows it if it happens.
- **Plans losing their character**: the ±0.25 cap per share keeps Rush a rush and Boom a boom. The
  fun plans have curves matching today's behaviour.
- **Brutal must stay brutal** (2026-11-01: the user is happy losing to it). Any stage that makes
  Brutal easier for a human is not adopted, even with a good h2h score.

## 8. Decisions (user, 2026-11-17)

1. **Greed rule, "neither" case**: small nudge toward army (punish the greed), as planned.
2. **Easy/Casual**: plan curves only, no scouting reads.
3. **Depth cap alone first**: if stage 1.1 (queue depth 2) carries most of the gain, ship it on its own
   ahead of the rest.
4. **Spectator HUD**: yes, show the lean ("Marshal is leaning economy") once it's traced (after stage 3).

## 9. Handoff

- Start at **stage 0**. Nothing is built yet; baseline `e84b110`.
- The replay that motivated this is `replay.json` (repo root, untracked): Dune Sea, red Brutal Air Swarm,
  bot seed 894608855. Re-seating Marshal with `seatMarshal("red", seed, "brutal", "airswarm")` and stepping
  `setupWorld(record)` with the recorded blue orders reproduces red's orders exactly (0 mismatches). The
  scratch scripts that did this (re-run, spend, army, queue money) can be rebuilt from that recipe; it is
  what `tools/ai/posture-trace.ts` should become.
- Harness: `tools/ai/run.mjs h2h --off-check no --variants off ...` (tools/ai/README.md). ~100 games ≈ 3 min.
- Key code: queue depth `commander.ts:942`; `extraProduction` trigger `commander.ts:1109`; Depot chain
  `commander.ts:1783` and Depot-first reorder `:1816`; `depotCap` / `fieldsRunningLow` `:289`;
  `rememberEnemyArmy` `:1696`; harvester target (`mining`) around `:845`; doctrine `ai/doctrine.ts`;
  Brutal settings `ai/marshal.ts:409`.

## 10. Stage 0 (built 2026-11-17)

- `src/sim/ai/posture.ts`: plan curves (`POSTURE_CURVES`, every Marshal plan), `reviewPosture` (pure: curve +
  nudges + smoothing + lean hold), `postureReads` (fog-limited), `updatePosture` (once a think, in
  `commander.ts` right after `enemyHqPos`). `AiState.posture` / `postureMemo`, set only by `marshal()`;
  stock commanders have none. Scouting nudges only where Marshal weighs (Hard, Brutal); Easy, Casual
  **and Normal** follow the curve alone (Normal has no sightings memory to read from; calling
  `rememberEnemyArmy` there would change behaviour through `s.sightings`).
- `Bot.posture()` (passed through `capApm`); the harness worker puts it in every 5 s trace sample
  (`posture` field, with the raw `reads`).
- `tools/ai/posture-trace.ts <record> [--every s] [--from s] [--reads]`: re-seats the bot seat, replays the
  other side, checks orders against the record, prints the posture next to army / mined / factories /
  Depots / scrap in queues for both sides.
- Tests: `tests/ai-posture.test.ts` (17): curves, bounds and sum under extreme reads, smoothing, graded
  outnumbered, attacked override, greed rule (outgreed / close out / fortress / punish / sitting at home),
  lean hold, fog (hidden harvesters, Lancers and Tech Lab read nothing; a live Brutal Marshal doesn't read
  a hidden army). Full suite 1868/1868 before the posture test file was added.
- Gate: harness off-check vs `e84b110`, 11 Brutal plans × 5 maps × seeds 101–104 × both sides (440 games,
  the last 220 on the final code), every game `offEquivalent: true`. `replay.json` re-run: 0 mismatches.

**Changes from §3 found while tracing `replay.json`:**

1. **Graded reads.** Our army sat at 0.75–0.85× the remembered enemy army from 2:00 to 3:00, and the
   0.8 cut flipped "outnumbered" every few thinks (shares swinging 15 points in 10 s). Outnumbered now
   ramps from 0.9× (nothing) to 0.6× (full nudge); "safely ahead" from 1.3× to 1.8×.
2. **Smoothing per second** (0.0125/s, a full pull in ~20 s), not 0.05 per think (0.25 in 10 s at 2 s thinks).
3. **Lean from the curve too**: a curve with one share ≥ 0.6 (Rush army, Boom economy) leans that way by
   itself, otherwise a Boom on its own curve has no lean and the greed rule could never out-greed.
4. **Close-out beats banking the lead**: when the greed rule says close it out, "safely ahead" doesn't
   also pull army toward economy/tech (they cancelled exactly).

**For stage 1, from the trace:**

- The remembered enemy army **undercounts** badly by 3:00 (6.9k remembered vs 11.2k real): the
  45 s `SIGHTING_TTL` forgets what scouting saw. Outnumbered then only reaches ~0.6 of its nudge, and
  1:30–1:50 read "ahead" while level. Expect to want a longer memory for posture (fair: it's what we saw)
  or a stronger nudge; measure, don't guess.
- `depotCap = round(economy × 5.7)` gives 1 once the curve's economy share falls under 0.26 (Air Swarm at
  2:50) while Marshal has 4 Depots: the cap needs to be "more Depots allowed", not a total, or K scaled by
  time. Fix before stage 2 uses it.
- `wantFactories` (from income × army share / 22) said 4 at 2:10–3:00 and 6 by 3:30; Marshal had 4, then 6–7.
  So the factory count was about what the formula wants; the queue lock (§1 point 1) is the bigger
  lever, matching decision 3: **measure depth cap 2 alone first**.

## 11. Stage 1.1: queue depth cap 2 alone (2026-11-17)

`Strategy.queueDepth` (spending down, queues go no deeper; 4 if unset), 2 for Hard and Brutal. Measured
vs `bf790d1` (stage 0, equivalent to `e84b110`), `--off-check no`, paired seeds, 12 min cap:

| Panel | Games | W-L-T | Score | Gate |
| --- | ---: | --- | ---: | --- |
| A: Brutal 175 APM, 11 plans × 5 maps, seeds 201–212 | 450 | 198-143-109 | **0.561** | ≥ 0.55 ✓ |
| B: 100 APM, 6 plans, seeds 211–213 | 180 | 73-61-46 | 0.533 | ≥ 0.5 ✓ |
| C: 30 APM, 4 plans, seeds 221–223 | 120 | 36-37-47 | 0.496 | ≥ 0.45 ✓ |

Balanced first read 0.43 over 60 games (losses on every map), then 0.62 on 60 fresh seeds: 0.52 over 120,
noise. Panel A means, candidate / baseline: scrap in queues 1.39k / 1.79k at 2:30, 2.36k / 3.29k at 5:00;
army HP 9.29k / 8.67k at 5:00; mined equal; **producers equal (4/4 at 2:30, 5/5 at 3:00)**.

**Finding: the construction slot is the bottleneck, not scrap.** Dune Sea Air Swarm (seed 201): the one
building at a time never stops until ~4:20 (Depots at 0:00/0:32/0:58/1:10, turret, Airpad, Bay, two SAMs
by 2:04, one Fab at 1:52, Tech Lab placed 2:52, Fabs 3:06/3:20/3:32), while the bank sits at **2.5k at 2:00,
7.5k at 3:00, 11k at 4:00** (the baseline 1.8k / 5.2k / 4.7k). The cap frees scrap, but nothing can turn it
into factories: `extraProduction` only appends to an order the slot is already busy with for two minutes.
So stage 1.2's `wantFactories` has to **reorder** the construction (a wanted factory ahead of Depot 3–4,
the second SAM, the early turret), not add factories to the end. That folds §4.2's ordering rule
("a Depot can't jump ahead of a factory still wanted") into stage 1.2.

## 12. Stage 1.2 / 2: what the measurements changed (2026-11-17)

**Stage 1.2 as written is a no-op.** Panel A traces (stage 1.1), means over all plans: income ~125 scrap/s
from 2:00, army spend 75–115/s, a busy producer ~25–30/s. `ceil(army × income / 22)` = 3 at Balanced 2:00;
Marshal already has 4. And about a quarter of the producers stand idle with scrap banked, by rule: Airpads
under the flak rule (Air Swarm 3:00–4:00, 16 of 30 samples), Assembly Bays at their plan's infantry share.
More factories don't help while those idle. If 1.2 is picked up again, `wantFactories` needs calibrating to
measured spend (army spend ≈ 0.65–0.9 × income), and the idle-producer rules are the likelier lever.

**The big bank is Dune Sea's.** Bank at 3:00, median / p75 (stage 1.1 candidate): Dune Sea 2.2k / 6.3k, the
other four maps 0.5–1.1k / 0.8–1.9k. Dune Sea's close rich fields let `depotReach` chain 4 Depots by 1:10.

**Fix 2 (rich-fields hold) alone: rejected.** No `depotReach` "one more" Depot while the served fields hold
> 900 per harvester, unless economy share > 0.55. vs `b6c9010`, Panel A, seeds 301–303: **105-149-76,
0.433** (Ironclad 3-25, Balanced 0.35, Air Swarm 0.37). Army +420 at 2:30, but mined −1.2k and army −800
at 5:00: the held Depots are the mid-game economy. Same lesson as RIVERLANDS-BOOM.md (cautious expansion
4–34) and the replay's own 13k home field: that field runs out, and the Depot that wasn't built is what's
missing then. Don't retry a blanket hold; if anything, a Dune Sea–specific look at what the early SAMs and
turret cost the construction slot.

## 13. Idle producers, stage 3, Dune Sea (2026-11-17)

**Why producers idle.** Brutal mirrors, 20 games, 2:00–8:00, a producer with an empty queue while more than
600 is banked, by the reason the commander skipped it: **doctrine** (an order off the committed army's
lines turns into nothing) 15% of Fab Plant time, 11% of Bays, 3% of Airpads; the **flak rule** 12% of
Airpads; everything else (reserve, Goliath fund, APM drops, the Bays' infantry share) ≤ 2% each.

**Shipped `c8a7583`:** off-doctrine factories build their usual unit from what's banked past
`unit + DOCTRINE.busyAbove` once the doctrine's own factories are fed; producers sat out by the flak or
doctrine rule no longer block `extraProduction` ("every producer busy"). Doctrine idling 15% → 6%.
Panel A (seeds 401–404, 440 games, vs `75cf9a2`): 158-160-122, **0.498**; Panel B (100 APM, 180): **0.492**.
Win rates even (doctrine starts at 6:00, most games are decided by then), but at 8:00 banked
**720 vs 2.8k** and army HP **10.4k vs 8.6k** (B: 1.9k vs 4.3k, 9.9k vs 8.5k). Shipped for the spend.

**Stage 3 consumers: rejected.** Reads unchanged (§3.3); what they bought, only off the curve (`nudge` =
share − curve, so Easy–Normal are untouched): economy nudge ≥ 0.05 → +1 Depot over the cap and +2
harvesters; army nudge ≥ 0.05 → `extraProduction` at half `expandAt`, ≥ 0.1 → one more past `maxExtra`;
greed close-out → `assaultAt × 0.6`. vs `c8a7583`:

| Panel | Games | W-L-T | Score |
| --- | ---: | --- | ---: |
| A: Brutal 175 APM, seeds 421–424 | 440 | 181-161-98 | 0.523 |
| B: 100 APM, seeds 431–433 | 180 | 58-65-57 | 0.481 |
| B again, seeds 434–436 | 180 | 59-67-54 | 0.478 |

Brutal +1 SE, Hard −0.5 SE twice with mined −250 to −400 at 5:00. Not adopted.

**Greed fixture** (`--opponents greed`, `tools/ai/scenarios.ts`): frozen-baseline Boom, 5 Depots, 16 miners,
two Fab Plants, no extra factories or raids, home until 4:00. 40 games per plan, before / after stage 3:
Boom 22-11 / 26-9, Rush 22-11 / 24-14, Balanced 24-11 / 23-12; **no kill before 4:00 either way**. It isn't
greedy against Brutal Marshal: it mines what Marshal mines (16.6k vs 16.8k at 3:00), so the greed rule
fired in ≤ 18% of samples to 5:00 (`ahead` ~50% and `teching:hit` ~45% dominate). The greed rule needs a
human out-expanding Brutal to show anything; bot mirrors don't produce one.

**Dune Sea: extra SAMs / turrets after the third factory (Hard/Brutal): rejected.** Panel A seeds 441–444
vs `c8a7583`: 167-173-100, **0.493**; Dune Sea 0.483 with the 3:00 bank 2.4k vs 3.5k; Air Swarm 0.39,
Ironclad 0.40, Proving Grounds 0.42. The early anti-air is worth its slot; the bank it frees buys nothing.

**Where that leaves the posture.** Every lever tried off it (factory count, Depot hold, stage 3's buys,
construction order) has measured even or worse in bot mirrors; queue depth 2 and the idle fix, both plain
spending fixes, are what held. The trace is still worth keeping for human replays. Next candidates, if
any: a longer sighting memory for the reads (§10: 6.9k remembered vs 11.2k real at 3:00), and judging the
greed rule on human records with `tools/ai/posture-trace.ts`, not mirrors.
