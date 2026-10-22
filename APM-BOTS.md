# APM-capped bots

## Status

**Steps 1 and 2 are done; 3 is mostly answered; 4 is half done: the
menu's difficulty is now Marshal (below), the APM choice in the pickers is
next.** This builds on
the `selectable-bots` branch: the bot registry (`src/sim/ai/bots.ts`), `bot:`
seats, `tools/arena.ts league`, and the menu's Opponent and Watch AI vs AI
pickers. **[BOTS.md](BOTS.md)** is the guide to writing a bot. Read it first.

- Step 1: `bot:<id>[:<difficulty>]@apm=<n>` seats, `capApm`
  (`src/sim/ai/apm.ts`), `Bot.sent`, `tools/arena.ts apm`, APM in the league
  and series tables.
- Step 2: `bot:marshal` (`src/sim/ai/marshal.ts`). **At 13 APM it plays the
  stock Normal commander, at 60–100 APM, about even; at 16 APM and up it wins
  83–100%.** See "What Marshal showed" below.
- Since: **Marshal draws a game plan** (seven, including Turtle and Greed),
  **each difficulty is one slider for both its base and its fight micro**,
  and **the menu's Easy/Normal/Hard with 🎲 Random AI is Marshal**, fair,
  in place of the stock commander with its income handicap. See "Plans,
  difficulties and the menu" below.

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

- **Done:** the menu's difficulty (🎲 Random AI, and the Daily Op) plays
  Marshal at that difficulty (`difficultyBot` in `src/game/meta.ts`).
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

The first difficulties were Easy 10 APM, Normal 14 and Hard 30, with Easy
also thinking slower (a plan every 3.5 s, a look at the fights every 2 s)
and Hard faster (1 s and 0.5 s); "Plans, difficulties and the menu" has
today's. A league of those through the real arena, all maps, seeds 1 and 2,
24 games a pairing, Balanced plan only:

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
Each difficulty now sets it (below); no seat syntax sets it.

Over a whole game fight micro spends little: about 1 action a minute on
Easy, 1.5 on Normal, 6 on Hard (fights are short). Inside a fight it's held
to the seat's cap, so its pace there is the difficulty's.

## Plans, difficulties and the menu

### Plans

Marshal draws a game plan for each game from its seed (`MARSHAL_PLANS`,
`MARSHAL_POOL` and `marshalPlan` in marshal.ts): the six stock
personalities, and two of its own, each built on a stock one (`base`: its
opener, and the tables keyed by personality in goliath.ts and airlift.ts).
A bot that picks its own opener says so in `Bot.opener`; the arena and the
game take it over its `BotDef.opener`. `Bot.plan` names the plan.

- **Turtle** (on Ironclad): a turret, the Tech Lab, a depot, a SAM site,
  another turret, a second Fab Plant, a radar; five harvesters; no raids;
  one push at 3000 scrap of army. The first try (five towers, a radar, the
  usual four harvesters) won 33%: towers cost actions as well as scrap, and
  it mined half what its enemy did while 2000 scrap sat unspent.
- **Greed** (on Boom): two depots right after the Fab Plant, six
  harvesters (plus one a depot), no raids, a push at 2400. 78%; with a
  turret and the Tech Lab between the depots, 56%.

Each plan at 14 APM against stock Balanced (36 games each): Rush 89%, Boom
83%, Air Swarm 81%, Greed 78%, Turtle 72%, Balanced 67%, Ironclad 42%,
Skyforce 28%. At Hard against stock Hard (below): Greed 69%, Turtle 61%,
Boom 50%, Rush and Air Swarm 44%, Balanced and Ironclad 36%.

