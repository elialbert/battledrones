# Writing a bot

A bot is an AI that can take a seat in Battle Drones. Once it's registered,
it turns up everywhere at once:

- **In the game**, in the menu's Opponent picker (you against it, under
  Easy/Normal/Hard, which it follows if it takes a difficulty) and in the
  pickers under 🤖 Watch AI vs AI, for either side.
- **In the arena**, as a seat against a model or another bot:
  `npx vite-node tools/arena.ts run --blue bot:<id> --red bot:rush`, or
  `llm battledrones run --blue claude-opus-5-5 --red bot:<id>`.
- **In the league**, `tools/arena.ts league`, a round robin against every
  other bot.
- **In `tools/arena.ts bots`**, the list.

There are nine today. Six are the built-in commander with each of its
personalities (`src/sim/ai/commander.ts`), and three are the scripted phone
players (`src/sim/ai/player.ts`). The registry is `src/sim/ai/bots.ts`.

## The rules

A bot must be **fair** and **deterministic**. The tests check what they
can, and the rest is on trust.

### Fair: it plays the game a player plays

- **It only gives orders.** A bot returns `Command[]`, the same commands a
  player's taps make, and the sim checks and applies them. It never changes
  the `World` itself. That includes `w.factions[side].incomeMult`: no bot
  gets an income handicap or bonus. `tests/bots.test.ts` checks that every
  registered bot's side stays at 1.
- **It only sees what its side has seen.** The bot is handed the whole
  `World`, so the fog is up to you. You may read:
  - your own units, buildings, scrap, queues and pending building;
  - the map: terrain, crystal fields, Uplinks, the size, and where your HQ
    stands (the enemy's base is its mirror image, and every player knows
    that);
  - enemy units your side can see now: `seenEnemies(w, side)` in
    `ai/intel.ts`, which applies fog and the Snipers' woods concealment, or
    `unitSeenBy(w, side, u)` for a single unit;
  - enemy buildings your side has seen: `knownBuildings(w, side)` in
    `fog.ts`, remembered until they're seen destroyed;
  - `isVisible(w, side, tx, ty)` and `isExplored(w, side, tx, ty)` for
    tiles.

  Don't read enemy units you can't see, or the enemy's scrap, queues,
  research or pending building. Don't loop over `w.units` for enemies
  without a visibility check.
- **Difficulty changes how it plays, never what it gets.** Difficulty can
  mean reaction speed, how many harvesters it keeps or when it attacks.

### Deterministic: the same match every time

The arena and the tests play a match twice and expect the same commands.
Lockstep duels would need the same too, if a bot ever played in one.

- No `Math.random`, `Date` or `performance.now()`. For randomness, seed it
  from the `seed` your `create` gets: `hash32(seed, …)` from `sim/rand.ts`,
  or a little LCG like `rand()` in `commander.ts`.
- Use `sim/fmath.ts` (`hypot`, `sin`, `cos`, `atan2`, `pow`) instead of the
  `Math` versions. Different JavaScript engines round those differently.
  `tests/fmath.test.ts` fails if `src/sim` uses them. `Math.sqrt`, `floor`,
  `abs`, `min` and `max` are fine.
- A bot is free to keep state between ticks (closures, plain objects). Battle
  records keep the commands, not the bot, so a replay never runs it again.

### Cheap: it runs every tick

`tick(w)` is called 10 times a second for the whole match, and the league
plays thousands of matches. Do almost nothing on most ticks. Every bot so
far thinks every second or so (`if (w.tick % (2 * TICK_RATE) !== 0) return []`),
and only a quick reflex, like the commander's dodge away from calldowns,
should run every tick.

**List your most important commands first.** A planned difficulty knob
caps actions per minute and keeps the first commands a bot returns. Put
defence and the economy before re-sending an attack order.

## The interface

```ts
// src/sim/ai/bots.ts
export interface Bot {
  tick(w: World): Command[];  // this tick's commands; usually []
}

export interface BotDef {
  id: string;             // the seat name: bot:<id>. Lowercase letters only
  label: string;          // the picker's name for it
  about: string;          // one line: the picker's tooltip, `arena.ts bots`
  group: string;          // the picker's heading: "Commander", "Scripted player"…
  difficulties: boolean;  // does bot:<id>:<easy|normal|hard> mean anything?
  opener(seed: number, side: Faction): OpenerId;  // "blitz" | "industry" | "airwing"
  create(side: Faction, seed: number, difficulty: Difficulty): Bot;
}
```

`opener` picks the quick-start opener card (`sim/openers.ts`). If the match
rules ban that pick (for example no Fab Plants under Air War), the arena
and the game swap in an allowed one. `create` is called once per match, for
one side.

## Orders

`Command` in `src/sim/types.ts` is the whole vocabulary. Every command
carries `faction: side`.

