# Economy assignment implementation and exploratory evaluation

**Historical experiment report.** This file describes the implementation at the
start of the retry, including constants subsequently changed. For the current
implementation, verified regressions and final evaluation, read
[AI-ECONOMY-RETRY.md](AI-ECONOMY-RETRY.md). Do not attribute these old scores to the
current source or combine them with the new panels.

2026-11-16. Baseline: `dd4785d83e08c48eee4887ee5c7e3906b4478fa4`.

The implementation is available through `MarshalOptions.secureEconomy`. It remains
**disabled by default**, including Hard and Brutal. No difficulty settings, opening
tables, production tuning, maps, prices, simulation rules or action budgets changed.
This is an experimental implementation, not a claim of improved opponent strength.

The planner has stable resource-field identities, observed depletion history and
hauling estimates, a bounded candidate search, one persistent military assignment,
and Assemble/Secure/Hold/Recover phases. It reserves actual recruits before other
missions, recruits from obsolete movement orders, waits for physical arrival, advances
mixed-speed forces in shared hops, and coordinates crews and staffing through shared
observed-threat safety. Marshal's cap, backlog, focus/kite/retreat micro and finishing
push remain in the command path. Optional reconnaissance never gates construction,
production or movement. Diagnostic snapshots are detached from decision state.

Current starting constants: 30-second raw-depletion history (10 seconds before using
measured rates), conservative hauling capacity without sufficient history, 25-second
readiness margin, 20-second target commitment, switching advantage of at least 400
or 20%, at most eight ground fields, minimum 450 HP-adjusted escort value, known
threat value multiplied by 1.6 plus a DPS/HP/composition/range viability check,
20% home reserve capped at 600, four-tile arrival radius and advance hops,
40-second movement-stall timeout, and 10-second recovery review. A productive Hold
does not time out. Enemy sightings expire after 15 seconds; lost-Depot memory uses
the existing commander's 45 seconds. Existing specialist holds retain ownership.

The checked-in runner is documented in [tools/ai/README.md](tools/ai/README.md).
It bundles each bot graph separately, refuses incompatible non-AI simulation
sources, plays independent game processes, verifies every record's replay hashes,
checks rolling command limits, appends results incrementally and supports resume
with source/configuration integrity checks. It saves all records and traces beside
the JSONL output. Its full-world observer is separate from bot decision inputs.
No original human replay was recovered.

The first eight-minute timing pair cost approximately 15.4 seconds per candidate
game on this machine with two workers, including observer work and replay validation;
the feature-off/reference pair cost about 10–11 seconds. This is a measurement of
this harness, not a general throughput promise.

The first exploratory prototype used these commands:

```sh
npx vite-node tools/ai/economy.ts h2h --variants on --maps riverlands --plan boom --seeds 1-12 --apm 100 --burst 5 --max-minutes 12 --concurrency 3 --out /tmp/economy-exploratory-100.jsonl
npx vite-node tools/ai/economy.ts h2h --variants on --maps riverlands --plan boom --seeds 1-12 --apm 175 --burst 5 --max-minutes 12 --concurrency 3 --out /tmp/economy-exploratory-175.jsonl
```

| Prototype | Games | W–L–timeout | Match score | 4:00 delivered difference | 4:00 HP-adjusted army difference |
| --- | ---: | --- | ---: | ---: | ---: |
| Initial, 100 APM | 24 | 7–9–8 | 45.8% | −2,058 | −1,836 |
| Initial, 175 APM | 24 | 3–9–12 | 37.5% | −977 | −1,621 |

Differences are candidate minus frozen baseline, averaged within mirrored seed pairs.
All 24 games survived to 4:00 in both panels. Approximate normal pair-level 95%
intervals for match score were 34.0–57.6% and 24.7–50.3%; these small exploratory
samples cannot establish strength. The runner also reports a conservative bounded
interval that remains nonzero when all observed pair scores happen to agree.

This prototype failed the enablement gate. Review found an optional-chain error
that counted productive miners without an actual serving drop-off as dependable
income, and a forecast that could prefer guarding today's income until too late
to prepare the next source. Both were corrected with decision regressions. A
separate correctness fix removes newly reserved units from an already delayed
finishing push or marching order. These changes are not silently credited to the
earlier measured prototype.

The corrected implementation is evaluated separately with the same exploratory
seeds and settings, using `/tmp/economy-deadline-100.jsonl` and
`/tmp/economy-deadline-175.jsonl`. These reused seeds remain tuning data, not held-out
confirmation. Manifests in each adjacent `.artifacts` directory identify the exact
source hashes, source patch, revisions, bundles, openers, bot seeds and job settings.

| Corrected forecast | Games | W–L–timeout | Match score | Approximate normal pair 95% interval | 4:00 delivered difference | 4:00 HP-adjusted army difference |
| --- | ---: | --- | ---: | --- | ---: | ---: |
| 100 APM | 24 | 5–9–10 | 41.7% | 29.1–54.2% | −2,031 | −1,616 |
| 175 APM | 24 | 5–11–8 | 37.5% | 26.2–48.8% | −923 | −1,532 |

