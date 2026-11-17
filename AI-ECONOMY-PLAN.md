# Marshal: secure the next economy before the current one runs out

Latest retry, corrected dispatch regressions, and acceptance decision:
[AI-ECONOMY-RETRY.md](AI-ECONOMY-RETRY.md). The historical results below are not
measurements of the latest source. `secureEconomy` remains disabled.

Implementation and evaluation plan, 2026-11-16. Builds on the retained B and C fixes in
[RIVERLANDS-BOOM.md](RIVERLANDS-BOOM.md), now committed as
`dd4785d83e08c48eee4887ee5c7e3906b4478fa4` ("working on expansions and improving brutal").
That revision is the frozen baseline for this work. The experimental implementation and
evaluation status are documented in [AI-ECONOMY-RESULTS.md](AI-ECONOMY-RESULTS.md).
The option remains disabled in difficulty presets pending the acceptance checks below.

## Objective

Make Marshal a harder, more intelligent opponent by coordinating its army with its future income.
It should recognize that its current mining will run out, choose the next workable source, and
position enough force to secure it while it still has the income to replace losses.

The intended player experience is an opponent that arrives at valuable ground before a crisis,
protects the miners it invests in, and makes the player fight for access to resources. It should
retain its different openings and personalities. Winning every engagement, protecting every
Depot, or always taking the middle is not the objective.

Constraints agreed with the user:

- Resource locations and remaining resource counts across the map are allowed knowledge. Treat
  them as knowledge from previous play; do not spend this project adding resource fog or memory.
- Enemy units and military activity still obey fog and concealment. Use current sightings,
  remembered sightings, known buildings, public objectives, and inferences from those sources.
- Same resources, costs, production rules, movement, and commands as a player. No economic or
  combat bonuses, free scouts, or hidden access to enemy queues or money.
- Keep action caps, bursts, think intervals, and reaction intervals fixed during comparisons.
  Evaluate at a common 100 APM as well as the existing Brutal settings: 175 APM, burst 5.
- Scouting is part of the build-out and provides reasons to change course. It must not become
  a prerequisite that holds up production, positioning, or expansion until a report arrives.
- Keep this work separate from unit balance, map changes, opening rewrites, and economy tuning.
  Preserve the retained B/C fixes and the rejection of A/D unless new, isolated evidence changes
  that conclusion.

## Evidence and working hypothesis

The Riverlands replay is a useful diagnosis, not a complete benchmark:

- Map seed 500642886; red Brutal Marshal, Boom, bot seed 26671355; blue wins at 4:43.
- The existing forward Depot is founded around 1:45. Its field is never productively mined before
  the player takes it. By about 3:15 the home field is exhausted and military access matters more
  than another economic building.
- The player mined 14.2k by 3:00; Marshal mined 12.7k. Marshal finishes at about 14.8k mined.
- Replaying the record on the reviewed working tree matched all 28 recorded hashes.
- The player averaged 65 command APM; Marshal averaged 111. More command capacity alone is not
  the obvious missing ingredient.
- At 2:00 the player held all three Uplinks and Marshal held none. This supports investigating
  map control; it does not establish the cause of every army-value difference.

The source record was `replay.json` in the root during review. It is no longer present when this
plan is finalized and was not included in the baseline commit. Preserve a recovered copy as a
named regression fixture if available; its map/bot seeds alone cannot recreate the player's
commands. The new scripted scenarios and baseline comparisons must be self-contained and must
not depend on recovering that record.

The working hypothesis: Marshal treats expansion, mining safety, guard duty, objectives, and an
attack on the enemy base as partially separate decisions. It can build a forward Depot, refuse to
mine it, and gather its army near home for a larger attack. Each local rule is understandable;
the combination loses access to future income.

There are specific integration problems to address:

1. `commander.ts` computes `guardPoint` before `tendExpansion` updates `s.contest`, so an updated
   contest normally affects a later planning pass.
2. Economy guard recruitment uses `idleArmy()`. Units with obsolete movement or attack orders
   cannot simply be reassigned when the important location changes.
3. `guardShare` becomes 0.15 in assault mode before considering a contest. `contestWinnable`
   evaluates a fight using 0.6 of total army value. The assumed and assigned forces can differ.
