# APM-capped bots

## Status

**Steps 1 and 2 are done; 3 is mostly answered; 4 is next.** This builds on
the `selectable-bots` branch: the bot registry (`src/sim/ai/bots.ts`), `bot:`
seats, `tools/arena.ts league`, and the menu's Opponent and Watch AI vs AI
pickers. **[BOTS.md](BOTS.md)** is the guide to writing a bot. Read it first.

- Step 1: `bot:<id>[:<difficulty>]@apm=<n>` seats, `capApm`
  (`src/sim/ai/apm.ts`), `Bot.sent`, `tools/arena.ts apm`, APM in the league
  and series tables.
- Step 2: `bot:marshal` (`src/sim/ai/marshal.ts`). **At 13 APM it plays the
  stock Normal commander, at 60–100 APM, about even; at 16 APM and up it wins
  83–100%.** See "What Marshal showed" below.

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
- **The baseline:** stock against stock in the same setup is 50% by
  construction (a bot's seed follows its side, so the swapped game is the
  same game). What it does show: 17% draws (so the capped bots' 38% at 60
  APM is the cap's doing), about 105 APM with busiest minutes near 300, and
  two thirds of it `attackMove` and `attack` re-sends.

The experiment was a throwaway script. Step 1 below makes it repeatable.

## The plan

### 1. An APM cap as a seat option (done)

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

### 2. A bot built for a budget (done)

A new bot, `bot:marshal`, written for a cap from the start. Begin from
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

### 3. The head-to-head (mostly answered: "What Marshal showed")

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

## What Marshal showed

Marshal (`bot:marshal`) is the stock commander's plan (Balanced) with new
hands. Every number below is Marshal against the stock Normal commander
(uncapped, Balanced unless named), on all six maps, seeds 1 to 3, both sides:
36 games, so about ±8 points of noise.

### The win-rate curve against APM

| Marshal's cap | 10 | 13 | 16 | 20 | 30 | 40 | 60 | 100 |
|---|---|---|---|---|---|---|---|---|
| Wins | 11% | 56% | 83% | 86% | 89% | 92% | 94% | 100% |

The stock commander sent 70 to 100 APM in these games. At 40 APM Marshal
also beat the other five personalities: Rush 86%, Air Swarm 89%, Boom 78%,
Skyforce 83%, Ironclad 83%. Against the scripted `decent` player it won 33%
at 10 APM and 78% at 20.

The difficulties (`MARSHAL` in marshal.ts) are Easy 10 APM, Normal 14 and
Hard 30, with Easy also thinking slower (a plan every 3.5 s, a look at the
fights every 2 s) and Hard faster (1 s and 0.5 s). **They're a first guess:
Normal is meant to feel like the stock Normal commander.** A league through
the real arena, all maps, seeds 1 and 2, 24 games a pairing:

| | Won-lost-drawn | Win % | APM |
|---|---|---|---|
| `bot:marshal:hard` | 86-8-2 | 90% | 30 |
| `bot:marshal:normal` | 52-36-8 | 54% | 15 |
| `bot:ironclad` (stock Normal) | 43-40-13 | 45% | 110 |
| `bot:balanced` (stock Normal) | 37-54-5 | 39% | 97 |
| `bot:marshal:easy` | 5-85-6 | 5% | 11 |

Marshal Normal beat stock Balanced 18-5 and stock Ironclad 10-8. Easy sits
just under the curve's cliff (10 to 13 APM) and loses almost every game to
the stock Normal commanders; whether that's right for an Easy opponent is a
question for play, not the league.

### What made the difference

Measured one at a time (24 to 36 games each):

- **Dropping orders that change nothing.** With only that, and no fight
  micro, it beat stock Balanced 15-7-2 at slightly lower APM. Two thirds of
  the stock commander's actions re-send `attackMove` to units already doing
  it. **This is also why thinking every tick hurt the stock commander:**
  with the re-sends dropped, Marshal plans every 0.5 s with no harm.
- **Fight micro is the big one.** Re-planning each fight every second took
  uncapped Marshal from 62% to 96–100%. Focus fire alone or breaking off
  alone each got 92%; sending units back to their wave after a kill added
  nothing (removed).
- **Orders wait for an action instead of being dropped.** The first version
  made fight micro fresh on each look and threw away whatever the cap
  refused. The plan's orders, which waited, took every action as it came, so
  focus fire got about 1 action a minute. Letting micro orders wait until
  the next look took 50 APM from 58% to 81%, and 40 APM from 58% to 72%.
- **Under a cap, thinking faster helps.** At 40 APM, looking at the fights
  every 0.5 s instead of every 1 s took it from 72% to 89%. Uncapped, think
  speed hardly mattered. So both levers work: act faster mostly; think
  faster once actions are scarce.
- **Finishing a won game.** At 30 APM a quarter of its games were draws it
  was winning, 77 units against 5 at 19:00. A push that sends everything at
  the nearest known enemy building once its army is twice what it has seen
  of theirs took 30 APM from 69% to 89% and shortened games from 14 to 9
  minutes. The push order has to wait for an action too: tried only on the
  tick it was planned, it rarely got one.
- **Menders follow loosely.** The commander re-sent Menders after the units
  they followed, 7 to 15 times a minute. Marshal leaves a Mender alone
  within 4 tiles of where it's wanted.
- **Switching targets only for a much better one** (3×, not 1.5×). Each
  switch costs an action, and another when the target dies.

Tried and dropped: rally points at the staging area (no change: few orders
are for new units); more harvesters and depots (no clear change); production,
army and focus taking turns at the budget (worse: 56% at 30 APM against 89%);
group orders outranking production (much worse); breaking off only when
reinforcements are outmatched too (worse: retreating early is right); focus
fire outranking production, and no harassment raids (no clear change).

### A separate budget for fight micro

`MarshalOptions.microApm` caps the actions fight micro may spend (breaking
off, stepping back, focus fire), apart from the seat's cap. At 60 APM with 10
of them for micro it won 62%, with 20 88%, uncapped micro 79%: it's a knob
for how sharp it is in a fight, not a way to play better on the same total.
No seat syntax or picker sets it yet.

## Open questions

- **Drop or queue over-budget commands?** Answered for Marshal: the cap
  still drops, but Marshal keeps its own refused orders until a newer plan
  replaces them (the plan's every `think`, the fight micro's every `react`).
  That beat dropping by a lot (above).
- **Does a command for 30 units count as one action?** A human needs a
  box-select and a click for that, about two actions. The plan counts 1,
  for simplicity. Revisit it if mass orders turn out to dominate.
- **Should the calldown-dodge reflex count against the cap?** The plan
  says yes, every command counts. Mention it if that makes capped bots
  stand in reticles.
- **Is uncapped turbo bad because of the re-sent orders, or for another
  reason?** The re-sent orders: once they're dropped, planning every 0.5 s
  does no harm.
- **Does Marshal's Normal (14 APM) feel right to a person?** Only play will
  tell. The scripted players are the closest stand-in measured so far.

## Where things are

| | |
|---|---|
| `src/sim/ai/bots.ts` | The bot registry: `Bot` (and `sent`), `BotDef` (and its default `apm`), `ALL`, `botSeat` |
| `src/sim/ai/apm.ts` | `capApm`, the token bucket |
| `src/sim/ai/marshal.ts` | Marshal, and `MARSHAL`: each difficulty's speeds and cap |
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

> Read APM-BOTS.md and BOTS.md, then do step 4 of APM-BOTS.md: an APM choice
> in the Opponent and Watch AI vs AI pickers, saved like the bot picks, and
> the cap in the "vs" line. Marshal already wears its difficulty's cap in the
> game (`seatBot` in `src/game/meta.ts`); the choice should override it.