All games survived to 4:00. At 5:00 the 100 APM panel had 23 survivors and only
11 complete mirrored pairs; the summary reports those counts instead of padding
the early-ending game. Conservative bounded score intervals were 2.5–80.9% and
0–76.7%. None of these results support enabling the option. At 4:00, accepted army
queue spending was lower by approximately 2,097 and 895 respectively, while bank
differences were only +14 and +42. These measurements do not justify changing
production tables to disguise the income/positioning regression.

Pressure and raid fixtures use real income and paid production. Their predeclared
exploratory variants are 0–2; variants 3–5 remain held out. They vary timing,
composition and lane, and mirror both positions and actions. The initial bridge-centre
pressure position left the mining entry outside weapon range; it was moved to the
Riverlands crystal approach before the corrected scenario panel. The earlier scenario
smoke results do not demonstrate the targeted access failure or an improvement.

The final fixtures additionally assemble 1,800 of real HP-adjusted army before
advancing, use Marshal's paid Rush/Ironclad/Balanced macro, preserve the scripted
military destination between planning passes, and send grouped movement through
the same outer cap. They never spawn reinforcements or grant income. Run:

```sh
npx vite-node tools/ai/economy.ts scenarios --variants off,on --seeds 1 --scenario-variants 0-2 --apm 100 --burst 5 --max-minutes 8 --concurrency 3 --out /tmp/economy-final-scenarios.jsonl
```

| Fixture | Option | W–L–timeout | Observed 4:00 games | Mean 4:00 mining delivered | Mean 4:00 harvesters lost |
| --- | --- | --- | ---: | ---: | ---: |
| Pressure | Off | 5–0–1 | 6/6 | 18,245 | 0 |
| Pressure | On | 2–0–4 | 6/6 | 17,124 | 0.5 |
| Raid | Off | 4–0–2 | 6/6 | 19,992 | 0 |
| Raid | On | 6–0–0 | 5/6 | 18,963 | 0 |

The missing raid observation is an early win, not an observed 4:00 army or income.
Median time spent with zero mining delivered over a complete rolling 30-second
window after 2:00 was zero in every fixture/option group. Thus this panel has a
zero baseline for that starvation measure: it does **not** reproduce the sustained
historical access failure, cannot demonstrate a halved interruption, and does not
pass the scenario gate. Do not interpret the raid wins as proof of an economic
improvement. All twelve feature-off games matched the frozen bot's capped commands
tick for tick, and every record passed replay validation.

Large-map profiling used mirrored Three Canyons seed 7, Boom, 100 APM/burst 5 and
a 12-minute limit. The initial profile identified exhaustive per-miner field-route
checks. Ranking with the same field scores before checking routes reduced candidate
bot time from roughly 54–56 seconds to 4.24–4.26 seconds per game. Planning-pass
95th percentiles fell from 256–275 ms to 17.8–21.1 ms; worst bot ticks remained
79–91 ms. These inclusive wall-clock measurements include diagnostic cloning and
observer callback work, not just the front module. Data and manifests are in
`/tmp/economy-large-profile.jsonl` and `/tmp/economy-large-profile-lazy.jsonl`.
The completed latter command was rerun to verify resume without rerunning games.
Tracing its blue-side record on current code verified all 72 checkpoint hashes.

Additional correctness regressions cover specialist Goliaths with unavailable
weapons and live mining entries separated from the home ground region. Neither
nominal price nor a nearby unreachable tile establishes useful cover or access.
These final safety/geometry fixes are not credited with improving earlier panel
scores. Cross-map smoke commands, separate from confirmation:

```sh
npx vite-node tools/ai/economy.ts h2h --variants on --maps proving-grounds,dune-sea,frostbite,ashlands --plan boom --seeds 1 --apm 100 --burst 5 --max-minutes 8 --concurrency 2 --out /tmp/economy-final-map-smoke.jsonl
```

All eight smoke records passed replay/action-limit checks. Existing specialist,
four-player, lower-difficulty and mode tests remain part of the full suite.

Final verification: `npm test` passed all 103 Vitest files (1,829 tests, including
26 focused economy-front regressions) and all four archive tests. `npm run build`
and `git diff --check` passed. The full-suite log is
`/tmp/ai-economy-final-source-test.log`; the build log is `/tmp/ai-economy-build.log`.

Acceptance remains gated on a reproducible scenario income/access benefit, confirmation
across fresh seeds/maps/opponents, acceptable worst-case performance and new human games on both
sides. Broad automatic enablement and the large held-out confirmation panel are
intentionally deferred when the narrow experiment does not pass. No human-play
validation or 55% strength claim is implied by passing decision tests.