4. Assault staging remains near home, and launching is weighed against the remembered enemy
   army. Holding a local mining approach should not require meeting the threshold for an attack
   on the enemy base.
5. `staffExpansions`, `tendFields`, and the idle fallback have different responsibilities and
   safety checks. Adding an escort must not reintroduce contradictory harvester orders.
6. Marshal's wrapper can trim, delay, merge, or replace commands. A proposed assignment is not
   evidence that the units have received orders or reached the field.

## Scope and rollout

Implement one persistent economy assignment, not a replacement for every AI subsystem.
The first target is ordinary ground mining in two-player skirmishes, starting with Brutal Boom
on Riverlands. Validate across other maps and personalities before enabling it broadly.

Use an explicit experimental option, tentatively `secureEconomy`, passed from `MarshalOptions`
to `AiState`. The planner starts disabled by default. Compare it on and off with identical bot
settings; enable it in Hard/Brutal presets only after the acceptance checks below.

Initially leave Easy, Casual, Normal, survival, scripted Ops, HQ-less/Goliath-base starts,
four-player games, and specialist island/mesa logistics on their existing behavior. Make this an
explicit eligibility check rather than relying on the planner to accidentally find no target.
Ordinary reachable ground fields on eligible maps remain eligible; island relay captures,
airlifted mining, and Goliath outposts remain their existing planners' responsibility.

Existing specialist plans must retain ownership of their units. If that leaves too little force
to secure a field, report that reason and use the fallback behavior. Do not silently take a Siege
Train, strike wing, Condor cargo, or active harassment sortie apart to make a score look better.

## 1. Preserve a reproducible baseline and harness

Deliver this before changing behavior. The previous temporary harness is gone; its recipe must
not be required to interpret new results.

Add a checked-in harness under `tools/ai/` with a small README. Proposed commands, to implement:

```sh
npx vite-node tools/ai/economy.ts trace --record <recovered-record.json> --out /tmp/riverlands-trace.jsonl
npx vite-node tools/ai/economy.ts scenarios --variants off,on --out /tmp/economy-scenarios.jsonl
npx vite-node tools/ai/economy.ts h2h --baseline <commit> --maps riverlands --plan boom --seeds 1-12 --apm 100 --out /tmp/economy-h2h.jsonl
npx vite-node tools/ai/economy.ts summary /tmp/economy-h2h.jsonl
```

These are proposed interfaces, not commands that work yet. Reuse the existing arena record,
setup, opener, APM, and replay facilities. `tools/pacing-match.ts` is useful for metric ideas,
but it runs stock commanders, so calling it unchanged would not benchmark capped Marshal.

Harness requirements:

- Record the exact baseline and candidate revisions/diffs, configuration, map seed, each bot
  seed, selected plans, openers, cap/burst, maximum duration, and harness version.
- Compare against an immutable baseline containing B/C. An option-off comparison in the candidate
  also helps detect unintended effects from shared refactors; it does not replace the frozen
  baseline comparison.
- Isolate baseline and candidate module graphs, using separately bundled adapters or equivalent.
  Give each full game one simulation implementation. Never mix old/new balance tables, world
  helpers, or cached modules in the same simulated world. Confirm compatible sim rules first.
- Swap versions between blue and red while preserving each version's seed and plan for the
  pair. Mirror scenario positions and actions too. Report pair results, not just blue win rate.
- Run games in independent processes with configurable concurrency and deterministic job IDs.
  Parallel processes are useful here; parallelizing decisions inside a simulation is unnecessary.
- Save JSONL incrementally, allow resume, and preserve representative battle records plus traces.
  Store large generated batches outside the source tree; keep commands and small fixtures in it.
- Time a representative long game before scheduling a large panel. The previous estimate was
  about seven minutes for 240 games on 22 cores, not a promise for this environment.

The observer may inspect the complete world for measurement. Clearly separate that observer from
the bot's decision inputs. Diagnostic callbacks must not affect RNG, command order, or behavior.

### Measurements

Sample match state every five seconds and emit events on assignment/phase changes. Include:

