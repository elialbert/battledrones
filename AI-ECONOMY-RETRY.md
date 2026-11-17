# Economy assignment retry — 2026-11-16

The strength objective is still unproven. `MarshalOptions.secureEconomy` remains
disabled, including Hard and Brutal. This retry fixes demonstrated integration
failures and makes evaluation reproducible; passing regression tests does not
establish a stronger opponent. No human confirmation game was performed and the
original human replay was not recovered.

The starting point was the unstaged experiment and its plan, on top of
`dd4785d83e08c48eee4887ee5c7e3906b4478fa4`. The retained B/C safety fixes remain:
an idle miner cannot fall back onto a rejected field, and a new Depot requires
at least 2,000 reachable raw resource. Crystal yield cannot bypass that threshold.
Production schedules, openings, prices, map generation, income multipliers,
reaction intervals and action-cap allowances are unchanged.

## Corrected failures

- Assembly freezes its recruited force instead of increasing its arrival goal
  whenever production finishes another unit at home. Reinforcements cannot pull
  the advance waypoint backward. The stall timer measures physical progress;
  a long journey is not itself a stall.
- The holding point protects the approach to a pocket. A field can remain a
  candidate while it is being worked; a Depot cannot promise immediate staffing
  for a second patch when its current shift serves another field. Candidate
  resource totals exclude tiles that ground units cannot reach.
- Shared threat checks account for observed enemy health as well as friendly
  health. Small contacts do not close an entire route. An injured enemy still
  blocks an unescorted shift. Home raids retain the baseline home-mining policy.
- Optional Scout orders are dispatched rather than removed as non-roster escort
  commands. Kiting and focus-fire holds are separate from actual retreats.
  Retreating or dodging defenders do not count as cover for new mining orders.
- Pending escort commands carry field, phase and roster provenance. Expired
  orders cannot recall a released force. Active attack waves and specialist
  missions retain ownership; mature quiet holds can release forces for assault.
- A finishing push cannot overwrite a same-tick retreat or dodge. Capped dodges
  survive until dispatch or expiry, and their direction is rechecked against
  already noticed public warnings. This does not shorten reaction delay.
- Nested APM caps report the actual outer dispatch receipt and the strictest
  budget. Token rates and burst sizes are unchanged. Discretionary repositioning
  yields to productive combat and production when the physical cap is constrained.

The final implementation coordinates the military assignment with crew
destinations, staffing and safe field routing. Choosing a target does not itself
authorize another Depot: normal construction scheduling still applies. A
military-only ablation was explored and rejected as an insufficient solution.

## Evaluation corrections

The runner now snapshots all candidate source, tests and harness files, validates
baseline simulation compatibility, preserves independently bundled bots, and
checks every completed replay and rolling command limit. The Node launcher avoids
Vite/PWA watchers. Records use the arena's simulator fingerprint and atomic
checkpoint writer, so they can be opened in the game viewer. The separate full-world
observer never supplies decision inputs. See [tools/ai/README.md](tools/ai/README.md).

The original independent bot seeds biased small panels: feature-off against the
same frozen feature-off implementation scored 54.2% at 100 APM and 66.7% at
175 APM on seeds 1–12. An exploratory 56.3%/64.6% result therefore did not establish
improvement. Final comparisons use `--paired-seeds same`, mirrored sides and an
unchanged frozen baseline. Feature-off control games compare every capped command
against a separately instantiated frozen bot.

The paid pressure fixture originally lost Brutal's miner settings by replacing
its tweak object. That is fixed and regression-tested. Pressure and raid variants
0–2 preserve combat micro, buy their units, gather their waves, and mirror their
orders. They grant no units or resources. Held-out variants 3–5 remain unused.

Several exploratory panels were used to diagnose failures. They are not pooled
with fresh confirmation games. In a pre-dispatch-fix same-seed panel (37–48), the
full coordinator scored 31.25% at 100 APM and 43.75% at 175 APM; corresponding
feature-off controls scored exactly 50%. That panel also failed the pressure
income gate. Those are superseded source measurements, not final results.

## Final verification

The final frozen source was evaluated against the committed feature-off baseline
on Riverlands, Boom, seeds 61–72, both sides, matching bot seeds, 12 simulated
minutes, burst 5. Timeouts count as half a point, not wins.

| Cap | Games | W–L–timeout | Match score | Approx. paired 95% interval | 4:00 delivered difference | 4:00 army HP-value difference |
| --- | ---: | --- | ---: | --- | ---: | ---: |
| 100 APM | 24 | 6–9–9 | 43.75% | 23.6–63.9% | −1,207 | −789 |
| 175 APM | 24 | 3–13–8 | 29.17% | 14.6–43.7% | −830 | −643 |

Differences are candidate minus opponent, averaged within complete mirrored
pairs. All 24 games in each panel survived to both 4:00 and 5:00. At 5:00 the
delivered differences were −2,254 and −2,504 respectively. The small samples and
approximate intervals do not support an improvement claim; the poor economic
results independently fail the acceptance gate.

The final eight-minute paid scenarios used Riverlands seed 1, variants 0–2,
100 APM/burst 5, both sides, feature off/on. Each cell contains six games.

