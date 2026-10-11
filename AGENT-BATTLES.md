# Agent Battles — design proposal

## Status

A proposal. None of it is built. Two AI models, say GPT-6 Sol and Claude
Opus 5.5, play a Battle Drones skirmish against each other. Each one plays
through a few tools that show **only what its side could see**, as a human
player would through the fog of war.

**It all runs on one machine.** One Node process runs the game and both
seats. It needs no server, no WebSockets and none of the online multiplayer
work in MULTIPLAYER.md. The only network traffic is the calls to the model
providers' APIs, and there's none at all with local models. The public game
doesn't change: nothing here is in the production build.

| Decision | Recommended | Alternatives |
|---|---|---|
| Where it runs | **One Node process** (`tools/arena.ts`) holds the only copy of the world | A browser tab; a server |
| Timing | **5-second rounds**: both sides see the same moment and their orders apply together | Real time |
| Who plays | **Models through their APIs**, with only the game tools | Coding agents (Claude Code, Codex…) through a local MCP server, tools only; the built-in AI as a seat |
| Coordinates | **Each side's own frame**: your HQ is always lower left | True map coordinates for both |
| Observation | **Compact text** with stable ids | JSON |
| Memory | **A fresh context each round**, plus the agent's own notes | The whole conversation; the last few rounds |
| Limits per round | **Equal tool-call and output-token budgets**; API errors are retried | A wall-clock deadline |
| Watching | A **battle record file**, played in a **dev-only viewer**, live or afterwards | Video export |

## Goals

- **Model against model, fairly.** The same tools, the same information,
  the same limits and the same maps, with sides swapped between games.
- **Only what the side can see.** Fog of war is enforced by the runner, not
  by trust.
- **Watchable.** A battle plays back in the game's own 3D view, with each
  commander's radio lines voiced by the announcer.
- **Reproducible.** Every battle is a small file that replays exactly.
- **Useful for balance work.** Agents find strategies the scripted AI never
  tries.
- **Invisible in the public game.** The runner is a dev tool, and the viewer
  only exists in dev builds.

## Non-goals (for now)

Agents playing people, agents playing across the internet (both need the
online work in MULTIPLAYER.md), real-time play, Last Stand and Ops, and
public leaderboards.

## Why one machine is enough

- **The game is a pure, deterministic simulation.** `step(w, commands)` in
  `src/sim/sim.ts` advances the world one tick at 10 ticks a second. It
  imports no engine code and already runs headless in Node for the tests and
  for `tools/balance.ts` and `tools/pacing.ts`. All randomness comes from the
  match seed (`src/sim/rand.ts`), so the seed and the commands decide the
  whole battle.
- **It's cheap.** Measured headless on this repo: `step()` costs 0.44 ms a
  tick on Riverlands (56×56) and 0.54 ms on the Archipelago (108×108). A
  5-second round is 50 ticks, about 25 ms. All the time in a match goes to
  the models thinking.
- **One process holds the only copy of the world.** Nothing has to be kept
  in step between machines, so nothing can fall out of sync.
- **A seat is just a source of commands for one side.** Every input reaches
  the sim as a plain-JSON `Command` (`src/sim/types.ts`), and `applyCommand`
  ignores any order for a unit the command's side doesn't own. The built-in
  AI commander already works this way: `tickAi(w, faction, state)` returns
  `Command[]`, and `GameScene` runs `step(world, [...blue, ...red])`.
- **The fog helpers exist.** The commander plays "by the same rules and fog
  of war as you" through `seenEnemies` (`src/sim/ai/intel.ts`, which applies
  the fog and Sniper Teams hiding in woods) and `knownBuildings`
  (`src/sim/fog.ts`, enemy buildings as last seen).

## The runner

```bash
npx vite-node tools/arena.ts run \
  --blue claude-opus-5-5 --red gpt-6-sol \
  --map riverlands --seed 42 [--mutators blitz] [--round 5] [--out battles/]
npx vite-node tools/arena.ts run --blue claude-opus-5-5 --red ai:ironclad:hard   # against the built-in AI
npx vite-node tools/arena.ts series --a claude-opus-5-5 --b gpt-6-sol --maps all --seeds 3   # mirror pairs
npx vite-node tools/arena.ts stats battles/*.json
npx vite-node tools/arena.ts watch battles/2026-10-11-opus-vs-sol-42.json
```

API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
The `battles/` folder is gitignored.

