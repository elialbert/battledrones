# Riverlands: Brutal Boom starves (replay 2026-11-16)

The player beat Brutal Marshal on Riverlands twice in a row. Their complaint: "on this map the AI just
cannot build a good enough army fast enough." This doc covers the second of those games.

- **Replay:** `replay.json` in the repo root, untracked. Commit 49e178f, map seed 500642886.
- **Red:** `bot:marshal:brutal`, plan **boom**, bot seed 26671355.
- **Result:** blue (the player) won at 4:43 by HQ kill.

## What happened

Red didn't lose on army control. It lost on economy: it overspent on buildings early, then its income
stopped completely at 3:30.

| | Blue (player) | Red (Marshal) |
|---|---|---|
| Mined by 3:00 | 14.2k | 12.7k |
| Army by 3:00 | 8.1k | 5.3k |
| Buildings bought by 3:30 | 2.45k | ~4.2k (4 Fab Plants, 4 turrets, 2 SAMs, Tech Lab, 3 Depots) |
| Harvesters at 3:30 | 23 | 17 |
| Mined by 3:30 / at the end | 21.1k / 31.5k | 14.8k / 14.8k |

The map, from red's side (red's HQ is at 46,5; it is a mirror image for blue):

| Field | Scrap | Notes |
|---|---|---|
| Home, 53,2 | 16.3k | Dry at ~3:15 for both sides. |
| "Pocket", 50,20 | 12.5k | Rocks to the north, ringed by water. Way in from the west mouth (~45,20), next to mid. |
| Mid, 37,26 | 10k | Blue's mirror is 19,29. |
| Others | 5k each | Farther out. |

Timeline for red:

1. **1:45:** a crew founds a forward Depot at 40,23, by the mid field. Red never mines that field: the
   player's army is close enough that `tendFields` treats it as unsafe. The player builds its own
   second Depot by its mid field at 1:42 and mines all 10k of it between 2:30 and 4:00.
2. **2:14–2:50 and 3:20–4:20:** harvesters bounce between fields every few seconds, from the mid field
   (38.5,25.5) to the pocket (49.5,20.5) to a far field (29.5,3.5) to a recall home (47.5,3.5). They mine
   almost nothing. Mechanism:
   - `tendFields` sends a harvester and records it in `sentAt`.
   - The harvester goes idle within the 20 s `RETRY` window, so `tendFields` skips it.
   - The commander's idle fallback (`nearestReachableResource`, which knows nothing about safety) sends
     it to the nearest field, the unsafe mid one.
   - On the next think, `tendFields` calls it off again.
3. **3:00:** a third Depot is built at 54,6, next to the home field with 1.1k left. The near end of
   that field was dry, so its far end no longer counted as "served".
4. **3:17:** the player's 7.5k army kills the mid Depot. A crew sent to found one at 48,32 walks into
   that army (4 harvesters lost). Six more die at 40,20 on their way to the pocket.
5. **3:30 on:** zero income. By 4:20 all 11 harvesters left stand idle at home. The player walks in.

Over the whole game red mined about 1k of the pocket's 12.5k.

## Fixes tried

Head-to-heads ran Brutal Marshal (working tree) against Brutal Marshal (HEAD, from a git worktree).
Each map and seed was played from both sides, with up to 14 minutes per game. Results are new code's
W-L-D.

| Fix | What it did | Result | Kept? |
|---|---|---|---|
| **A** Safer expansion | `unservedField`: among fields up to 8 steps farther on foot, take the one at least 6 tiles farther from the enemy HQ (pocket over mid). | Boom vs Boom, Riverlands: **4-34-2**, mined 21.0k vs 27.3k by 5:00. With A switched off: 10-19-11, mining even. | No |
| **B** No fallback onto unsafe fields | `tendFields` returns `unsafeAt`. The commander's idle fallback leaves a harvester where it is instead of sending it to a field `tendFields` calls unsafe. | See B+C below. | **Yes** |
| **C** No Depot by a dry field | `fieldScrapLeft` / `DRY_FIELD = 2000` (expansion.ts): `unservedField` and `scanDepotSite` skip fields with less than 2k left. | See B+C below. | **Yes** |
| **D** Leaner Boom | Boom's fast build order without its two turrets. | D alone, Boom on Ashlands + Frostbite: **15-42-23**, about 3k less mined by 5:00. Turrets protect Boom's harvesters from pokes. | No |

Results for B and C together:

- **Boom, Ashlands + Frostbite:** 36-30-14, mining identical.
- **Random Brutal plans, 5 maps (A off, D on):** 36-42-42, mining even.
- B and C rarely come into play in bot-vs-bot games. They target what broke in the human game.

Why A failed: the pocket field is ringed by water, so its Depot lands at the mouth (45,20), five
tiles from mid anyway, and the mid field is simply the better one to mine. That matches the earlier
direction from the Ashlands replay: expanding forward is part of being aggressive, so don't make
expansions more cautious.

## State of the code

Uncommitted on `main` (49e178f): B and C only, in `src/sim/ai/fields.ts`, `src/sim/ai/commander.ts`
and `src/sim/ai/expansion.ts`. All 1803 tests pass. Pushing deploys live.

## Still open: the actual complaint

B and C don't make Marshal's army bigger on Riverlands. The real problem: the player's army takes mid
at about 3:15, just as Marshal's home field runs dry, and Marshal has nowhere else worth mining.
During that window red's army stood at about 36-42,12, in front of its own base.

Next idea, not started: contest or hold mid before the home field runs dry. Hooks that already
exist in `commander.ts`:

- `guardPoint`, chosen from the hold point, then `s.contest`, then `expansionGuard`, then the active
  field.
- `CONTEST_SHARE`, the share of the army that guards a contested site.
- The `contestable` / `contestWinnable` weighing, which Land Grab and the "fields running low" case
  use.
- Step 1b', where the army defends a raided expansion (`defendExpansions`, `EXPANSION_DEFEND_ODDS`).

A possible shape: once the home field is, say, two thirds mined, move the guard point to the
forward Depot or field, and go out to a fight there that `contestWinnable` says can be won. Measure on
Riverlands with Boom first, then all maps with random plans.

## Harness notes

- Scripts were in the session scratchpad and aren't kept: replay traces of harvesters, fields,
  buildings and army positions, plus `h2h.ts` bundled with esbuild using `--alias:OLD=<worktree>`.
  See the `marshal-h2h-harness` memory for the recipe.
- One h2h batch of 240 games on 22 cores takes about 7 minutes, because long games dominate. Time a
  long game before estimating.