| Measure | Purpose |
|---|---|
| Harvest delivered and raw field depletion, separately | Distinguish usable income from mining and cargo in transit |
| Mining income over rolling 30-second windows | Detect a sustained interruption without treating a gap between deliveries as starvation |
| Harvester count, losses, cargo, and order/phase mix | Distinguish death, waiting, transfer, harvesting, hauling, and unloading |
| Remaining resources at safe active sites | Measure the income deadline the planner should anticipate |
| Candidate field, route, existing Depot, and predicted ready time | Explain the expansion decision |
| Requested, assigned, ordered, and arrived army strength | Catch differences between planned protection and actual protection |
| Field/route threat estimate, confidence, and last observation time | Explain engagement, scouting, and withdrawal decisions |
| Scout orders, planned/actual departure times, and reasons for delays | Verify reconnaissance does not become a prerequisite for useful movement or expansion |
| Depot/crew losses and delivered mining income per expansion | Identify investments that never earn anything |
| Total and HP-adjusted combat value at 2:00, 3:00, 4:00, and 5:00 | Check the player's actual complaint about army size |
| Army production spend, queues, bank, and building spend | Explain an army deficit that positioning alone fails to fix |
| Uplink-seconds, Uplink income, crates, and army losses | Detect map-control tradeoffs |
| Commands proposed and sent, average and rolling peak APM, command mix | Catch budget starvation, command churn, and cap dependence |
| Winner, duration, timeout, and terminal state | Distinguish wins, stalled games, and genuinely drawn games |

Report fixed-time metrics with survival counts. A game ending before 5:00 does not have an
observed 5:00 army; do not silently drop those games or pad them into misleading averages.

## 2. Build a shared description of the mining economy

Suggested module: `src/sim/ai/economy-front.ts`, with small field helpers extracted only where
needed. Keep the actual mining and construction commands in their current modules initially.

Represent each field with a stable identity derived from map resource terrain, including depleted
tiles. The existing `commander.ts` field grouping and the new `fieldScrapLeft` group across gaps
of two tiles; `fields.ts` currently groups adjacent live tiles. Make that difference explicit.
Use stable field identity for the assignment, but preserve live mining-entry and reachability
semantics during the first extraction. Do not silently change every harvester's field scoring.

Describe each relevant site using:

- Remaining raw resource quantity, remaining scrap value, and live mining-entry tiles. Crystal
  conversion matters for value; raw depletion and scrap income are different units.
- Drop-off that serves it, travel distances along legal ground routes, and expected hauling cost.
- Harvesters actually working it, en route, or waiting; an empty Depot does not establish income.
- Access safety along the route and around the mining/unloading area, using sightings and memory.
- Friendly combat cover and useful reachable positions on the approach.
- Whether this is current dependable income, an existing expansion to activate, or a prospective
  expansion requiring a crew and construction.

Reconcile safety judgments across `tendFields`, staffing, and the new planner. At minimum they
must consume the same relevant threat observations and agree that a route is unsafe. A friendly
escort is useful only when it is present and capable; a promised escort must not make a mining
route safe early. Avoid a broad threat-system rewrite unless the focused change requires it.

### Predict a deadline, not a fixed percentage

Estimate each currently productive field's time to depletion from remaining raw resources and a
smoothed recent depletion rate. Initially use a short rolling window, roughly 20–30 seconds, and
a conservative capacity estimate when there is not enough history. Keep all decisions tick-based
and deterministic.

For several fields, project which staffed, accessible sites will remain productive over the
next planning horizon. Do not simply divide all resources near all Depots by total harvesters:
unsafe, unreachable, unstaffed, or slow-to-activate sites are not current dependable income.

Estimate readiness for the next source as:

```text
time to make a useful force available and arrive together
+ time to clear known threats on the approach if necessary
+ crew travel and Depot construction, when a Depot is needed
+ miner transfer and first delivery
+ margin for issuing orders and uncertainty
```

Some tasks overlap. Use a dependency schedule rather than always adding them sequentially:
reconnaissance accompanies normal production, army movement, and crew preparation. Scout travel
and a promised report do not add a prerequisite to this schedule. A crew can travel on a route
with acceptable estimated risk while the army gathers; a known hostile approach can require
clearance or a different route. An existing forward Depot removes the crew/construction steps
entirely. Do not require complete visibility to start a build-out.

Preparation becomes urgent when projected dependable mining is likely to drop materially before
the next source can deliver. Include a separate emergency case for lost access or zero productive
miners, so a temporarily low depletion rate cannot falsely imply an infinite runway.