The loop, in outline:

```ts
const w = createMapWorld(map, { seed, objectives: true, mutators });   // a normal skirmish
const picks = await bothSeats((s) => s.chooseOpener(briefing(w, s.side)));
applyOpener(w, "blue", picks.blue); applyOpener(w, "red", picks.red);  // always blue, then red
tickFog(w);
while (!w.winner && w.tick < MAX_TICKS) {
  // both seats see the same tick, and neither sees the other's orders
  const turns = await bothSeats((s) => s.turn(observe(w, s.side)));
  let orders = [...stamp("blue", turns.blue), ...stamp("red", turns.red)];
  for (let i = 0; i < ROUND_TICKS && !w.winner; i++) {
    step(w, [...orders, ...builtInAiSeats(w)]);   // a seat played by the built-in AI still ticks every tick
    orders = [];
    record.tick(w);                                // hash every 100 ticks
  }
  record.round(turns);                             // orders, notes, radio, usage
}
```

`stamp` sets each command's `faction` to the seat's own side, whatever the
model wrote. A seat can only ever command its own army.

A match with the built-in AI as a seat (`ai:<personality>:<difficulty>`)
calls `tickAi` every tick as in a normal game. So it reacts inside rounds
where an agent can't. That's the opponent people play, so beating it means
something, and it gives every model a fixed yardstick: "Opus beats Hard
Ironclad 7 games out of 10".

## Timing: rounds

A model takes from seconds to minutes to decide, and the game runs 10 ticks
a second.

| Option | |
|---|---|
| **Rounds** (recommended) | The game stops every 5 s of game time (50 ticks). Both agents look at the same moment, give their orders and end their round. Then the sim runs the next 50 ticks, with both sides' orders applied at the first of them. How fast a model or its provider answers doesn't matter. |
| Real time | The sim runs at 10 Hz by the wall clock, and each agent's orders land whenever its call returns. Between orders, units fight and harvest on their own (idle units shoot back, harvesters keep mining). The faster model wins, and so does the faster provider on the day. It's more like a human match, but it measures latency as much as play. |

A 10-minute match is at most 120 rounds. A cap (`MAX_TICKS`, say 20:00 of
game time) ends a match nobody can finish as a draw. `wait(n)` lets an agent
skip quiet rounds. A wait ends early if something urgent happens: your HQ is attacked,
an enemy strike warning appears, or enemies come near your base. The game
already has this rule for people: its game-speed control drops back to 1×
when an enemy strike, a raid or an attack on the HQ needs the player's hands
(`src/game/awareness.ts`).

**Openers.** A skirmish starts with three cards: Blitz (a Fab Plant and 3
Stingers), Industry (a third harvester and scrap) or Air Wing (an Airpad and
3 Wasps). Each agent picks one from its briefing before the first round,
and the two picks are revealed together.

## Each side's own frame

The maps are point-symmetric: red's half is blue's turned 180°.
`sideFrame(w, faction)` in `src/sim/world.ts` already converts between the
map and each side's view. It exists because searches that broke ties by scan
order once handed red about 70% of Ashlands mirror games.

**Recommended: each agent sees the map in its own frame.** The runner turns
every coordinate in red's observations through `sideFrame` and turns red's
orders back. Both agents then always have their HQ in the lower left and
the enemy in the top right. In a mirror match, the two observations at the
start are identical apart from the ids, as long as lists are sorted by
position in the side's own frame rather than by id. That keeps any model's
habits about "up" and "down" out of the result.

The alternative is true coordinates for both. It's simpler to read in a
transcript, but red always plays "from the top".

Transcripts and the viewer note which frame they use: a transcript is in the
agent's own frame, and the viewer shows the real map.

## Tools

| Tool | What it does |
|---|---|
| `briefing()` | Called once. Your side, the rules in brief and the three opener cards. A unit and building table generated from `src/sim/balance.ts`: cost, HP, damage, range, what it's strong and weak against, and what builds it. The map as ASCII (from `tools/export-maps.ts --ascii`) with a legend, your HQ, and the fact that the enemy HQ is yours turned 180° (people know that too). It never changes, so it sits in the cached part of the prompt. |
| `observe()` | This round's state (see below). |
| `look(x, y, r)` | A close-up ASCII patch of terrain with the units on it. Only what you can see. |
| `orders([...])` | The sim's own commands, plus shortcuts (below). Each order comes back `ok` or with the reason it was refused. |
| `end_round(notes, radio?)` | Submits the round. `notes` (up to 2 KB) is the agent's memory, handed back next round. `radio` (up to 120 characters) is an optional line for spectators. |
| `wait(rounds)` | Ends this round and skips the next n − 1, unless something urgent happens. |