| Command | What it does |
|---|---|
| `move`, `attackMove`, `attack`, `stop` | Move units, move while fighting what they meet, attack `targetId`, stop |
| `harvest` | Harvesters mine at (x, y) |
| `produce`, `cancelProduce` | Queue or cancel a unit at a building (`buildingId`), or at an anchored Goliath for infantry |
| `startBuilding`, `placeBuilding`, `cancelBuilding` | Construction, below |
| `sell` | Sell a building |
| `rally` | Where a building's new units go |
| `calldown` | A commander power at (x, y) |
| `board`, `unload` | Infantry board a Condor; the Condor drops them |
| `anchor`, `packUp`, `lift` | Goliaths dig in, walk again, or get lifted by two Condors |
| `resign` | Give up |

Coordinates are world tiles, as floats: `x + 0.5` is the middle of tile x.

**Construction is two steps, as for a player.** `startBuilding` pays and
starts building it. When `w.factions[side].pending?.ready` turns true, the
building is done and waits to be placed with `placeBuilding` at a top-left
tile. Only one building is under way at a time. `suggestPlacement(w, side,
kind, near)` in `sim/placement.ts` finds a valid spot. `canPlaceBuilding` in
`sim/economy.ts` checks one.

**Track your scrap within a tick.** The sim applies your commands after
`tick` returns, so `f.scrap` doesn't drop while you're queueing. Keep a
local `scrap` and subtract as you spend, as every bot here does. A command
you can't afford is refused, and under an action cap it's wasted.

## Helpers worth knowing

