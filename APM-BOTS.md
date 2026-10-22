# APM-capped bots

## Status

**Planned.** This builds on the `selectable-bots` branch: the bot registry
(`src/sim/ai/bots.ts`), `bot:` seats, `tools/arena.ts league`, and the menu's
Opponent and Watch AI vs AI pickers. **[BOTS.md](BOTS.md)** is the guide to
writing a bot. Read it first.

## The idea

Scale a bot's difficulty by capping its **actions per minute** (APM), the
way a human is limited. That's a different knob from what difficulty does
today. Then pit a bot built for a budget, capped at 100 APM, against the
uncapped stock commanders.

**Every bot stays fair.** A cap only limits how many orders a bot gives.
It never touches income or what the bot can see (BOTS.md, "The rules").

## What we know

### Difficulty today sets how often a bot thinks, not how much it does

The commander (`src/sim/ai/commander.ts`) runs a planning pass every
`DIFFICULTY[d].interval` seconds: 3.5 on Easy, 2 on Normal, 1.2 on Hard.
Each pass can return any number of commands, and its calldown-dodge reflex
runs every tick on top. Nothing caps actions. One `Command` counts as one
action here, even when it moves 30 units.

Measured over 10-minute matches on Riverlands, seed 3:

| Bot | Avg APM | Peak minute | Most of it |
|---|---|---|---|
| `bot:balanced:easy` | 96 | 145 | attackMove, attack, produce |
| `bot:balanced:hard` | 65 | 154 | attackMove, produce, attack |
| `bot:ironclad` | 125 | 235 | attackMove (811 in 9 min) |
| `bot:rush`, `bot:decent` | 28, 23 | 35, 26 | (a 2-minute game) |
| `bot:novice` | 16 | 26 | produce, attackMove |

Easy sent more actions than Hard. Most of a commander's actions re-send
`attackMove` to units that already have orders.

### Thinking more often is cheap

One commander pass costs about 0.4 ms on Riverlands and 1.5 ms on
Archipelago (Node, this machine). One sim step costs 0.4 to 0.75 ms. A bot
that thinks every tick roughly doubles the CPU of a match. That's fine for
the arena and the league, but worth watching on a phone at 4× spectator
speed. BOTS.md's advice to "think about once a second" was a CPU
guideline, not a rule, and this tells us its real cost.

### A capped version of today's commander is not a viable opponent

Each variant played the stock commander (Normal, a pass every 2 s, no cap)
48 times: Balanced and Ironclad, on Riverlands, Frostbite, Dune Sea and
Archipelago, seeds 1 to 3, both sides. Each variant played the same
personality as its opponent. "Turbo" means a pass every tick.

The cap was a token bucket: it refills at `apm / 600` per tick and holds at
most 10, so short bursts are allowed. Each tick it kept the first commands
the bucket could pay for and **dropped** the rest.

| Variant | Won-lost-drawn | Win % | APM sent | APM it tried to send |
|---|---|---|---|---|
| Turbo, uncapped | 17-31-0 | 35% | 162 | 162 |
| Turbo, capped at 100 APM | 11-36-1 | 23% | 78 | 2,472 |
| Turbo, capped at 60 APM | 10-32-6 | 21% | 55 | 7,346 |
| Stock, capped at 100 APM | 15-24-9 | 31% | 79 | 277 |
| Stock, capped at 60 APM | 9-21-18 | 19% | 54 | 464 |

What this shows:

- **Thinking every tick makes the commander worse**, even uncapped. A
  likely cause, not checked yet: re-planning every tick re-sends
  `attackMove` to units already fighting, which resets their paths and
  targets, and its gather-then-launch waves flip-flop.
- **Dropped commands pile up.** The commander assumes every command it
  sent went through. A dropped order leaves its units idle, so the bot
  re-sends it next time, and that gets dropped too. Capped, it tries to
  send thousands of actions a minute, and what gets through is mostly
  repeats.
- **The draws at 60 APM** are capped bots that stall without losing their
  base.
- **The baseline isn't measured.** Stock against stock in the same setup
  should be close to 50%, but it hasn't been run. Run it first, so the
  numbers above have something to compare to.

The experiment was a throwaway script. Step 1 below makes it repeatable.

## The plan

### 1. An APM cap as a seat option

- **Seat syntax:** `bot:<id>[:<difficulty>]@apm=<n>`, for example
  `bot:ironclad:hard@apm=100` or `bot:decent@apm=40`. Changes:
  - `parseSeat` and `seatName` in `src/arena/match.ts`;
  - `SeatSpec` gains `apm?: number`;
  - `botSeat` in `bots.ts` keeps the `@apm=` in the record's seat name;
  - the `llm` plugin's `is_builtin` already accepts anything starting with
    `bot:`. Check that `@` survives its command line and the record file
    name (`tools/arena/files.ts recordPath`).
- **The cap is a wrapper around any `Bot`**, in `src/sim/ai/bots.ts` or a
  new `src/sim/ai/apm.ts`. `capApm(bot, apm, burst = 10): Bot` is a token
  bucket like the experiment's. It keeps the first commands it can pay for
  and drops the rest. It must be deterministic: plain arithmetic on ticks,
  no clocks.