### What `observe()` shows

Real output from a prototype (Riverlands, seed 4321, blue at 3:00 of an
AI-vs-AI match, with Blitz against Air Wing):

```
T 3:00  scrap 800  meter 47
BUILDINGS
  #1 hq 4,48 98%
  #10 fab-plant 6,44 100% queue flak-crawler
  #24 airpad 4,46 83% queue wasp,raptor
  #31 turret 9,45 100%
  #43 tech-lab 2,48 100%
  #53 assembly-bay 7,48 100%
  #64 depot 10,41 100%
  #72 turret 9,44 100%
  #81 radar 8,46 100%
  building airpad
UNITS
  harvester ×5: #3 14,43 100% harvest harvesting; #14 14,44 100% harvest harvesting; …
  stinger ×3: #11 42,13 83% attack #23 ★1; #129 12,47 100% idle; #135 7,47 100% idle
  mender ×2: #57 29,27 100% attackMove 33,22; #84 31,24 59% attackMove 33,22
  trooper ×7: #71 33,24 100% attack #23; #77 33,24 100% attack #23; …
  mortar ×2: #83 38,19 100% attack #23; #110 31,24 100% attack #23
  titan ×1: #97 34,23 96% attack #23
  condor ×1: #103 10,46 100% idle
  …
ENEMY SEEN
  #49 trooper 32,26 100%
  #89 lancer 36,20 100%
  #107 stinger 27,28 100%
  #126 raptor 44,9 42%
  #132 sniper 46,10 100%
  …
ENEMY BUILDINGS (as last seen)
  #2 hq 49,5
  #23 fab-plant 50,8
  #106 sam-site 44,9
  …
UPLINKS
  #7 28,28 theirs contested
  #8 46,46 theirs
  #9 11,11 neutral (enemy is taking it)
```

The full version of that one is 1,810 characters, about 500 tokens. In the
same kind of matches, an observation for one side was about 400 characters
at 1:00, 1,200–1,700 at 3:00 and 1,500–1,900 at 6:00, on both Riverlands and
the Archipelago. The finished tool adds:

- the calldowns that are ready, and the Sky Hammer's countdown;
- supply drops (announced to both sides 10 s ahead in the game too) and
  strike warning circles (public in the game);
- **what happened since the last round**: your losses and kills, your
  buildings finished, and the alerts the radio announcer would have called
  out for your side ("Enemy aircraft detected", "Our HQ is under attack");
- the results of last round's orders, and your notes.

The ASCII map is 2.3k characters for a 48×48 map but 11.7k for the
Archipelago's 108×108. For the big map, the briefing shows a half-size
version and `look()` gives the detail.

**Format.** Compact text with stable ids is recommended. It's about half the
tokens of the same thing as JSON, and models read it well. JSON is easier to
parse reliably, and running a few matches each way would settle it.

### What an agent may see

`observe()` and `look()` are built only from:

- **your own side**: all units, buildings, queues, scrap and meters;
- **enemy units you can see now**: `seenEnemies(w, side)`, which also keeps
  a Sniper Team hidden in woods hidden;
- **enemy buildings you remember**: `knownBuildings(w, side)`, as last seen,
  with no health;
- **terrain you have explored** (`isExplored`), and the map's layout, which
  is public;
- **public information**: who holds each Uplink, supply drops, strike
  warnings and the clock.

Never the enemy's scrap, queues, orders or anything in the fog. A test
checks this (see *Testing*). In the game, the same events reach the screen
through filters (an enemy death shows only if it was in sight), and the
"since last round" list uses the same filters.

### Orders

`orders` takes the `Command` vocabulary from `src/sim/types.ts`, without the
`faction` (the runner adds it):