The bank can affect urgency, but a large bank must not justify waiting until access is lost.
Record the forecast and compare it with actual depletion/first-delivery times before tuning it.

## 3. Choose and retain one useful economic target

Prefer activating or protecting an existing useful expansion when it is competitive with founding
another one. In the replay, a Depot already exists at mid: another building is not the first answer.

Rank a bounded set of candidates using interpretable components:

1. Reachable resource value and likely delivery rate over a short common horizon.
2. Time until that income can begin, including gathering a viable escort.
3. Actual deployment cost: Depot, four consumed harvesters, replacement/training time, and their
   lost mining while traveling. Do not treat the Depot's 250 price as its complete cost.
4. Known route/site danger, friendly support, and what must remain to defend home.
5. The opportunity cost of abandoning another productive field or a valuable active attack.

Use a few named components and trace their values. First reject unreachable or clearly hopeless
candidates, then rank the rest. Avoid a large weighted formula whose output cannot be explained.
Use deterministic, side-relative tie-breaks. The same mirrored situation should choose mirrored
positions and force allocations.

Retain a target for a minimum commitment period, initially around 20 seconds, unless an emergency,
invalid target, or materially changed threat requires switching. Require a meaningful advantage
before changing to another valid target. These are starting hypotheses to measure, not frozen
balance decisions. One depleted tile or a lone enemy moving across vision must not restart the plan.

## 4. Give the army a persistent economy assignment

Suggested state, owned by `AiState` and reconstructed per match:

```ts
interface EconomyFrontPlan {
  fieldId: number;
  depotId?: number;
  phase: "assemble" | "secure" | "hold" | "recover";
  assigned: number[];
  since: number;
  phaseSince: number;
  // Reachable approach/hold/retreat positions, forecast, and diagnostic reasons.
}
```

Exact names are implementation choices. Keep one assignment and a small state machine; do not
introduce a generic task framework or a second planner for every unit.

| Phase | Intended behavior | Exit condition |
|---|---|---|
| Assemble | Gather the selected force at a reachable position on our side of the danger | A sufficient force has actually arrived; deadline/timeout requires reassessment |
| Secure | Advance the force together to control the route and mining approach | Access is usable, the force loses viability, or progress stalls |
| Hold | Cover productive miners/crew and reinforce as needed; keep a retreat route | Field is exhausted, income has moved, home needs the force, or holding is no longer viable |
| Recover | Withdraw survivors, keep miners out, and reassess another source or reinforce | A viable revised target exists or the assignment is released |

Skip Assemble when a sufficient force is already available. No phase has "scout arrived" or
"report received" as an exit condition.

### Scouting runs alongside the assignment

Marshal must act on its best current estimate and revise that estimate as the build-out proceeds.
Choose a provisional target, keep production running, prepare the crew, and move an appropriate
force without waiting for a separate scouting trip. Use reconnaissance to change the route,
escort, target, or timing when it reveals a reason to do so.

- Use opening units, existing Scouts, harassment sorties, and the advancing army's own vision.
  Send a cheap available unit ahead or to a flank when useful. Do not require a dedicated Scout
  to be built, arrive, or survive before the rest of the plan can act.
- Each optional scouting order should answer a decision: is this approach occupied, is the main
  army moving toward us, or has another field become easier to take? Prefer observation positions
  along the build-out and likely enemy approaches, keeping command and travel costs useful.
- Reconnaissance can run during Assemble, Secure, Hold, and Recover. Keep watching the approach
  after mining begins so new threats can trigger reinforcement, evacuation, or a target change.
- An absent, late, or dead scout does not freeze or restart the assignment. Continue using current
  estimates; observed contact or a scout loss can raise the estimated risk and justify a concrete
  response. It does not reveal the exact unseen enemy force.
- Enemy absence from current vision is not proof of safety. Reuse remembered sightings, known
  defences, and recent Depot-loss history, with uncertainty margins. Missing information alone
  must not create an indefinite hold or an ever-growing hypothetical enemy army.
- A delay needs a material reason: a known losing engagement, inadequate available protection,
  blocked route, home emergency, or actual construction/resource constraint. "Waiting for scout"
  is not a valid reason. Continue other productive work while resolving that constraint.