- **Every command counts as one action**, including commands the sim then
  refuses (unaffordable, blocked). A human pays for a wrong click too.
- **Tell the bot what got through.** Add an optional
  `Bot.sent?(cmds: Command[]): void`, which the wrapper calls with the
  commands it let through. Budget-aware bots use it; others ignore it.
- **Measure APM.** Add `tools/arena.ts apm <records…>`: average, peak
  minute, and the command mix per seat. The league should print each
  seat's APM next to its win rate.
- **Baseline:** stock against stock in the same 48-game setup.
- **Tests,** in `tests/bots.test.ts`:
  - a capped bot never goes over its budget, burst included, in any
    window;
  - the same match twice gives the same commands;
  - `parseSeat` and `seatName` round-trip with `@apm=`.

### 2. A bot built for a budget

A new bot, say `bot:marshal`, written for a cap from the start. Begin from
the commander's plan (build orders, counters, waves: `commander.ts` and its
helpers under `src/sim/ai/`), but restructure how it gives orders:

- **Each pass makes a ranked list of wants, not a list of commands.** Spend
  the budget from the top:
  1. emergencies: base under attack, dodging calldowns;
  2. the economy: harvesters, placing a finished building;
  3. production: keep queues full, start the next building;
  4. army orders: waves, raids, retreats;
  5. tidying: rallies, stragglers.
- **Memory:** it remembers what each unit was last told, and never
  re-orders a unit that is already doing it (same target, or a destination
  within a tile or two). Re-sent orders are where today's commanders spend
  most of their APM.
- **One command for many units.** Group the units going the same way into
  one `attackMove`.
- **Think often, act rarely.** It can plan every few ticks, because
  planning is cheap. It only gives an order when the order would change
  something.
- **Spend on scrap you have.** It only plans with scrap it has actually
  spent, through `sent()`, not with what it hoped to spend.
- **Difficulties:** it should take `easy|normal|hard`. Those can set the
  default cap, for example 40, 80 and 150, plus the commander's existing
  knobs. An explicit `@apm=` overrides the default.

### 3. The head-to-head

- `bot:marshal@apm=100` against each stock commander, uncapped, in mirror
  pairs on every map with several seeds. Use
  `tools/arena.ts league --bots …`, so the matches play in the real arena
  and leave records you can watch.
- Then sweep the cap: 40, 60, 80, 100, 150, uncapped. That gives a curve
  of win rate against APM, and shows which cap to use for which
  difficulty.
- **Success:** at 100 APM or less, marshal wins at least 50% against the
  stock Normal commanders, while sending fewer actions than they do.

### 4. In the game

- **An APM choice in the pickers** (Opponent and both Watch AI vs AI):
  probably "Unlimited / 150 / 100 / 60 / 40". Saved like the bot picks
  (`gameMode.opponent` and `gameMode.watch` in `src/game/mode.ts`).
  `opponentBot` and `watchBot` in `src/game/meta.ts` wrap the bot with
  `capApm`. The "vs" line shows the cap: "vs Marshal bot · 100 APM".
- **Today Watch AI vs AI always plays bots at Normal.** The same change
  could add a difficulty choice there.
- **BOTS.md:** a section on writing a bot for a budget (wants, memory,
  `sent()`), and the reason the cap drops commands rather than queueing
  them.

## Open questions

- **Drop or queue over-budget commands?** The plan says drop, because a
  queued order goes stale while it waits. Confirm it with marshal: does
  queueing ever do better?
- **Does a command for 30 units count as one action?** A human needs a
  box-select and a click for that, about two actions. The plan counts 1,
  for simplicity. Revisit it if mass orders turn out to dominate.
- **Should the calldown-dodge reflex count against the cap?** The plan
  says yes, every command counts. Mention it if that makes capped bots
  stand in reticles.
- **Is uncapped turbo bad because of the re-sent orders, or for another
  reason?** Worth a quick look while building marshal, because the same
  flaw would hurt it.

## Where things are

| | |
|---|---|
| `src/sim/ai/bots.ts` | The bot registry: `Bot`, `BotDef`, `ALL`, `botSeat` |
| `src/sim/ai/commander.ts` | The stock commander: `tickAi`, `DIFFICULTY`, `STRATEGIES` |
| `src/sim/ai/player.ts` | The scripted players |
| `src/arena/match.ts` | `parseSeat`, `seatName`, bot seats ticking every tick |
| `tools/arena.ts` | `run`, `series`, `league`, `bots` |
| `src/game/meta.ts` | `watchBot`, `opponentBot`, `opponentPicked` |
| `src/main.ts`, `src/ui/style.css` | The menu's pickers (`watchOptions`, `#opponent`, `#watchrow`) |
| `tests/bots.test.ts` | Covers every registered bot automatically |
| `BOTS.md` | How to write a bot |

## Kicking it off

In a fresh session on the `selectable-bots` branch:

> Read APM-BOTS.md and BOTS.md, then do step 1 of APM-BOTS.md: the
> `@apm=` seat option and `capApm` wrapper, `tools/arena.ts apm`, APM in
> the league table, the tests, and the stock-vs-stock baseline. Stop and
> report before starting step 2.