| Scenario | Option | W–L–timeout | 4:00 delivered | 4:00 miners lost | Median longest zero-income episode |
| --- | --- | --- | ---: | ---: | ---: |
| Pressure | off | 0–0–6 | 17,235 | 1.83 | 10 seconds |
| Pressure | on | 0–0–6 | 15,354 | 3.50 | 47.5 seconds |
| Raid | off | 0–2–4 | 18,487 | 0.83 | 0 seconds |
| Raid | on | 0–3–3 | 18,763 | 0.33 | 0 seconds |

An episode counts consecutive five-second samples with a full trailing 30-second
window of zero mining delivery, after 2:00. It is a sampled measurement, not exact
idle time. Pressure baseline first zero windows occurred at 3:45–6:15 in four of
six games; this fixture now reproduces actual baseline income interruption.
The enabled version interrupts income in all six, with longest episodes ranging
10–135 seconds. Raid's improved 4:00 miner survival does not survive as an overall
strength claim: its losses increase, and by 5:00 mean miner losses are 3.0 versus
1.33 off. No held-out scenario variants were spent after these failed gates.

Cross-map smoke: Proving Grounds, Dune Sea, Frostbite and Ashlands, seed 1, mirrored
sides, eight minutes, 100 APM: 1 win, 0 losses, 7 timeouts. This establishes that
the integration runs on those maps; it is far too small and timeout-heavy to
establish strength. A separate two-minute off/on smoke completed all four games.

The final large-map timing pair ran after the other jobs completed: Three Canyons
(120×120), seed 7, both sides, 12 minutes, 100 APM, two workers. Candidate bot-call
CPU time was 4.97/6.50 seconds per game versus 1.82/1.80 seconds for its baseline
opponent. Candidate planning p95 was 22.5/37.5 ms and worst bot calls 44.0/85.3 ms.
End-to-end game plus replay took 56.0/69.9 seconds. These local two-process timings
include runtime scheduling and are not a browser frame-time guarantee. The
additional planning cost is material and provides no reason to waive the failed
strength gate. Records and timing data are in
`/tmp/economy-dispatch-final-profile.jsonl` and its adjacent artifacts directory.

All **86 completed games and 4,675 replay checkpoints** passed replay-hash and
rolling action-limit checks. All 12
scenario feature-off games and both feature-off smoke games matched the frozen
baseline's capped command stream tick for tick. Repeating the smoke command
resumed without adding games. Manifests match the current source, tests and harness.
An older-format replay was verified against all 34 hashes and converted to a
viewer-compatible copy with the arena's resimulation audit trail, preserving its
original file and checkpoint hashes.

Regression tests include real `marshal`/`tickAi` command paths, not only planner
helpers. In isolated temporary source copies, restoring each of three old bugs
(discarding a capped dodge, permitting a push to overwrite retreat, counting
retreating defenders as cover) makes its regression fail. The current source
passes those cases. Earlier isolated reversions also reproduced reinforcement
recall and the kiting/retreat classification failure.

Final `npm test`: **105 test files, 1,849 tests passed**, plus all four archive
tests. `npm run build` passed TypeScript checking and the production/PWA build.
`git diff --check` passed. Logs are `/tmp/economy-dispatch-final-tests.log` and
`/tmp/economy-dispatch-final-build.log`. These checks ran on the final source,
including the delayed-dodge direction and same-packet retreat corrections.

### Reproduce and inspect

```sh
node tools/ai/run.mjs h2h --paired-seeds same --variants on --maps riverlands --plan boom --seeds 61-72 --apm 100 --burst 5 --max-minutes 12 --concurrency 4 --out /tmp/economy-dispatch-final-100.jsonl
node tools/ai/run.mjs h2h --paired-seeds same --variants on --maps riverlands --plan boom --seeds 61-72 --apm 175 --burst 5 --max-minutes 12 --concurrency 4 --out /tmp/economy-dispatch-final-175.jsonl
node tools/ai/run.mjs scenarios --paired-seeds same --variants off,on --maps riverlands --plan boom --seeds 1 --scenario-variants 0-2 --apm 100 --burst 5 --max-minutes 8 --concurrency 3 --out /tmp/economy-dispatch-final-scenarios.jsonl
node tools/ai/run.mjs summary /tmp/economy-dispatch-final-100.jsonl
```

Each JSONL has an adjacent `.artifacts` directory containing the exact manifest,
source snapshots, settings, jobs, records and traces. These are local artifacts,
not committed fixtures. Manifest signature prefixes: 100 APM `6468b8a8859c`,
175 APM `db90add58797`, scenarios `b2ac2ba091c1`, maps `6614355fb6c4`, smoke
`6ebb0fea2275`. The non-AI compatibility digest is
`f526753178660bfd8c0638e87dbada0361101fcf662dc0587df11a1319a98ae5`;
viewer simulator fingerprint is `39fef7c8d6cfc061`.

### Acceptance decision

Do not enable this experiment in a preset. Correcting dispatch and access bugs
did not solve the strategic tradeoff: this implementation still loses army value
and income in the comparisons. The evidence does not isolate a
single further parameter change that would fix that. Another tuning pass on these
same seeds would not be fresh confirmation. The remaining product goal is a
stronger opponent with reliable forward income; that goal is **not achieved**.
The next revision needs a new, isolated strategic hypothesis and then fresh
pressure/raid evidence before spending held-out variants or asking for human
confirmation games.