Fresh sightings can override the ordinary target commitment period when the plan becomes clearly
unsafe or another route offers a materially better opportunity. Small changes still obey target
hysteresis. The goal is prompt adaptation during useful movement, not repeated exploratory moves
that prevent committing to anything.

### Recruit units that can do the job

The pool may include idle units and units traveling toward an obsolete home guard/staging
assignment. Reassign those deliberately, once, instead of waiting for them to become idle.
Exclude units in active specialist missions, cargo, dodge/retreat holds, and fights where leaving
would immediately lose a useful engagement. Include relevant domain/counter checks.

Keep enough capability for credible known home threats, considering home defences. Do not use a
permanent oversized home reserve that reproduces the original problem. Existing genuine home
emergencies may preempt the assignment; trace that decision and return/replan afterward.

Evaluate the actual selected force at the expected engagement location and arrival time:

- HP, damage against the observed composition, domains, ranges, and relevant static defences.
- Units able to reach and fight together, including movement speed and terrain bottlenecks.
- Nearby friendly cover that will still be useful there.
- Visible enemy units and plausibly relevant remembered units. Do not charge the same sighting
  twice or require every local move to beat an enemy force observed far away.

Reuse/extract Marshal's existing combat-strength logic where practical. Start with a conservative
approximation and test representative matchups; no need for a full battle rollout engine.
Store both requested and actually available capability so a selected percentage of the whole
army never substitutes for a fieldable force.

Choose a legal approach/hold position by path and firing access. A field centroid, or a straight
step toward the enemy HQ, may lie in water, behind rocks, or on the wrong side of a choke. The
pocket on Riverlands must be judged through its western mouth, not by its apparent proximity.

### When the fight cannot be won

Do not send the crew or feed reinforcements into it one by one. Compare other reachable sources,
retain safe mining while it lasts, gather a stronger force when feasible, and inspect uncertain
alternatives. Use existing harassment behavior without taking the reserved force away; creating
a new coordinated diversion system is deferred.

If there is no viable source, enter an explicit recovery state with a reason and review after
new information or a measured interval. Do not repeatedly found the same dead Depot, reset the
same failed assignment, or send miners back through a known hostile approach. Desperation alone
must not make an otherwise losing force count as capable.

## 5. Integrate ownership and action delivery

This is the critical implementation work. A new destination that loses to the old controllers
will not solve the replay.

Within one decision pass, aim for this dependency order:

1. Update observations, memory, lost Depots, and existing specialist holds.
2. Determine genuine home emergencies and units temporarily unavailable to the planner.
3. Update the economy forecast, target, selected force, and assignment phase.
4. Reserve assigned units for this pass, then let other planners use the remaining pool.
5. Coordinate crew/staffing/mining decisions with actual route access and existing construction.
6. Emit ordinary commands through Marshal's existing trim/merge/rank/backlog/APM path.
7. On later ticks, reconcile the plan with actual unit orders, positions, surviving IDs, and
   constructed buildings. `sent()` proves a command passed the cap, not that the sim accepted it
   or that movement/construction succeeded.

Specific interactions to cover:

- **Guard and assault:** The economy assignment supplies its own required force and holds it out
  of ordinary assault staging. Do not reduce that force to 15% merely because `mode` is assault.
  Only unassigned units count as available for launching another wave. Remove reassigned IDs
  from stale `s.wave` membership, and clear related marching waits without clearing real retreat
  holds. Preserve a push already close to winning when that remains the better decision.
- **Finishing push:** `marshal.ts` currently plans a separate finishing order. It must respect
  the economy assignment, or explicitly preempt it for a well-supported finishing opportunity.
  Do not let it silently commandeer the same units on every reaction pass.
- **Fight micro:** Focus fire and kiting can act on the assigned force; retreat and dodge retain
  priority. A retreat hold must prevent the planner from immediately ordering those units forward.
  Surface temporary unavailability to the planning context rather than reserving phantom strength.
- **Expansion crews:** Coordinate with `tendExpansion`; avoid a second independent economic
  target in `s.contest`. Preserve legacy behavior when the feature is off. An exposed crew waits
  for real access when known danger requires it; incomplete scouting alone does not hold the
  crew at home. A route with acceptable estimated risk need not wait for a ceremonial full-army
  escort or full vision coverage.