The pools: Skyforce is in none (an all-air plan needs more hands than this
budget); Easy draws Balanced, Boom, Turtle and Greed (no Rush: a beginner
gets a few minutes' peace); Normal and Hard draw the other seven. With
mutators on, the game draws only plans the rules allow (`strategyFits`);
the Daily Op plays its personality as a plan.

### Spending and mining (`MARSHAL_ECONOMY`)

Under 14 APM Marshal banked scrap: 1800 on average against the stock
commander's 430, and mined less (1960 a minute against 2240). Every unit is
an action, and it managed about 7.5 produce orders a minute whatever else
changed, so **spending more means buying more with each order**. Every plan
now adds two commander options (`Strategy` in commander.ts; the stock
personalities leave them off):

- **`spendDown`**: past 600 scrap, queues a slot deeper per 400 banked (up
  to 4), picks the dear unit of each choice (Mastodons and Lancers, Hornets),
  and adds factories past 600 instead of 1000, up to five (`SPEND`).
- **`depotReach: 5`**: a field 5 tiles from a drop-off (not 9) gets a depot
  by it, and one more is wanted, early in the order, while there's a field
  for it, up to four. The first depot goes by the main field (hauls of 2
  tiles, not 10), and the next where the harvesters move once it runs dry.

Against stock Balanced at Normal (60 games each): no change 67%, spending
down 83%, both 85%, mining 2530 a minute. Banking was 1400 with spending
down alone and 2800 with both: the extra income outruns 14 actions a minute.
At Hard (30 APM) it banks 670, the same as stock Hard. Tried and dropped:
always the dearest unit (no better), idle factories' orders before deeper
queues and Rocket Squads from a rich Bay (no change), a Goliath every 60 s
while rich (no change: games end before it matters).

### Difficulties: one slider

**Superseded by "Retuning the levels" below** (10 / 30 / 120 APM). What
follows is the first tuning, kept for its numbers.

`MARSHAL` in marshal.ts. Each difficulty sets how fast it thinks and acts,
and fight micro's share of the actions, at a human's pace for the level:

| | Plan every | Fights every | APM | Of which fight micro |
|---|---|---|---|---|
| Easy | 4 s | 3 s | 7 | 3 |
| Normal | 2 s | 1 s | 14 | 6 |
| Hard | 1 s | 0.5 s | 30 | 20 |

They're set against what the menu used to play, the stock commander at the
same difficulty **with its income handicap** (0.75× and a harvester fewer
on Easy, 1.3× and one more on Hard). Marshal is fair; 36 games each, plans
drawn:

| | Against stock, same difficulty | Notes |
|---|---|---|
| Easy | 70% of 60 (72% of 36 before `MARSHAL_ECONOMY`) | 8 APM: 92%; 6 APM, a plan every 5 s: 33%; 5 APM: 11% |
| Normal | 73% of 60 (61% of 36 before) | uncapped micro 58%, 5 or 8 for micro 69% |
| Hard | 43% of 60 (49% of 252, plans forced, before) | uncapped micro 53%, 15 for micro 36% |

Easy is a steep cliff between 5 and 8 APM. Neither Marshal Easy nor stock
Easy wins against the scripted novice or beginner players (1 in 36, 5 in
36): those are efficient low-APM turtles, so they don't separate Easy
candidates. Stock and Marshal Normal both beat the novice about 2 games in 3.

The plan drawn follows the bot's seed, so a batch with few seeds draws few
plans (six seeds drew Ironclad in half of Hard's games). Force a plan to
compare plans.

### The menu

With 🎲 Random AI as the opponent, Easy/Normal/Hard plays Marshal at that
difficulty (`difficultyBot` in `src/game/meta.ts`): fair, capped, a plan
drawn as above. It keeps the career ladder (stars, XP, tips) and the "vs
Turtle AI (Normal)" line. The record names the seat `bot:marshal:<difficulty>`.
Ops keep their scripted commanders, and Watch AI vs AI's 🎲 still plays
stock Normal commanders.

## Real time

The bots are cheap: Marshal thinks for about 0.1% of real time (60–90 ms
per game minute) and the stock commander about the same. What slowed games
was the simulation, in three places, now capped (96 games, 6 maps, before →
after, the worst tick of each game):

- **An attack on a building no path reaches.** Stock Hard's army attacked
  Marshal's Airpad and Gantry in a corner, boxed in by buildings and the
  map's edge: every attacker searched the whole map, failed, and searched
  again the next tick (2 ms each, 13000 a minute; one game took minutes per
  game minute). An attacker with no path now gives the target up.
- **Mass orders.** 75 units told to attack-move at once searched 75 paths
  in one tick: 40 to 60 ms. Each side may now search `PATH_TILES_PER_TICK`
  (6000) tiles a tick (A* expansions: a count, so every phone plays the
  same match); the rest keep to the path they have, or wait a tick. A unit
  on the same tile as one that just searched, going to the same tile, takes
  a copy of that path, exactly what its own search would find (copies from
  a tile or two off broke the mirror-symmetry test). The last of a big
  army sets off up to a second later; balance didn't move (stock Balanced
  vs Ironclad and Marshal vs stock Hard, 36 games each, the same within
  noise).
- **Mined-out fields.** With the near fields gone, a dozen harvesters (and
  the commander's search for their next field) each searched the whole map
  in one tick and found nothing: 10 to 30 ms. A search in vain now marks
  the ground it covered, and a search from anywhere on it this pass doesn't
  search again (`nearestReachableResource`'s `misses`).

The worst simulation tick of a game is now 8.6 ms at the median, 12 at the
90th percentile, 15 at most (it was 12 to 58 ms, and once minutes). The
worst bot tick is the first think (6 to 16 ms, the code still warming up);
after that, under 9 ms.

## Higher caps: 35 / 65 / 115

Asked for: Easy 35 APM, Normal 65, Hard 115, each difficulty's speeds
otherwise as in `MARSHAL`. Against the stock commander at the same
difficulty (income handicap and all), 60 games each:

| | Fight micro as now (3/6/20) | Fight micro scaled up | APM it used |
|---|---|---|---|
| Easy 35 | 93% (56-0-4) | 92% (15 for micro) | 31 |
| Normal 65 | 82% | 98% (28) | 56 |
| Hard 115 | 65% | 90% (unlimited) | 90–95 |

- **Every level beats its stock counterpart, most by far.** Easy at 35
  beats stock Normal 83% and stock Hard 61% (36 games each): far too strong
  for an Easy. The current Normal (14 APM) wins 4 games in 36 against it.
- **Above about 35, APM stops separating the levels.** Marshal used only
  31 of Easy's 35 and 56 of Normal's 65 (it tried 1000+, nearly all
  replans of what it was already doing). Easy at 35 against Normal at 65:
  20-16. Hard at 115 beat Normal at 65 30-5: its faster thinking and its
  bigger micro budget, more than its APM.
- **The plan drawn matters more than the level here.** Normal at 65
  against stock Hard by plan, 36 games each: Greed 69%, Rush 61%, Turtle
  58%, Boom 42%, Ironclad 39%, Air Swarm 36%, Balanced 22%.
- **Against the scripted players**, Easy at 35 beat the novice 69%, the
  beginner 44%, the decent player 75%.
- **Spending:** at these caps it banks 500–750 scrap, like the stock
  commander, and mines 2700–3200 a minute.

So caps that high make Marshal a strong opponent at every level; if the
levels should feel different, think speed, the micro budget and the plan
pool are the levers that still bite up there.

## Retuning the levels: 10 / 30 / 120

Asked for: Easy gentler (less APM if need be, less aggressive plans);
Normal varied, with Rush less overpowering; Hard as strong as it can be,
but not from fight micro faster than a person's, about 2 orders a second
at most. Tested with a scratch harness (one process per game, all five
maps, mirror pairs).

### Fight micro at a human's pace

Fight micro (`MICRO_BURST`) now banks **one** order: one fight order at a
time, at most one every `60 / microApm` seconds. Hard's 120 is one every
half second. At 115 APM against stock Hard, 40 games each: micro held to
2 a second won 90%, unlimited micro 88% (it peaked at 5 to 6 a second),
and head to head the human-paced one won 19-16-5. Micro speed was never
where Hard's strength came from. Over a game Hard gives 25 to 35 fight
orders a minute.

### The plans: the economy wins, not the rush

A round robin of every plan against every other at 50 APM (8 plans, 1120
games):

| | Greed | Rush | Turtle | Ironclad | Air Swarm | Boom | Balanced | Skyforce |
|---|---|---|---|---|---|---|---|---|
| Against the field | 73% | 66% | 51% | 49% | 47% | 45% | 42% | 27% |

Then each change against all seven plans (140 games each):

- **Rush's strength isn't its timing.** Waves at 1800 instead of 1400, or
  raids in packs of 8, made it *stronger* (58% → 63–68%): it's the army
  mix and the second factory. With one factory and a depot: 41%.
- **Greed's strength is its early depot.** Without the second harvester it
  still won 64–70%. The same depot, right after the first factory, with a
  fifth harvester (`fastDepot`), took Balanced from 42% to 63% and Boom from
  43% to 59%.

So rather than nerf Rush, every other plan got stronger: each has a
**fast-expanding version** (`MARSHAL_PLANS[…].fast`), which Normal and
Hard play. Rush and Greed have none. A round robin with them (1120 games):
Greed 62%, Air Swarm 61%, Balanced 56%, Ironclad 54%, Rush 40%, Turtle 40%,
Boom 36%. That's 36–62% where it was 27–73%, and Rush drops from second to
near the bottom, level with Turtle.

### Easy: only APM makes it easier

Against the stock Easy commander (0.75× income), every Easy variant won
92–98%: 20 APM; 20 with three harvesters, no economy tricks and no fight
micro; 12 APM. Stock Easy is too weak to measure against, so Easy is
tuned against the scripted novice and beginner players instead.

- **Peace makes it stronger, not weaker.** No attacks before 5 or 6 minutes
  (`Strategy.holdUntil`, new) took Easy at 20 APM to 98–100% against the
  scripted players: it attacks later with a bigger army. Easy keeps
  5 minutes of peace anyway, for the player's sake.
- **A cliff between 10 and 12 APM.** With 5 minutes of peace: 12 APM beat
  the novice 85% and the beginner 62%; 10 APM 42% and 35%.
- Easy plays the slow plans (Balanced, Boom, Turtle), not the fast ones,
  and not Greed.

### Hard: think a little slower

At 115 APM, a plan every 1.5 s beat a plan every second 69% (27-12-1), every
2 s 52%, every half second lost 79%. Replanning too often re-sends orders,
and each costs an action. A 60 APM cap lost 39 of 40 to 115, and 150 beat
115 58% (noise), so 120 it is. Hard plays the four strongest plans
(Balanced, Air Swarm and Ironclad fast, and Greed).

### Where the levels landed

`MARSHAL` in marshal.ts; 60 games each, all five maps, seeds 1 to 6:

| | Think / fights | APM / micro | Plans | Peace |
|---|---|---|---|---|
| Easy | 4 s / 3 s | 10 / 3 | Balanced, Boom, Turtle | 5 min |
| Normal | 2 s / 1 s | 30 / 20 | all but Skyforce, fast | none |
| Hard | 1.5 s / 0.5 s | 120 / 120 | Balanced, Air Swarm, Ironclad, Greed, fast | none |

| | Novice | Beginner | Decent | Stock Easy | Stock Normal | Stock Hard | Next level down |
|---|---|---|---|---|---|---|---|
| Easy | 43% | 37% | 40% | 92% | 30% | | |
| Normal | | | 92% | | 83% | 63% | 100% (Easy) |
| Hard | | | | | | 92% | 99% (Normal) |

The step from Easy to Normal is steep: Normal won all 60 games against
Easy. Normal at 50 APM beat Normal at 30 72% (Hard beat it 98%), so APM is
still the knob for anything between.

## Hard, harder

A player beat Hard in 5:24, mining 26,556 scrap to its 15,000, with an army
that peaked far higher. Asked for: Hard much harder, never over 120 actions
in any minute, and a little better at fighting. Each change below was tested
head to head against Hard as it stood (40 games, all five maps), and kept
if it won.

| Change | Won |
|---|---|
| 12 harvesters, not 5 (plus one per depot): mines 15–30% more on the open maps | 72% |
| The cap at 115 a minute with a burst of 5, so no minute exceeds 120 (was 120 + 10: busiest minute 129) | 36% (the cost) |
| Breaking off a lost fight at under half the enemy's strength, not under 0.3 | 60% |
| Waves at 2500 scrap of army | 59% |
| Factories as soon as scrap piles up, ahead of the rest of the build order (`Strategy.expandEarly`, new) | 66% |
| A broken-off fight stays out of the waves 20 s, not 8 | 60% |
| A plan every 2 s, not 1.5 (fewer replans, more actions for the rest) | 71% |
| Focus fire switches to a target twice as good, not 3× | 58% of 100 |

Tried, no better: 15 or 18 harvesters (16–18 harvesters is where it tops out
anyway); more factories or deeper queues (`Strategy.spend`, new); holding
waves while the enemy army seen is bigger; a plan every 1.2, 2.5 or 3 s;
looks at the fights every 0.3 s or 1 s (both lost 71%); less fight micro (90
or 60 a minute: lost); stepping back hurt units more or less readily.

Together (`MARSHAL.hard`'s `tweak` and `fight`), 60 games each: against the
old Hard 63% (37-21-2), stock Hard 90%, Normal 100%. By map against the old
Hard: Ashlands 11 of 12, Dune Sea 9, Frostbite 8, Riverlands 7,
**Archipelago 2**. Archipelago needs actions more than anything (the island
airlift): there the old Hard sent 100 a minute, and with the cap at 120 + 10
the new one won 12 of 20; under the strict 120 it wins about a third.

Its busiest minute is now 119 actions; fight orders are at most one every
half second. (This level is now Brutal: see "Five levels".)

## Five levels

Easy · Casual · Normal · Hard · Brutal (`Difficulty` in commander.ts). Brutal
is "Hard, harder" above; Hard is the Hard before it, at 80 actions a minute;
Casual is new, between Easy and Normal. Saved settings keep their names, so
a saved "hard" is now the old Hard. The stock commander gets Casual and Brutal too
(Casual: a plan every 2.75 s, 0.875× income; Brutal: plays as Hard, 1.5×
income and two more harvesters), and so do the tables keyed by difficulty
(the airlift, Goliaths, calldowns, Last Stand's waves, career XP).

| | Plan / fights | APM / micro | Plans | Peace |
|---|---|---|---|---|
| Easy | 4 s / 3 s | 10 / 3 | Balanced, Boom, Turtle | 5 min |
| Casual | 3 s / 2 s | 18 / 8 | Balanced, Boom, Turtle, Air Swarm | 3 min |
| Normal | 2 s / 1 s | 30 / 20 | all but Skyforce, fast | none |
| Hard | 1.5 s / 0.5 s | 80 / 60 | Balanced, Air Swarm, Ironclad, Greed, fast | none |
| Brutal | 2 s / 0.5 s | 115 + 5 / 120 | the same, 12 harvesters, early factories, waves at 2500 | none |

60 games each, all five maps: Casual beat Easy 98%, Normal beat Casual 92%,
Hard beat Normal 99%, Brutal beat Hard 87%. Against stock Hard (1.3×
income): Hard 92%, Brutal 91%. Casual beat the scripted beginner 74%. Hard
at 120 actions (its old cap) beat Normal 99% and lost only 39% to Brutal; at
60, Brutal beat it 96%.

**A bug in the fight micro's budget, found here.** Its bank held exactly one
action. With a look every 0.5 s, a budget of 115 a minute refills 0.96 of an
action a look; the bank clamped the rest away, so it acted on every other
look: 60 a minute. Brutal had shipped (43489c8) with 115 and was much weaker
in fights than measured: back at 120 it beat Hard 61% of 80 games, at 115
40%. The bank now keeps what a look's refill leaves over (still one fight
order a look). "Less fight micro lost" in "Hard, harder" (90 and 60 a
minute) was partly this.

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
- **Easy to Normal is a big step** (60-0). A level between, or Normal at
  about 20 APM, would smooth it if players find the jump too much.
- **Does Marshal's Normal (30 APM) feel right to a person?** Only play will
  tell. The scripted players are the closest stand-in measured so far.

## Where things are

| | |
|---|---|
| `src/sim/ai/bots.ts` | The bot registry: `Bot` (and `sent`), `BotDef` (and its default `apm`), `ALL`, `botSeat` |
| `src/sim/ai/apm.ts` | `capApm`, the token bucket |
| `src/sim/ai/marshal.ts` | Marshal; `MARSHAL` (each difficulty's speeds and caps), `MARSHAL_PLANS`, `MARSHAL_POOL` |
| `src/sim/ai/commander.ts` | The stock commander: `tickAi`, `DIFFICULTY`, `STRATEGIES` |
| `src/sim/ai/player.ts` | The scripted players |
| `src/arena/match.ts` | `parseSeat`, `seatName`, bot seats ticking every tick |
| `tools/arena.ts` | `run`, `series`, `league`, `bots` |
| `src/game/meta.ts` | `difficultyBot` (the menu's difficulty), `watchBot`, `opponentBot`, `opponentPicked` |
| `src/main.ts`, `src/ui/style.css` | The menu's pickers (`watchOptions`, `#opponent`, `#watchrow`) |
| `tests/bots.test.ts` | Covers every registered bot automatically |
| `BOTS.md` | How to write a bot |

## Kicking it off

In a fresh session on the `selectable-bots` branch:

> Read APM-BOTS.md and BOTS.md, then do step 4 of APM-BOTS.md: an APM choice
> in the Opponent and Watch AI vs AI pickers, saved like the bot picks, and
> the cap in the "vs" line. Marshal already wears its difficulty's cap in the
> game (`seatBot` and `difficultyBot` in `src/game/meta.ts`); the choice
> should override it.
