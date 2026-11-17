# Economy assignment experiment

The committed reference is `dd4785d83e08c48eee4887ee5c7e3906b4478fa4`
(retained B/C). `secureEconomy` remains off in difficulty presets. Run from
the repository root:

```sh
node tools/ai/run.mjs h2h --paired-seeds same --variants off,on --maps riverlands --plan boom --seeds 1-12 --apm 100 --burst 5 --max-minutes 12 --concurrency 4 --out /tmp/economy-h2h.jsonl
node tools/ai/run.mjs scenarios --paired-seeds same --variants off,on --seeds 1 --scenario-variants 0-2 --apm 100 --burst 5 --concurrency 4 --out /tmp/economy-scenarios.jsonl
node tools/ai/run.mjs summary /tmp/economy-h2h.jsonl
node tools/ai/run.mjs trace --record /path/to/record.json --out /tmp/record-trace.jsonl --review-record /tmp/record-current.json
```

The launcher bundles into an owned temporary directory and runs Node directly.
It avoids application Vite/PWA plugins and filesystem watchers. The TypeScript
entry still works through `vite-node`, but repeated concurrent Vite launchers
can exhaust file watchers in this repository's Python environment.

To A/B an unconditional change (no option to switch it), run variant `off` with
`--off-check no`: the candidate is then the working tree as it stands, and the
tick-for-tick equivalence check with the frozen baseline is skipped. The scripted
pressure/raid opponents always run on the frozen baseline's Marshal
(`adapter.ts` `createWith`), so a candidate change never changes its opponent.
See [FORWARD-STAGING.md](../../FORWARD-STAGING.md).

First time one pair with `--max-minutes 8 --variants on --concurrency 1`.
Use `--apm 175 --burst 5` for the existing Brutal cap and a fresh output for
each configuration. Each game is an independent process. Seeds are explicit
integers, comma lists or inclusive ranges. Both sides are always run, keeping
each version's seed fixed within a mirror pair.

Use `--paired-seeds same` for a controlled comparison of the same personality:
both versions receive the same bot seed. `--paired-seeds independent` reproduces
the original experiment's two different bot seeds. Those small panels can have
substantial personality bias; a raw score above 50% needs comparison with the
feature-off control. The historical default remains `independent`.

To compare against an uncommitted experimental implementation saved as a source
tree, explicitly specify its root and enable its option:

```sh
node tools/ai/run.mjs h2h --baseline-source /tmp/previous-source --baseline-enabled on --paired-seeds same --variants on --maps riverlands --plan boom --seeds 1-12 --apm 100 --burst 5 --max-minutes 12 --concurrency 4 --out /tmp/previous-vs-current.jsonl
```

The runner copies and fingerprints that baseline's complete `src` tree into
the artifacts, checks its non-AI simulation sources, and bundles its adapter
separately. The manifest distinguishes this snapshot from its underlying Git
commit. Default committed-baseline runs use the option off. Feature-off candidate
games against that reference also compare every capped command tick for tick.

Every game uses one simulation implementation with separately bundled bot graphs.
The runner rejects incompatible non-AI simulation sources. JSONL results append
after each verified game. Repeating an identical command resumes completed IDs;
changed sources or configuration require a new output. The adjacent `.artifacts`
directory keeps exact source snapshots, hashes, patches, revisions, bundle hashes,
settings, jobs, every battle record and five-second observer trace. Keep generated
batches outside the repository. Records are checkpointed each simulated minute;
every completed record must pass replay and rolling action-limit checks.

Traces separate delivered income from raw depletion and include rolling 30-second
income, resources, miner phases/cargo/losses, accepted queue spending, lifetime
Depot deliveries, Uplink time, command mix and detached assignment diagnostics.
The observer reads the full world and never feeds its measurements into decisions.
The wrapper keeps capped dodge requests until dispatch or expiry, refreshes escape
directions from already noticed public warnings, and prevents lower-priority orders
from cancelling dodges or retreats. Retreating/dodging units are excluded from
mining cover. Nested caps report the final dispatch receipt and strictest budget;
no token allowance or reaction interval is increased.
The assignment coordinates crew destinations, staffing and field routing through
observed-threat access checks. It preserves the baseline building and production
schedule: choosing a future field does not itself authorize another Depot. Home
mining keeps the baseline raid policy; defence and each miner's flee reflex handle
fire there, rather than a strategic order evacuating the entire home shift. The
military-only ablation preserves the baseline mining and staging policies and is
identified separately in the results; helper tests alone do not prove integration.

Pressure/raid fixtures use ordinary commands, paid production and real income.
They retain Brutal's economy settings and combat micro. Pressure uses a ground
build order with 16–18 base miners (plus the normal Depot staffing demand), resembling
the recorded player's larger mining shift and ground investment. It assembles
4,500 of actual HP-adjusted army; the raid uses normal plan construction and a
2,500 wave threshold. Reinforcements assemble too. No units or money are granted.
Variants change plan (Boom, Ironclad, Balanced), time and lane, and mirror positions
and actions. Variants 0–2 are exploratory; 3–5 remain held out. Validate an actual
baseline access failure before claiming that a fixture demonstrates an improvement.

Records use the arena simulator fingerprint for the game viewer, independently of
the non-AI compatibility digest. Checkpoints use the arena atomic writer. For an
older header, `trace --review-record` verifies every checkpoint and uses the arena
resimulation facility to create a viewer-compatible copy with an audit trail. It
never overwrites the original and never reruns either bot.

The summary separates wins, losses, draws, timeouts and side splits. Match-score intervals
use complete mirrored pairs only and report incomplete pairs. Fixed-time economic
and army metrics include survival counts; early endings are never padded. Small
panels, tuning on repeated seeds, and timeout scores cannot establish strength.
Scenario access/income benefits, fresh confirmation and human play remain gates
to enabling the option in presets.
