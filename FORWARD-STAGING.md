# Forward staging: a third of the way over (2026-11-17)

A retry of the Riverlands goal in [AI-ECONOMY-PLAN.md](AI-ECONOMY-PLAN.md), after the economy
planner (`secureEconomy`, [AI-ECONOMY-RETRY.md](AI-ECONOMY-RETRY.md)) failed its gates. The change
is one small, unconditional rule in `commander.ts`, plus a matching Condor fix. Baseline:
`dd4785d`. The `secureEconomy` code is still in the tree, still off, and untouched by this change.

## The change

Assault waves used to gather at `towardEnemy(hq, 9)`, 9 tiles out from the HQ in a straight line.
They now gather at `forwardStage`: **a third of the way along the walk to the enemy HQ** (at least
9 tiles; a path, so it never lands in a river). The walk is looked up again every 30 s and when
either HQ position changes.

- `condor.ts`: squads waiting within 8 tiles of the staging point may board a Condor too. Without
  this, Airborne drops on Frostbite fell from 30 to 22 in seeds 1–10, because the staging point lay
  outside the Condor's 16-tile recruiting reach. With it, they're 31. It changes nothing in classic games.
- Tests: `tests/ai-forward-stage.test.ts` (open ground, our side, past the base, mirror-fair). Three
  wave tests placed their army at the old 9-tile point and now use `forwardStage`. The Airborne
  test's seeds moved from 4, 8 to 4, 5, as that test's history does after AI changes.

## Why

Recorded traces of the `secureEconomy` work showed that Riverlands income is roughly even with the
opponent until 4:00. The gap is **army traded away**. Against the scripted raid fixture (a frozen
Marshal that keeps its army at a rally a third of the way over, then raids in 2,500 blobs),
baseline Brutal Boom went **0–7–5**. Over those 12 games Marshal lost 84.7k of army *defending its
own base* while the attacker lost 58.4k there. Its army was split between a staging point near home,
an expansion guard and sorties. The fixture's army, standing in front of its own mid field, also
covered its expansions: it had 4 Depots by 2:45 to Marshal's 3 by 3:15.

The forward point covers the mid-field Depots and their approach, meets raids before they reach
the base, and shortens every wave's walk.

## Results

All runs are Brutal Marshal (working tree) against Brutal Marshal (`dd4785d`), with both sides
played, the same bot seeds, burst 5, and timeouts at 12 minutes (scenarios: 8). The score counts a
timeout as half a win. Mined and army figures are means, candidate / opponent.

Tuning panel (Riverlands seeds 13–36 and scenario seeds 1–2, both reused for the sweep):

| Staging | Raid fixture | Pressure fixture, mined at 4:00 | Riverlands Boom (48) | Cross-map Boom (24) |
| --- | --- | --- | --- | --- |
| Baseline, 9 tiles | 0–7–5 | 17.6k / 18.2k | 0.50 | 0.50 |
| 0.22 of the walk | 0–8–4 | 16.7k / 19.4k | 0.60 | 0.56 |
| **0.33 of the walk** | **2–4–6** | **19.2k / 18.6k** | **0.60** | **0.56** |
| 0.42 of the walk | 1–5–6 | 18.5k / 19.7k | 0.60 | 0.65 |

0.33 was chosen as the setting that does best against both scripted opponents. Against the raid
fixture at 4:00 it took Marshal's mining from 18.7k to 20.3k and its army from 3.1k to 4.1k.

Fresh confirmation seeds, never used for tuning:

| Panel | Games | W–L–T | Score | Mined 4:00 | Army 4:00 | Mined 5:00 | Army 5:00 |
| --- | ---: | --- | ---: | --- | --- | --- | --- |
| Riverlands Boom, 175 APM, seeds 37–66 | 60 | 29–12–19 | **0.64** | 21.2k / 20.0k | 5.6k / 4.5k | 32.1k / 29.5k | 8.5k / 6.4k |
| Riverlands Boom, 100 APM, seeds 37–66 | 60 | 29–15–16 | **0.62** | 21.2k / 19.9k | 6.1k / 5.2k | 31.6k / 29.1k | 9.1k / 7.1k |

Every Brutal plan on Proving Grounds, Dune Sea, Frostbite, Ashlands and Riverlands, seeds 101–103,
175 APM, 30 games each:

| Plan | W–L–T | Score | | Plan | W–L–T | Score |
| --- | --- | ---: | --- | --- | --- | ---: |
| Turtle | 14–1–15 | 0.72 | | Greed | 13–9–8 | 0.57 |
| Ironclad | 17–6–7 | 0.68 | | Boom | 12–9–9 | 0.55 |
| Air Swarm | 13–4–13 | 0.65 | | Siege Train | 11–8–11 | 0.55 |
| Rush | 16–7–7 | 0.65 | | Land Grab | 12–11–7 | 0.52 |
| Balanced | 13–6–11 | 0.62 | | Hornet Strike | 14–13–3 | 0.52 |
| | | | | Skyforce | 7–9–14 | 0.47 |

All 330 games: 142–83–105, score **0.59**. Skyforce (all air) is the only plan below 0.5, and
within noise for 30 games. No plan shows a clear regression.

Every record passed the harness's replay-hash and rolling action-limit checks. The full suite
passes: 106 files, 1,852 tests. `npm run build` passes.

## Tried and rejected this round

These were measured with the same battery, and none is in the tree:

- **16 Brutal harvesters (was 12):** Riverlands 0.48. It mined +0.8k by 2:00 but −2.1k by 5:00:
  the home field just runs dry sooner.
- **WAVE_EDGE 1.6 (was 1.2):** neutral, and the raid fixture still went 0–7–5.
- **Idle army near a fight joins it (`joinFights`):** helped against the raid fixture (4:00 army
  3.1k to 4.2k), but in the Riverlands mirror it mined 1.4k less by 4:00. A home-only version
  changed nothing.
- **Boom without harassment sorties:** worse. Against the pressure fixture it mined 1.9k less by 3:00.

## Harness changes (`tools/ai`)

- The pressure and raid fixtures now run on the **frozen baseline's** Marshal (`adapter.ts`
  `createWith`). Before, they were built from the candidate source, so any Marshal change also
  changed the opponent.
- `--off-check no` A/B-tests an unconditional change (variant `off`) against the baseline without
  the tick-for-tick equivalence check. With the change disabled, that check still passes: 48
  Riverlands games came out identical on both sides.

## Still open

- No human games yet. The real test is whether the player can still win the Riverlands mid-field
  fight by walking in with a blob, and whether a raid around the side now finds the base empty.
- The `secureEconomy` planner (~800 lines, disabled) and its writeups are still in the working tree.
  This change doesn't need them. They can be removed in a separate cleanup.