- **Staffing and fields:** A selected target is not permission to mine it. `staffExpansions`,
  `tendFields`, and idle fallback must not override an evacuation or send miners ahead of cover.
  Once access is established, they must actually activate the existing Depot instead of keeping
  all miners at home indefinitely.
- **Other missions:** Respect specialist holds in recruitment, assault, and finishing logic.
  Avoid reserving one unit for two missions across planning passes.
- **Objectives:** Existing garrisons remain assigned; new optional captures use the spare pool.
  Trace why Marshal misses its own accessible Uplink. A wider rewrite of objective priorities is
  deferred unless the new reservation itself creates a regression.
- **Production:** Keep existing openings, factory expansion, counters, and doctrine initially.
  Measure idle factories and spending deficits; do not adjust them to conceal a failed assignment.

Group orders by purpose/destination. Reissue only for a phase change, a meaningful destination or
threat change, new reinforcements, or an actual interrupted order. Use the existing no-op trimming.
If reservation or phase validity changes, remove stale pending economy commands before they can
land. Add only the command provenance/rank support needed for this assignment. Securing an urgent
income route must receive actions under the cap, but cannot starve production with repeated moves.

Do not grant a new command budget or bypass the wrapper. Use named priority for necessary group
movement if measurements show the generic Army rank starves it. Safety reflexes stay above it;
routine hold-position tidying stays below productive work.

## 6. Test decisions and coordination with focused scenarios

Add focused tests, tentatively `tests/ai-economy-front.test.ts`, plus a few integration cases in
existing suites where appropriate. Prefer behavioral assertions over reproducing score formulas
or snapshotting every command. Use small worlds for decision tests and real maps for geometry.

Required cases:

1. Home mining is approaching exhaustion and an existing forward Depot is usable: the planner
   selects it and moves a useful force before depletion, without founding another Depot first.
2. Safe current mining has ample runway: no unnecessary whole-army transfer or opening disruption.
3. Several Depots exist but only one field is accessible/staffed: inaccessible stock does not hide
   the deadline. Losing access entirely triggers recovery even when depletion becomes zero.
4. A guard target changes while units still walk to the old staging point: eligible units receive
   a useful new group assignment; no idle-only deadlock.
5. Assault mode is active: the assignment receives its evaluated force, and the remainder does
   not count those units again in an offensive wave or finishing push.
6. The wrapper drops/delays an order under a low cap, or the sim refuses it: no phase advances on
   imagined arrival, no crew starts through an unsecured route, and useful orders can retry.
7. Focus fire/kiting occurs, then a real retreat: the assignment survives appropriate micro but
   does not cancel dodge or send retreating units forward during their hold.
8. An enemy force is briefly unseen or a Depot dies: memory prevents immediate unsafe restaffing.
   Conversely, fresh information can justify resuming work instead of preserving fear forever.
9. A losing force blocks the nearest field, and a viable alternative exists: choose the alternative.
   If none exists, recover without repeated suicide crews or reinforcements.
10. A threatened HQ needs the force: preempt safely; after the emergency, release/replan reservations.
11. Slow units or rocks separate the army: count the force that can arrive, and avoid attacking with
    only the fast leading units. The chosen hold position is reachable and militarily useful.
12. Field depletion changes individual live tiles: stable assignment identity prevents oscillation.
    Two otherwise similar candidates do not cause repeated switching on tiny score changes.
13. Fog fairness: changing hidden enemy positions/queues/money while preserving the bot's known
    state does not change decisions. Allowed resource counts may change decisions.
14. Determinism and symmetry: mirrored setups produce mirrored choices; repeated matches produce
    identical commands and replay hashes. Diagnostics on/off produce identical commands.
15. Existing specialist missions and all explicitly excluded modes retain their ownership/behavior
    with the feature disabled or ineligible.
16. Integration checks preserve B/C: an idle miner is not sent onto a rejected unsafe field, and
    an almost exhausted field does not attract a new Depot. Include a case with a safe alternative.
17. No Scout exists, its order is delayed by the cap, or it dies en route: with otherwise adequate
    resources and force and no known prohibitive threat, production and build-out still proceed
    promptly. No assignment phase or crew departure is gated on receiving a scouting report.