| Where | What |
|---|---|
| `sim/balance.ts` | `UNITS[kind]` (cost, dps, domain, range…), `BUILDINGS[kind]` (cost, size, `requires`), `TICK_RATE` |
| `sim/world.ts` | `hqOf(w, side)`, `buildingCenter(b)`, `dist(ax, ay, bx, by)`, `domainOf(u)` |
| `sim/economy.ts` | `nearestReachableResource(w, x, y, side)`, `unitBlocker(w, side, kind)` (why it can't be built now, or null), `canPlaceBuilding` |
| `sim/placement.ts` | `suggestPlacement(w, side, kind, near)` |
| `sim/fog.ts` | `knownBuildings`, `isVisible`, `isExplored` |
| `ai/intel.ts` | `seenEnemies`; `aaSources` then `aaStrengthAt(sources, x, y)` (the anti-air you know of over a point); `effectivenessVs` (how well a weapon does against an armour class) |
| `sim/rules.ts` | `bannedBy(w, kind, side)`: what the match's mutators forbid |
| `sim/rand.ts` | `hash32(...ints)` for seeded randomness |

## A worked example

Turtle: four harvesters, a Fab Plant and turrets, Stingers (and Flak once it
has seen aircraft), and one push at the enemy HQ once it has 12 units. It
compiles, passes the fairness tests and plays full matches. It's also weak:
it loses every game to `bot:novice`, so making it better is a good
exercise.

`src/sim/ai/turtle.ts`:

```ts
import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { nearestReachableResource, unitBlocker } from "../economy";
import { knownBuildings } from "../fog";
import { suggestPlacement } from "../placement";
import type { BuildingKind, Command, Faction, World } from "../types";
import { buildingCenter, hqOf } from "../world";
import { seenEnemies } from "./intel";
import type { Bot } from "./bots";

const BUILD: BuildingKind[] = ["fab-plant", "turret", "turret", "airpad", "turret"];

export function turtle(side: Faction): Bot {
  let attacking = false;
  return {
    tick(w: World): Command[] {
      if (w.tick % (2 * TICK_RATE) !== 0) return []; // one look every 2 s
      const hq = hqOf(w, side);
      if (!hq) return [];
      const cmds: Command[] = [];
      const f = w.factions[side];
      const home = buildingCenter(hq);
      const mine = [...w.units.values()].filter((u) => u.faction === side);
      const myB = [...w.buildings.values()].filter((b) => b.faction === side);
      const army = mine.filter((u) => u.kind !== "harvester" && UNITS[u.kind].dps > 0);
      let scrap = f.scrap;

      // construction: place a finished building, or start the next one we lack
      if (f.pending?.ready) {
        const spot = suggestPlacement(w, side, f.pending.kind, home);
        cmds.push(spot ? { type: "placeBuilding", faction: side, ...spot } : { type: "cancelBuilding", faction: side });
      } else if (!f.pending) {
        const want = BUILD.find((k, i) => myB.filter((b) => b.kind === k).length < BUILD.slice(0, i + 1).filter((x) => x === k).length);
        if (want && scrap >= BUILDINGS[want].cost) {
          cmds.push({ type: "startBuilding", faction: side, building: want });
          scrap -= BUILDINGS[want].cost;
        }
      }

      // economy: four harvesters, idle ones back to work
      const harv = mine.filter((u) => u.kind === "harvester");
      if (harv.length + hq.queue.length < 4 && scrap >= UNITS.harvester.cost) {
        cmds.push({ type: "produce", faction: side, buildingId: hq.id, unit: "harvester" });
        scrap -= UNITS.harvester.cost;
      }
      for (const h of harv)
        if (h.order.type === "idle") {
          const r = nearestReachableResource(w, h.x, h.y, side);
          if (r) cmds.push({ type: "harvest", faction: side, unitIds: [h.id], x: r.x + 0.5, y: r.y + 0.5 });
        }

      // production: Stingers, and Flak once enemy aircraft have been seen
      const seen = seenEnemies(w, side); // only what this side can see
      const air = seen.some((u) => UNITS[u.kind].domain === "air");
      for (const b of myB) {
        if (b.kind !== "fab-plant" || b.queue.length > 0) continue;
        const kind = air && army.filter((u) => u.kind === "flak-crawler").length < 3 ? "flak-crawler" : "stinger";
        if (!unitBlocker(w, side, kind) && scrap >= UNITS[kind].cost) {
          cmds.push({ type: "produce", faction: side, buildingId: b.id, unit: kind });
          scrap -= UNITS[kind].cost;
        }
      }

      // tactics: hold at home until 12 units, then go for their HQ (where we last saw it, else its mirror)
      if (army.length >= 12) attacking = true;
      if (army.length < 4) attacking = false;
      const theirHq = knownBuildings(w, side).find((b) => b.kind === "hq" && b.faction !== side);
      const target = attacking ? (theirHq ? { x: theirHq.tx + 1.5, y: theirHq.ty + 1.5 } : { x: w.width - home.x, y: w.height - home.y }) : home;
      const idle = army.filter((u) => u.order.type === "idle" && u.autoTargetId === null).map((u) => u.id);
      if (idle.length) cmds.push({ type: "attackMove", faction: side, unitIds: idle, x: target.x, y: target.y });
      return cmds;
    }
  };
}
```

Register it in `src/sim/ai/bots.ts`: import it and add an entry to `ALL`.
The list is typed `BotDef[]`, so an inline entry type-checks as one:

```ts
import { turtle } from "./turtle";

const ALL: BotDef[] = [
  ...(Object.keys(STRATEGIES) as StrategyName[]).map(commanderBot),
  ...(Object.keys(PROFILES) as ProfileName[]).map(playerBot),
  {
    id: "turtle",
    label: "Turtle",
    about: "Turrets and Stingers at home, one push at 12 units",
    group: "Homebrew",
    difficulties: false,
    opener: () => "industry",
    create: (side) => turtle(side)
  }
];
```

For a bot with difficulties, read the `difficulty` that `create` gets and
set `difficulties: true`. Then `bot:turtle:hard` parses, and the record
names the seat with its difficulty. The game's Watch AI vs AI always plays
bots at Normal.

## Testing it

1. **`npx vitest run tests/bots.test.ts`.** It already covers every
   registered bot, with no edits: the bot plays both sides of a short match,
   gives only its own side's orders, queues production, and keeps income at
   1×. The file also plays a match twice and replays it, to check it's
   deterministic. Run `npx vitest run tests/fmath.test.ts` too, for the
   banned `Math` functions.
2. **Play it:** `npx vite-node tools/arena.ts run --blue bot:turtle --red
   bot:novice --map riverlands --seed 1`. It prints the winner and writes a
   record to `battles/`. Open the record with `tools/arena.ts watch`, or in
   the game: 🎬 Watch a replay.
3. **Rank it:** `npx vite-node tools/arena.ts league --bots
   bot:turtle,bot:novice,bot:decent,bot:balanced --maps all --seeds 2
   --no-records`. It plays every pair on every map and seed, with the sides
   swapped. One map and one seed is too few to judge a bot.
4. **Watch it** in the game: `npm run dev`, then pick it on the menu's
   picker under 🤖 Watch AI vs AI. It's under its `group`.
5. **Against a model:** `llm battledrones run --blue <model> --red
   bot:turtle`. The LLM plugin seats any `bot:` id as a built-in seat.

## Checklist

- [ ] A module under `src/sim/ai/` whose `tick` returns commands and touches
      nothing else
- [ ] Enemies only through `seenEnemies`, `unitSeenBy`, `knownBuildings`
      and the fog checks
- [ ] No `Math.random`, clocks or `Math.hypot`/`sin`/`cos`/`atan2`/`pow`
- [ ] Thinks every second or so, not every tick
- [ ] Spends from a local `scrap`
- [ ] Important commands first
- [ ] An entry in `ALL` with a lowercase `id`, a `label`, a one-line
      `about` and a `group`
- [ ] `tests/bots.test.ts` and `tests/fmath.test.ts` pass, and it has played
      a league
