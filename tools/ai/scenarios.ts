import type { PlanName } from "../../src/sim/ai/marshal";
import { TICK_RATE, UNITS } from "../../src/sim/balance";
import type { Bot } from "../../src/sim/ai/bots";
import type { Command, Faction } from "../../src/sim/types";
import { buildingCenter, dist, hqOf, sideFrame } from "../../src/sim/world";

/** Full-loop opponents: commanders pay for all production with real income. Only their
 * military destinations are scripted; these fixtures never spawn units or grant money.
 * Variants 0–2 are exploratory; 3–5 are held out. Positions are side relative. */
export function pressureOpponent(side: Faction, kind: "pressure" | "raid" | "greed", variant: number,
  /** The frozen baseline's Marshal (tools/ai/adapter.ts createWith): the fixture's macro never changes with the candidate. */
  createWith: (side: Faction, seed: number, overrides: (brutal: any) => any) => Bot): Bot {
  const composition: PlanName = (["boom", "ironclad", "balanced"] as const)[variant % 3]!;
  // Greed (POSTURE-PLAN.md stage 3): a Boom that out-expands (five Depots, sixteen miners), keeps a token
  // army (two Fab Plants, no extra factories, no raids) and stays home until 4:00, then plays on as Brutal.
  if (kind === "greed")
    return createWith(side, 9100 + variant, brutal => ({ strategy: "boom", sorties: [], holdUntil: 240,
      tweak: { ...brutal.tweak, harassGroup: Infinity, harvesters: 16, spend: { maxDepots: 5, maxExtra: 0 },
        buildOrder: ["depot", "fab-plant", "depot", "depot", "fab-plant", "depot", "depot", "tech-lab"] } }));
  const macro = createWith(side, 9100 + variant, brutal => ({ strategy: composition, sorties: [],
    tweak: { ...brutal.tweak, assaultValue: Infinity, harassGroup: Infinity,
      ...(kind === "pressure" ? {
        // Reproduce the recorded player's larger paid mining shift and ground
        // army, rather than another Boom investing in radar, aircraft and SAMs.
        harvesters: 16 + variant % 3,
        buildOrder: ["fab-plant", "depot", "fab-plant", "tech-lab", "fab-plant", "depot", "fab-plant"]
      } : {})
    } }));
  let wave = new Set<number>();
  return { tick(w) {
    const cmds = macro.tick(w);
    const start = (kind === "raid" ? 125 : 95) + variant * 7;
    if (w.tick < start * TICK_RATE) return cmds;
    const army = [...w.units.values()].filter(u => u.faction === side && u.kind !== "harvester" && u.kind !== "goliath" && UNITS[u.kind].dps > 0);
    const owned = new Set(army.map(u => u.id));
    const rest = cmds.flatMap<Command>(c => {
      // Keep Marshal's real focus, retreat and kite commands. Only replace its
      // strategic destinations; turning off combat made the old fixture feed
      // a smaller army into the defender and never establish mining pressure.
      if (c.type !== "attackMove") return [c];
      const ids = c.unitIds.filter(id => !owned.has(id));
      return ids.length ? [{ ...c, unitIds: ids }] : [];
    });
    if (w.tick % (5 * TICK_RATE)) return rest;
    const hq = hqOf(w, side);
    if (!hq) return cmds;
    const home = buildingCenter(hq);
    const fr = sideFrame(w, side);
    const [dx, dy] = fr.vec((variant % 3 - 1) * 2, 0);
    // Riverlands' crystal approach, on the opponent's side of the bridge. Merely
    // camping the bridge centre leaves the relevant mining entry out of weapon range.
    const [px, py] = fr.vec(11, -2);
    const target = kind === "raid" ? { x: w.width - home.x + dx, y: w.height - home.y + dy }
      : { x: w.width / 2 + px + dx, y: w.height / 2 + py + dy };
    const [rx, ry] = fr.vec(-7, 7);
    const rally = { x: w.width / 2 + rx, y: w.height / 2 + ry };
    wave = new Set([...wave].filter(id => w.units.has(id)));
    const gathered = army.filter(u => !wave.has(u.id) && dist(u.x, u.y, rally.x, rally.y) <= 6);
    if (gathered.reduce((n, u) => n + UNITS[u.kind].cost * u.hp / UNITS[u.kind].hp, 0) >= (kind === "pressure" ? 4500 : 2500))
      for (const u of gathered) wave.add(u.id);
    const orders = [true, false].flatMap(advancing => {
      const destination = advancing ? target : rally;
      const ids = army.filter(u => wave.has(u.id) === advancing &&
        !(u.order.type === "move" && w.tick - u.damagedTick < 8 * TICK_RATE) &&
        !(u.order.type === "attack" && w.tick - u.firedTick < 3 * TICK_RATE) &&
        (u.order.type !== "attackMove" || dist(u.order.x, u.order.y, destination.x, destination.y) > 1) &&
        dist(u.x, u.y, destination.x, destination.y) > 2).map(u => u.id);
      return ids.length ? [{ type: "attackMove" as const, faction: side, unitIds: ids, ...destination }] : [];
    });
    // Reinforcements assemble into paid waves too, rather than streaming into
    // the field one at a time after the original group has died.
    return [...orders, ...rest];
  }, sent(cmds) { macro.sent?.(cmds); } };
}
