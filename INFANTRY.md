# Robot Infantry — spec

Draft. Adds three infantry squads and a flying transport. Numbers are
starting points for `tools/balance.ts`, written in `src/sim/balance.ts` units
(tiles, tiles/s, HP/s).

## Squad model

- A squad is **one sim unit** drawn as N robots. It has one HP pool, and a
  robot falls each time HP crosses a 1/N step.
- DPS scales with the robots still standing: `dps × alive / N`.
- One tap target, one squad-chip entry, and no extra pathing cost.
- New `UnitStats` field: `squad?: number` (the number of robots drawn).

## Armour and damage

New armour class **`infantry`** and new damage type **`precision`**.
Add an `infantry` column and a `precision` row to `DAMAGE_VS`:

| vs `infantry`  | kinetic | cannon | flak | missile | explosive | laser | precision |
|----------------|---------|--------|------|---------|-----------|-------|-----------|
| multiplier     | 1.0     | 0.6    | 1.25 | 0.7     | 1.3       | 0.7   | **3.0**   |

| `precision` vs | light | medium | heavy | structure |
|----------------|-------|--------|-------|-----------|
| multiplier     | 0.6   | 0.4    | 0.25  | 0.15      |

Mortars, Hornets (explosive) and Turrets and Stingers (kinetic) handle
infantry. Titans and Lancers are poor against them.

## Units

| | Trooper Squad | Rocket Squad | Sniper Team |
|---|---|---|---|
| Role (tooltip) | Cheap rifle bots. Hit ground and air. Take cover in woods. | Anti-armour rockets. Kill Titans and Hornets. Weak vs infantry. | Long-range marksmen. Delete infantry. Useless vs vehicles. |
| Robots | 5 | 3 | 2 |
| Cost | 100 | 175 | 200 |
| HP | 225 | 180 | 120 |
| Speed | 1.8 | 1.6 | 1.7 |
| Sight | 5 | 6 | 8 |
| Targets | both (airMult 0.5) | both (airMult 0.8) | ground |
| DPS / range | 18 / 3 | 26 / 4 | 20 / 7 |
| Shot interval | 0.4 | 1.5 | 2.5 (50 per shot, 150 vs infantry) |
| Damage type | kinetic | cannon (fx: rockets) | precision |
| Splash | – | – | – |
| Build time | 6 | 9 | 10 |
| Built at | Assembly Bay | Assembly Bay | Assembly Bay, requires Tech Lab |
| Radius | 0.4 | 0.4 | 0.35 |

One Sniper shot removes about three Trooper robots. Two shots wipe a Rocket Squad.

## Transport — Condor

| | Condor |
|---|---|
| Role (tooltip) | Dropship. Carries two infantry squads over anything. Unarmed. |
| Domain / armour | air / medium |
| Cost / HP | 200 / 400 |
| Speed / sight | 3.6 / 6 |
| Weapon | none |
| Capacity | 2 squads |
| Built at | Airpad |

- **Board:** select infantry and tap a Condor, or tap infantry while a
  Condor is selected. Boarding takes 1 s once the squad is adjacent.
- **Unload:** an **Unload** chip in the command bar, or move with a
  long-press to fly there and drop. The Condor hovers for 1.5 s and can't
  drop onto Water or Rock. It picks the nearest walkable tile.
- **Shot down:** passengers bail out at 50% HP if it's over walkable ground,
  and are lost otherwise.
- Passengers are hidden, can't fire, and don't count toward vision.

## Assembly Bay (new building)

| Cost | HP | Size | Build time | Requires | Sight |
|---|---|---|---|---|---|
| 250 | 700 | 2 | 15 | – | 4 |

Role: "Builds robot infantry."

## Infantry rules

- **Terrain:** move at full speed through Woods and Rough. Shallows ×0.8.
  Water and Rock are impassable. Woods cover is **0.5** for infantry,
  against 0.7 for vehicles.
- **Sniper concealment:** a Sniper Team in Woods is only visible to enemies
  within 3 tiles, until 2 s after it fires.
- **Crushing:** a Titan moving through a squad deals 30 HP/s to it.
  Infantry step aside from friendly vehicles.
- **Uplinks:** infantry capture 2× faster.
- **Crates:** infantry can pick up supply crates.
- **Salvage:** infantry leave no wrecks.
- **Veterancy:** same as other units.

## AI

- **Counters:** add infantry to the seen-composition tallies (`seenInfantry`).
  Answer with Mortars, Turrets or a Sniper Team, and answer Titans with
  Rocket Squads.
- **Build orders:** Balanced adds an Assembly Bay after its Tech Lab. Rush
  opens with Troopers. Ironclad pairs Titans with Rocket escorts.
- **Condor:** Rush and Balanced send one loaded Condor at harvester lines
  as a harass option.
- **Easy:** no Snipers and no Condor drops.

## Last Stand

- New wave theme, **Bot Swarm**: Troopers and Rockets, with Snipers from wave 6.
- Infantry squads count once toward the 30-unit cap.

## Done when

- Unit tests cover squad DPS scaling, precision damage, boarding and
  unloading, bail-outs and crushing.
- AI-vs-AI personality win rates stay between 25% and 75% (`tools/balance.ts`).
- The scripted beginner still wins at least 85% on Easy (`tools/beginner.ts`).
- 3D models: walking cycle for each bot, plus a Condor with a visible bay.