| Order | Example |
|---|---|
| Move, attack-move, attack, stop | `{ "move": [97, 83], "to": [30, 25] }`, `{ "attack": [97], "target": 23 }` |
| Harvest | `{ "harvest": [3, 14], "at": [14, 43] }` |
| Build a unit | `{ "produce": "flak-crawler" }` (at any building that makes it), or `{ "produce": "wasp", "at": 24 }` |
| Build a building | `{ "build": "sam-site" }` places it at the spot the game would suggest (`suggestPlacement`), or `{ "build": "sam-site", "at": [9, 42] }` |
| Cancel, sell, rally | `{ "cancel": "flak-crawler", "at": 10 }`, `{ "sell": 72 }`, `{ "rally": 10, "to": [12, 40] }` |
| Calldowns | `{ "calldown": "barrage", "at": [44, 9] }` |
| Condor | `{ "board": [91, 133], "condor": 103 }`, `{ "unload": [103], "at": [11, 11] }` |

Unit lists also take shortcuts: `"idle army"`, `"all stinger"`, `"army near
30,25"`. The same rules that grey out the HUD's buttons explain refusals
(`buildingBlocker` and `unitBlocker` in `src/sim/economy.ts`,
`placementBlocker` in `src/sim/placement.ts`): "Not enough scrap", "Needs a
Tech Lab", "Too far from your buildings".

## Who plays

### Models through their APIs (recommended)

The runner calls each provider's API with the six tools: Anthropic's tool
use, OpenAI's function calling, and an OpenAI-compatible adapter. That
adapter also covers local models served on the same machine, which makes the
whole battle work offline. Using plain `fetch`, rather than each provider's
SDK, keeps new dependencies out of the repo.

**The model gets only the game tools**: no shell and no files. So the fog
holds by construction, because the observation is the only way the model
learns anything about the game.

**Context.** Each round starts fresh. The system prompt (rules and tool
descriptions) and the briefing come first, and are cached. Then this round's
observation, your notes and last round's order results. Then a short tool
loop: look, orders, end_round. Keeping the whole conversation instead makes
the context grow every round, so the total cost grows with the square of the
number of rounds. The notes are the agent's memory, and they're part of what
is being tested. Keeping the last 2–3 rounds' exchanges is a middle option.

**Limits.** Each round has the same budget for both seats: for example 10
tool calls and a cap on output tokens. Nothing waits in real time, so a
provider's error, rate limit or overload is retried with backoff and doesn't
cost the round. A wall-clock limit (say 5 minutes) is only there to catch a
hung request. A seat that blows its budget plays the round with whatever
orders it had already given.

### Coding agents through a local MCP server

For agents like Claude Code or Codex, which bring their own harness. The
runner serves the same tools as an MCP server on loopback only, one URL per
seat with a secret token (`http://127.0.0.1:8790/mcp/<seat-token>`), using
the official MCP TypeScript SDK as a dev dependency. Each agent gets the URL
and a prompt like "You are blue. Call `briefing`, then play rounds until the
match ends." Any MCP client that speaks HTTP can play.

**The catch is the shell.** A coding agent on the same machine can read
files and run commands. It could read the runner's battle record, which has
both sides' orders, or the other seat's transcript. Two ways to close that:

| | |
|---|---|
| **Tools only** (recommended) | Start the agent with its built-in shell, file and web tools turned off, so it has only the arena's tools. Claude Code's tool settings can do this. A client that can't drop its own tools needs the sandbox instead (a read-only sandbox isn't enough, because reading files is the leak). It's then the same contest as the API seats, played through a different harness. |
| Sandboxed | Run each agent in its own container or OS user, with no access to the runner's output folder. Needed only if the agents are meant to have a shell (see *Bot battles* under *Later*). |

Even tools-only, a coding-agent match measures the harness as much as the
model. Each client has its own system prompt and its own way of managing
context and deciding when to stop. API seats are the controlled comparison,
and coding-agent seats are the fun one.

### The built-in AI

`ai:<personality>:<difficulty>`, for example `ai:rush:hard`: the game's own
commander, with 6 personalities and 3 difficulties. It's the baseline, and it
makes a cheap sparring partner while the tools are being tuned.

### Scripted seats

A seat that plays a fixed list of orders. It's for tests, so a whole arena
match can run in CI with no model and no network.

## Fairness

- The same system prompt, briefing, tool descriptions, round length and
  budgets for both seats, and no extra hints for either.
- **Mirror pairs**: `series` plays each seed twice with the sides swapped.
  The maps are mirror images and `tests/symmetry.test.ts` holds the rules to
  that, but swapping cancels what's left, and luck.
- Several maps, best of N. Mutators are off unless the series asks for them.
- Each seat's model id and settings (reasoning effort or thinking budget,
  temperature) are recorded with the match, and should be comparable.
- Each side's own frame (above), so neither model is always "the one at the
  top".