18. Reconnaissance discovers a stronger enemy while the army/crew is already moving: adapt the
    route, force, or target before feeding units into the known losing fight. A new opening on
    another approach can also justify changing course. Verify useful progress before the report
    and a timely response afterward, rather than only checking that a scout order was issued.

Add two checked-in, full-loop scripted opponents using ordinary commands and real income:

- **Riverlands mid pressure:** grow a real economy/army and occupy the relevant approach around
  the home-field transition. Do not spawn the threatening army for free during the benchmark.
- **Home raid while expanding:** threaten the base as the army moves out, checking that Marshal
  does not mechanically abandon home or permanently give up its economic assignment.

Small unit-test fixtures may construct positions directly. Clearly distinguish those from
full-loop opponents. Include deterministic variations in arrival time, composition, and route,
and reserve some variants for validation after tuning.

The original human replay remains useful for tracing the old failure and verifying replay
compatibility. Replaying its recorded red commands does not exercise the new bot. Replaying only
the blue commands against a new red bot is also a fragile strength benchmark: entity IDs and the
world diverge, and the recorded player does not react. Use the scripts and new human games for
counterfactual evaluation.

## 7. Evaluate in stages, then decide whether to enable

### Stage A: explain and reproduce

Trace the original record if recovered; otherwise retain the documented historical diagnosis.
Reproduce the missed economic transition in the scripted scenario, including the difference
between the army it could send and the army that actually arrives.
Record baseline behavior with B/C already applied. If the script does not reproduce a meaningful
access/income failure, fix the scenario before claiming an improvement.

### Stage B: narrow experiment

Enable only the new assignment for eligible Brutal Boom games. Keep all other tuning constant.
Run the scripted scenarios and a 24-game exploratory Riverlands mirror panel: 12 seed pairs, both
sides, at 100 APM. Repeat at existing Brutal settings. Inspect representative wins and losses.

The intended result is timely productive access, a smaller income interruption, and a larger
sustainable army around 3:00–5:00. A Depot surviving while nobody mines, or a good mining number
achieved by losing the HQ, does not satisfy the objective.

Use this small panel for diagnosis, not a final strength claim. Remove the feature if its only
benefit comes from sending miners into danger or avoiding useful fights forever.

### Stage C: held-out confirmation and regressions

After selecting one implementation/configuration, freeze it and use fresh seeds and scenario
variants. A practical confirmation panel is:

- Riverlands Boom: 30 mirrored seed pairs at each cap, 60 games per cap.
- Cross-map: Proving Grounds, Riverlands, Dune Sea, Frostbite, and Ashlands; 12 mirrored seed pairs
  each at 100 APM, with a recorded, fixed schedule of eligible plans: 120 games total.
- Opponent diversity: include frozen baseline Marshal, Rush, Turtle, Greed, and the scripted
  pressure/raid opponents. Cover these deliberately; do not treat mirror self-play as sufficient.
- Specialist smoke checks: existing tests and a small predetermined set on Three Canyons,
  Archipelago, four-player, survival, and excluded mutators/modes. Excluded behavior must remain
  unchanged; this is not a claim that the new planner improves those modes.

Report W-L-timeout separately, side splits, and paired differences in economic/army metrics.
Use confidence intervals with the mirrored seed pair as the sampling unit; do not treat all
games or all five-second samples as independent. Avoid repeatedly tuning on the held-out panel.

### Acceptance and stop conditions

Hard requirements:

- No new information access outside the agreed resource-count exception; no simulation bonuses.
- No increases to configured action/reaction limits; enforce the rolling action bound including
  burst. No repeated group moves that repeatedly stop firing or consume production actions.
- No contradictory mission ownership, retreat override, or crew/miner safety regression.
- No blocking scout phase, report prerequisite, or suspension of productive build-out merely
  because reconnaissance is incomplete, delayed, or lost. Trace material reasons for delays.
- Deterministic commands, valid replay hashes, and required test/build checks pass.

Performance evidence required before enabling:

- On the targeted pressure scenario, the candidate consistently establishes useful access before
  home mining ends, or makes an explainable viable alternative. Predeclare the tested scenario
  variants and count failures, including early HQ losses.
