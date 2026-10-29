export const VARIANTS: Record<string, any> = {
  // stock Marshal rush, its auto depot removed
  nodepot: { spend: { maxDepots: 0 } },
  // two Fab Plants first, 4 harvesters, no depot, small early waves
  fab2: { buildOrder: ["fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 4, assaultValue: 900, harassGroup: 4, spend: { maxDepots: 0 } },
  // all-in: two Fabs, 3 harvesters, attack at 700
  allin: { buildOrder: ["fab-plant", "fab-plant", "fab-plant", "assembly-bay", "airpad", "tech-lab"], harvesters: 3, assaultValue: 700, harassGroup: 4, spend: { maxDepots: 0 } },
  // bay + fab, troopers, attack early
  inf: { buildOrder: ["assembly-bay", "fab-plant", "assembly-bay", "airpad", "tech-lab"], harvesters: 4, assaultValue: 800, harassGroup: 4, infantry: 0.6, spend: { maxDepots: 0 } },
  // rush with one depot later (after 2 fabs)
  fab2d: { buildOrder: ["fab-plant", "fab-plant", "depot", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 5, assaultValue: 900, harassGroup: 4 },
  // no depot, but harvesters never stop
  h8: { harvesters: 8, spend: { maxDepots: 0 } },
  fab2h8: { buildOrder: ["fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 8, assaultValue: 1200, harassGroup: 4, spend: { maxDepots: 0 } },
  fab2h6: { buildOrder: ["fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 6, assaultValue: 1000, harassGroup: 4, spend: { maxDepots: 0 } },
  d1: { spend: { maxDepots: 1 } },
  fab2d1: { buildOrder: ["fab-plant", "depot", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 6, assaultValue: 1000, harassGroup: 4, spend: { maxDepots: 1 } },
  r1: { buildOrder: ["fab-plant", "depot", "assembly-bay", "fab-plant", "turret", "airpad", "tech-lab"], harvesters: 6, spend: { maxDepots: 1 } },
  t1: { expandEarly: true },
  t2: { buildOrder: ["fab-plant", "turret", "depot", "turret", "tech-lab", "turret", "fab-plant", "sam-site", "radar"], expandEarly: true },
  t3: { buildOrder: ["fab-plant", "turret", "depot", "turret", "tech-lab", "turret", "fab-plant", "sam-site", "radar"], expandEarly: true, harvesters: 6 },
  t4: { buildOrder: ["fab-plant", "turret", "depot", "fab-plant", "turret", "tech-lab", "turret", "sam-site", "radar"], expandEarly: true },
  t5: { buildOrder: ["fab-plant", "turret", "turret", "depot", "fab-plant", "turret", "tech-lab", "sam-site", "radar"], expandEarly: true },
  t6: { buildOrder: ["fab-plant", "turret", "depot", "fab-plant", "turret", "tech-lab", "turret", "sam-site", "radar"], expandEarly: true, assaultValue: 2200 },
  // greed: two expansions in the order (each goes up alongside it, once its crew is trained)
  g1: { buildOrder: ["fab-plant", "depot", "depot", "depot", "turret", "tech-lab", "fab-plant", "airpad", "sam-site"] },
  g2: { buildOrder: ["fab-plant", "depot", "depot", "depot", "turret", "tech-lab", "fab-plant", "airpad", "sam-site"], harvesters: 8 },
  // greed: economy before tech (the Tech Lab late)
  g3: { buildOrder: ["fab-plant", "depot", "depot", "fab-plant", "depot", "airpad", "turret", "tech-lab", "sam-site"] },
  // rush: no trickle of raids, one massed push
  r2: { buildOrder: ["fab-plant", "depot", "assembly-bay", "fab-plant", "turret", "airpad", "tech-lab"], harvesters: 6, spend: { maxDepots: 1 }, harassGroup: Infinity, assaultValue: 2000 },
  r3: { buildOrder: ["fab-plant", "depot", "assembly-bay", "fab-plant", "turret", "airpad", "tech-lab"], harvesters: 6, spend: { maxDepots: 1 }, harassGroup: Infinity, assaultValue: 2600 },
  // r1 with as many harvesters as Greed keeps
  r4: { buildOrder: ["fab-plant", "depot", "assembly-bay", "fab-plant", "turret", "airpad", "tech-lab"], harvesters: 10, spend: { maxDepots: 1 } },
  // r1, and an expansion once its order is through
  r5: { buildOrder: ["fab-plant", "depot", "assembly-bay", "fab-plant", "turret", "airpad", "tech-lab", "depot"], harvesters: 6, spend: { maxDepots: 2 } },
  // t4 without the extra factories or an expansion: towers, tech and units
  t8: { buildOrder: ["fab-plant", "turret", "depot", "fab-plant", "turret", "tech-lab", "turret", "sam-site", "radar"], spend: { maxDepots: 1 } },
  // the stock order, no expansion
  t10: { spend: { maxDepots: 1 } },
  // expand once it's safe (never under attack), and lash out later
  t12: { buildOrder: ["fab-plant", "turret", "depot", "fab-plant", "turret", "tech-lab", "turret", "sam-site", "depot", "radar"], spend: { maxDepots: 2 }, harvesters: 6 },
  t14: { buildOrder: ["fab-plant", "turret", "depot", "fab-plant", "turret", "tech-lab", "turret", "sam-site", "depot", "radar"], spend: { maxDepots: 2 }, harvesters: 6, assaultValue: 6000 },
  t15: { buildOrder: ["fab-plant", "turret", "depot", "fab-plant", "turret", "tech-lab", "turret", "sam-site", "depot", "radar"], spend: { maxDepots: 2 }, harvesters: 6, assaultValue: 9000 },
  t16: { buildOrder: ["fab-plant", "turret", "depot", "fab-plant", "turret", "tech-lab", "turret", "sam-site", "depot", "radar"], spend: { maxDepots: 2 }, harvesters: 8, assaultValue: 6000 },
  // two-stage rush: the Blitz Stingers raid at once (packs of 3), a committed wave follows ~a minute later
  b1: { raidFrom: 0, harassGroup: 3 },
  b2: { raidFrom: 0, harassGroup: 3, assaultValue: 1000 },
  b3: { raidFrom: 0, harassGroup: 3, assaultValue: 1000, spend: { maxDepots: 1 } },
  b4: { raidFrom: 0, harassGroup: 3, assaultValue: 800, buildOrder: ["fab-plant", "assembly-bay", "fab-plant", "turret", "airpad", "tech-lab"] },
  b5: { raidFrom: 0, harassGroup: 3, assaultValue: 1000, buildOrder: ["fab-plant", "depot", "assembly-bay", "fab-plant", "turret", "airpad", "tech-lab", "depot"], harvesters: 6, spend: { maxDepots: 2 } },
  // mass Stingers: a home Depot, then 2-3 Fab Plants pumping Stingers, one big wave (no trickle of raids)
  m1: { buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 6, harassGroup: Infinity, assaultValue: 1500, infantry: 0.15, spend: { maxDepots: 1 } },
  m2: { buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 6, harassGroup: Infinity, assaultValue: 1800, infantry: 0.1, spend: { maxDepots: 1 } },
  m3: { buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab", "depot"], harvesters: 7, harassGroup: Infinity, assaultValue: 1500, infantry: 0.15, spend: { maxDepots: 2 } },
  m4: { buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 6, harassGroup: Infinity, assaultValue: 2200, infantry: 0.15, spend: { maxDepots: 1 } },
  // turtle vs a tank flood: turrets as tanks are seen, the SAM and radar later
  t20: { turretsVsGround: 4 },
  t21: { turretsVsGround: 3, buildOrder: ["fab-plant", "turret", "depot", "turret", "fab-plant", "tech-lab", "turret", "sam-site", "radar"] },
  t22: { turretsVsGround: 3, buildOrder: ["fab-plant", "turret", "depot", "turret", "fab-plant", "tech-lab", "turret", "depot", "sam-site", "radar"], spend: { maxDepots: 2 }, harvesters: 6 },
  // hold the way into the base
  hc: { holdChoke: true },
  hc22: { holdChoke: true, turretsVsGround: 3, buildOrder: ["fab-plant", "turret", "depot", "turret", "fab-plant", "tech-lab", "turret", "depot", "sam-site", "radar"], spend: { maxDepots: 2 }, harvesters: 6 },
  hc2: { holdChoke: true, expandEarly: true, buildOrder: ["fab-plant", "turret", "fab-plant", "depot", "turret", "tech-lab", "sam-site", "radar"] },
  hc3: { holdChoke: true, expandEarly: true, turretsVsGround: 3, buildOrder: ["fab-plant", "turret", "fab-plant", "depot", "turret", "tech-lab", "sam-site", "radar"] },
  hc4: { holdChoke: true, expandEarly: true, turretsVsGround: 3, buildOrder: ["fab-plant", "turret", "depot", "turret", "fab-plant", "tech-lab", "turret", "depot", "sam-site", "radar"], spend: { maxDepots: 2 }, harvesters: 6 },
  // turtle: tech first behind the gate
  tt1: { holdChoke: true, turretsVsGround: 3, buildOrder: ["fab-plant", "turret", "tech-lab", "fab-plant", "depot", "turret", "sam-site", "radar"] },
  tt2: { holdChoke: true, turretsVsGround: 3, mortarShare: 0.35, buildOrder: ["fab-plant", "turret", "tech-lab", "fab-plant", "depot", "turret", "sam-site", "radar"] },
  tt3: { holdChoke: true, turretsVsGround: 3, mortarShare: 0.35, expandEarly: true, buildOrder: ["fab-plant", "tech-lab", "turret", "fab-plant", "depot", "turret", "sam-site", "radar"] },
  tt4: { holdChoke: true, turretsVsGround: 3, mortarShare: 0.35, expandEarly: true, harvesters: 6, buildOrder: ["fab-plant", "turret", "tech-lab", "fab-plant", "depot", "turret", "depot", "sam-site", "radar"], spend: { maxDepots: 2 } },
  // turtle in the air: Stingers can't shoot up
  ta1: { holdChoke: true, airOnly: true, expandEarly: true, buildOrder: ["airpad", "turret", "airpad", "depot", "tech-lab", "turret", "sam-site", "radar"] },
  ta2: { holdChoke: true, expandEarly: true, mortarShare: 0.35, turretsVsGround: 3, buildOrder: ["fab-plant", "airpad", "turret", "tech-lab", "airpad", "depot", "turret", "radar"] },
  // turtle: tower the gate first, then tech
  tt5: { holdChoke: true, turretsVsGround: 2, mortarShare: 0.35, expandEarly: true, buildOrder: ["fab-plant", "turret", "turret", "tech-lab", "fab-plant", "depot", "turret", "sam-site", "radar"] },
  tt6: { holdChoke: true, turretsVsGround: 3, mortarShare: 0.35, expandEarly: true, buildOrder: ["fab-plant", "turret", "tech-lab", "turret", "fab-plant", "depot", "sam-site", "radar"] },
  // mass Stingers that also raid what lies outside the walls
  m5: { buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab", "depot"], harvesters: 7, harassGroup: 4, assaultValue: 1500, infantry: 0.15, spend: { maxDepots: 2 } },
  m6: { buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab", "depot"], harvesters: 7, harassGroup: 6, assaultValue: 1800, infantry: 0.15, spend: { maxDepots: 2 } },
  tt7: { holdChoke: true, turretsVsGround: 2, mortarShare: 0.35, expandEarly: true, harvesters: 7, buildOrder: ["fab-plant", "turret", "turret", "tech-lab", "fab-plant", "depot", "turret", "sam-site", "radar"] },
  // a committed rush: 6 harvesters, the home field only
  m7: { buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab"], harvesters: 6, harassGroup: 4, assaultValue: 1400, infantry: 0.15, spend: { maxDepots: 1 } },
  tt8: { holdChoke: true, turretsVsGround: 2, mortarShare: 0.35, expandEarly: true, harvesters: 7, buildOrder: ["fab-plant", "depot", "turret", "turret", "tech-lab", "fab-plant", "turret", "sam-site", "radar"] },
};