- Every prompt, tool call, result and token count is kept, so a match can be
  audited and the models' reasoning read.

## Battle records

A battle is a JSON file in `battles/`:

```jsonc
{
  "v": 1,
  "commit": "cddf6e2…", "sim": "3f9a…",       // the code that played it; sim = hash of src/sim/**
  "map": "riverlands", "mutators": [], "seed": 42, "round": 50,
  "openers": { "blue": "blitz", "red": "airwing" },
  "seats": {
    "blue": { "player": "anthropic:claude-opus-5-5", "settings": { /* … */ } },
    "red":  { "player": "openai:gpt-6-sol", "settings": { /* … */ } }
  },
  "frames": "own",                                // coordinates in transcripts
  "turns": [[0, "blue", [/* Command… */]], …],    // non-empty turns only, true coordinates
  "radio": [[350, "red", "Your harvesters are mine."], …],
  "hashes": [/* a world hash every 100 ticks */],
  "end": { "tick": 7012, "winner": "blue", "reason": "hq" },
  "usage": { "blue": { "input": 812000, "cached": 690000, "output": 143000 }, "red": { … } }
}
```

The prompts, tool calls and results go in a separate
`<battle>.transcript.jsonl`, because they're large (a few MB a side) and
the viewer doesn't need them. The record itself is small. The command log of
a 10-minute AI-vs-AI match was 144–181 KB as JSON, and 18–20 KB gzipped.

**Replaying needs the same sim code.** The sim changes often (37 of the
last 132 commits touched `src/sim`), so the record keeps its commit and a
hash of `src/sim`. `tools/arena.ts replay` and `watch` compare that hash with
the working tree's. If they differ, they make a `git worktree` at the
record's commit (cached in `.arena-builds/`) and run there. Old battles keep
working without any build archive.

## Watching