- As initial practical targets on those scenarios: cut the median access-related mining
  interruption by at least half and improve 4:00 delivered mining income by roughly 15% without
  increasing harvester/crew losses. Confirm these are appropriate after measuring baseline; lock
  the thresholds before the held-out run. Report zero-baseline and early-ending games separately.
- On Riverlands confirmation, aim for at least a 55% match score against baseline, scoring a
  timeout 0.5 for this statistic only. Give the uncertainty interval and timeout rate. A noisy
  55% result is supporting evidence, not proof of strength by itself.
- Across the wider panel, investigate an aggregate match score below 45%, a material increase in
  timeouts, or a repeatable map/plan regression. Small per-map samples trigger investigation,
  not confident claims about that map. Do not trade away broad competence for this one scenario.
- Improvements remain visible at 100 APM. If they appear only at the existing 175 cap, investigate
  command priority and churn before enabling.
- Play new human games on both sides, including deliberate home raids and alternative routes.
  Watch whether Marshal forces meaningful decisions and whether a repeated simple tactic still
  shuts its economy down. Human wins do not invalidate the change; an easily repeated failure does.

If positioning improves access but the army remains small, use the spending/queue data to write
a separate production or investment change. Do not quietly add that change to this experiment.

## Implementation order and reviewable checkpoints

| Checkpoint | Deliverable | Evidence before moving on |
|---|---|---|
| 0 | Baseline manifest, resumable harness, reproducible scripted pressure, original-record trace if recovered | Scripted records verify; baseline can be rerun from the README |
| 1 | Stable field/site description and runway estimate, diagnostics only | Forecast traces make sense; feature-off commands unchanged |
| 2 | Candidate selection, small persistent state machine, and focused decision tests | Existing Depot preference, alternatives, memory, symmetry, and hysteresis behave correctly |
| 3 | Army recruitment/reservations, wrapper integration, crew/miner coordination | No idle-only deadlock; actual arrival, safety, micro, and cap tests pass |
| 4 | Narrow A/B runs and isolated tuning | Better access/income on pressure scenarios; explanations for failures |
| 5 | Frozen confirmation panel, human play, results writeup | Acceptance evidence supports enabling Hard/Brutal in eligible games |

At checkpoint 5, document the chosen constants, exact commands, raw result locations, representative
records, rejected variants, known limitations, and enabled modes in this file or a linked results
document. Update the historical note's next-step pointer if useful, without rewriting its old
results as though the new work had already happened.

Expected source touch points:

- New `src/sim/ai/economy-front.ts`: forecast, candidate choice, persistent assignment, force needs,
  state transitions, and read-only diagnostic access.
- `src/sim/ai/commander.ts`: same-pass planning order, assignment context, unit reservations,
  guard/assault integration, and one source of truth for the economic target.
- `src/sim/ai/expansion.ts` and `fields.ts`: field/site helpers and coordination of access,
  construction, staffing, and mining; preserve B/C.
- `src/sim/ai/marshal.ts`: experimental option, temporary holds exposed to planning, stale-wave and
  finishing-push integration, and command provenance/priority only where needed.
- `src/sim/ai/intel.ts`: extract reusable strength evaluation only if it avoids duplicating the
  existing fight evaluator; keep enemy information contracts explicit.
- New `tools/ai/` harness/scenarios/README and focused tests.

Verification: run focused tests while implementing, then the full `npm test` and `npm run build`
before enabling. Local HTTP test servers need an environment that permits loopback binding;
sandbox `listen EPERM` is an environment failure to rerun, not an AI regression. Profile planner
cost on a large map and a long crowded match; cache shared field/path scans per tick and bound
candidate path searches. No per-tick global planner or exhaustive battle simulation is needed.

## Deferred work

Potential follow-ups, each requiring its own evidence and experiment:

- Wider Uplink/crate priorities and deliberate attacks that draw defenders away from mining.
- Production/investment payback, excess static defence, and earlier composition changes.
- Coordinating several fronts at once, and supporting island/mesa/Goliath economies and FFA.
- Changing difficulty caps, openings, units, maps, or game rules.

The first change should earn its place by turning an available army into continued income at the
right time. Its success should be visible in actual miner deliveries and in the fights a player
has to take to stop them.
