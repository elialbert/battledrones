import { cleanupDeaths, tickCombat } from "./combat";
import {
  applyEconomyCommand,
  tickConstruction,
  tickHarvest,
  tickProduction,
  tickTrickle
} from "./economy";
import { ECONOMY, FOG } from "./balance";
import { tickFog } from "./fog";
import { tickLifeline } from "./lifeline";
import { callWaveEarly, tickSurvival } from "./modes/survival";
import { tickMovement, vehicleSpots } from "./movement";
import { tickOps } from "./ops";
import { tickObjectives } from "./objectives";
import { applyCalldown, chargePowers, tickPowers } from "./powers";
import { tickSalvage } from "./salvage";
import { applyTransportCommand, tickTransport } from "./transport";
import type { Command, World } from "./types";
import { isResource, tileIndex } from "./world";

/** Advance the world exactly one tick, applying this tick's commands first. */
export function step(w: World, commands: Command[]): void {
  w.fx = []; // (first: a decided world must not hand the deciding tick's events out again)
  if (w.winner) return;
  for (const c of commands) applyCommand(w, c);
  const spots = vehicleSpots(w); // (before anything drives: squads step aside only for a vehicle on the move)
  tickConstruction(w);
  tickProduction(w);
  tickHarvest(w);
  tickTrickle(w);
  tickPowers(w); // calldowns land, stuns wear off (powers.ts)
  const engaged = tickCombat(w);
  tickTransport(w); // squads board Condors, Condors fly drops (transport.ts)
  tickMovement(w, engaged, spots); // (then separation, and Mastodons crushing squads)
  cleanupDeaths(w);
  if (w.lifeline) tickLifeline(w); // a side left with no Condor gets a free one (lifeline.ts)
  tickSalvage(w);
  tickObjectives(w); // Uplink capture bars and income, supply drops (objectives.ts)
  chargePowers(w); // Command meters fill from this tick's losses
  if (w.survival) tickSurvival(w);
  if (w.ops) tickOps(w);
  if (w.tick % FOG.intervalTicks === 0) tickFog(w);
  w.tick++;
}

function applyCommand(w: World, c: Command): void {
  switch (c.type) {
    case "move":
    case "attackMove":
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction) continue;
        u.order = { type: c.type, x: c.x, y: c.y };
        u.path = null;
        u.autoTargetId = null;
      }
      break;
    case "attack":
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction) continue;
        u.order = { type: "attack", targetId: c.targetId };
        u.path = null;
      }
      break;
    case "harvest": {
      const tx = Math.floor(c.x);
      const ty = Math.floor(c.y);
      if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) break;
      if (!isResource(w, tileIndex(w, tx, ty))) break;
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction || u.kind !== "harvester") continue;
        // a full hold goes home to unload first, not out to the field and back
        const full = u.cargo >= ECONOMY.harvesterCapacity - 1e-6;
        u.order = { type: "harvest", fieldX: tx, fieldY: ty, phase: full ? "toBase" : "toField" };
        u.path = null;
      }
      break;
    }
    case "stop":
      // (also how a Condor's drop is called off: its unload order goes)
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction) continue;
        u.order = { type: "idle" };
        u.path = null;
        u.autoTargetId = null;
      }
      break;
    case "board":
    case "unload":
      applyTransportCommand(w, c);
      break;
    case "callWave":
      callWaveEarly(w, c.faction);
      break;
    case "calldown":
      applyCalldown(w, c);
      break;
    default:
      applyEconomyCommand(w, c);
  }
}