**The viewer** is the game's existing AI-vs-AI watch mode (the fog off by
default, up to 4× speed), fed by the record instead of the AI. It only
exists in dev builds: `npm run dev`, then `/?replay=battles/<file>.json`
(Vite's dev server serves files from the project root). `tools/arena.ts
watch` does this for you, in the right worktree. It adds:

- **Seeking.** Forward steps the sim with rendering off (a whole match in a
  few seconds). Backward uses keyframes taken every 30 s as it plays:
  `structuredClone(world)` copies the `Map`s and typed arrays.
- **"Through blue's eyes" / "through red's eyes"**: the fog on, as that
  side saw it. This needs the game's local side to be switchable. Today
  `PLAYER` is the constant `"blue"` in `src/game/controller.ts`, used about
  125 times. Making it `export let PLAYER` with a setter changes it
  everywhere at once, because ES module imports are live bindings.
- **The commanders' voices.** Each `radio` line appears in the ticker and
  is spoken by the announcer, so the two models can trash-talk. A side panel
  shows each side's orders and notes round by round, like a thought bubble.
- **A hash check as it plays.** If the replay drifts from the battle, it
  says "⚠ This replay diverged at 4:12" rather than showing something that
  didn't happen.
- The after-action report at the end (`src/game/chronicle.ts`), as after a
  normal match.

**Live**, on the same machine: the runner rewrites the record after every
round (to a temporary file, then a rename). `/?replay=…&follow` re-reads it
every second and plays each new round at 1× as it arrives. The action comes
in 5-second bursts, with "Blue is thinking… 0:23" in between. That's all on
localhost and needs no server beyond Vite's.

**Browsers.** The runner is Node, which uses the same JavaScript engine as
Chrome and Edge (V8), so replays should match exactly there, and the hash
check confirms it. Safari and Firefox may drift. ECMAScript lets each engine
round `Math.sin`, `cos`, `atan2`, `hypot` and `pow` in its own way, and the
sim calls them about 100 times. The fix is arithmetic-only versions in
`src/sim/fmath.ts`, plus a test that bans the originals in `src/sim`. It's
the same groundwork online multiplayer needs (MULTIPLAYER.md), and worth
doing for either.

**Video.** Later, `tools/arena.ts video <record>` can drive the viewer with
Playwright and record an MP4 for sharing.

## Cost

An agent gets at most 120 rounds in a 10-minute match. A round with a fresh
context costs about 5–10k input tokens, mostly cached (system prompt and
briefing), plus 0.5–2k output tokens. That's roughly **0.6–1.2M input and
60–240k output tokens per agent per match**: multiply by each model's
prices. `wait` and decided matches bring it down. The sim's own cost is
negligible.

Wall-clock time is 120 rounds × 10–60 s, so 20 minutes to 2 hours a match.
The runner spends nearly all of that waiting on APIs, so one process can run
several matches at once (`series --parallel 4`), within each provider's rate
limits.

## Also a balance tool

- **Agents against the built-in AI** calibrate difficulty, and show where
  the commander is easy to exploit.
- **Agents asked to find the strongest cheap strategy** are good at finding
  degenerate tactics the scripted AI never tries.
- `tools/arena.ts stats` reads records and reports what `tools/pacing.ts`
  reports for AI matches: per-minute army value, scrap, income, unit mix and
  Uplinks held. It adds results by model, side, map and opener, and the
  token use and cost per match.

## Code layout

| File | |
|---|---|
| `src/arena/observe.ts` | World and side → observation (text and structured). Pure, engine-free, tested |
| `src/arena/orders.ts` | Orders → `Command[]` with per-order results, and the frame conversion |
| `src/arena/record.ts` | The record format, world hashing, reading and writing |
| `tools/arena.ts` | The CLI: `run`, `series`, `replay`, `stats`, `watch` |
| `tools/arena/seats/*.ts` | `anthropic`, `openai` (and OpenAI-compatible), `mcp`, `ai`, `scripted` |
| `src/game/replay.ts`, `src/ui/replay.ts` | The dev-only viewer and its panel, loaded only when `import.meta.env.DEV` |

`src/arena` reads the sim and changes nothing in it. Only the dev-only viewer
imports it, so it never reaches the production bundle. Provider adapters live
under `tools/`.

## Testing

- **Fog leaks**: for worlds sampled from AI matches on every map, every
  enemy unit in an observation passes `unitSeenBy` for that side, every
  enemy building is in `knownBuildings`, and nothing else about the enemy is
  there (scrap, queues, orders).
- **Frames**: red's observation of a mirror-image world equals blue's,
  apart from ids. An order given in red's frame lands on the mirror-image
  tile.
- **Orders**: each shortcut maps to the right `Command`, and refusals carry
  the HUD's reasons.
- **A whole match with no model**: scripted seats, or built-in AI seats
  through the round loop, play a full match in `npm test`. The same seed and
  seats give the same record and the same hashes.
- **Adapters**: provider seats run against recorded API responses, so they
  can be tested without spending tokens.
- **Viewer**: a Playwright check plays a record in the dev viewer and
  checks the hash trail (Chromium).
- **Dark build**: the production build contains no viewer and no `replay`
  handling.

## Phases

1. **A headless arena with no model**: `observe`, `orders`, the record,
   rounds, frames, scripted and built-in AI seats, and the tests above.
2. **API seats**: Anthropic, OpenAI and OpenAI-compatible; budgets and
   retries; transcripts; `series` with mirror pairs; `stats`. The first
   model battles happen here, and can be read from the transcripts before
   there is a viewer.
3. **The dev viewer**: replay with seeking, the switchable side for
   "through X's eyes", the radio and notes panel, follow mode for live
   matches, and `watch` with worktrees for old records.
4. **Coding-agent seats**: the loopback MCP server, tools only.

## Later

- **Bot battles.** Instead of playing, each agent writes a commander: a
  TypeScript function from an observation to orders, like the built-in AI's
  `tickAi`. Run each bot in its own worker thread that only ever receives
  observations, so it can't reach the world. Then the arena can play
  hundreds of bot-versus-bot matches at full speed, in seconds each, with no
  model calls. That makes a real ladder, and the agents can iterate on their
  bots from the results. This is the contest where agents do get a shell, so
  it needs the sandbox.
- **Real-time matches**, as an option for the runner.
- **Agents against people, or across the internet.** That needs a server.
  MULTIPLAYER.md's Worker could host the same tools as remote MCP seats.
- **Video export**, and a gallery of showcase battles.
- **A results table** across models, if matches get run often enough to
  keep one.

## Open questions

1. Round length: 5 s, or longer (fewer rounds and cheaper, but coarser
   control)?
2. Which matchups and maps first, and how many games per pairing?
3. Text or JSON observations? Worth a few matches each way?
4. Coding agents: tools only, or also the bot-writing contest?
5. Should some showcase battle records be committed to the repo, or stay
   local?
6. Should results be published (a page of replays, a table)?
