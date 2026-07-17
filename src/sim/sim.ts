import { cleanupDeaths, tickCombat } from "./combat";
import {
  applyEconomyCommand,
  tickConstruction,
  tickHarvest,
  tickProduction
} from "./economy";
import { tickMovement } from "./movement";
import { Terrain, type Command, type World } from "./types";
import { terrainAt } from "./world";

/** Advance the world exactly one tick, applying this tick's commands first. */
export function step(w: World, commands: Command[]): void {
  if (w.winner) return;
  w.fx = [];
  for (const c of commands) applyCommand(w, c);
  tickConstruction(w);
  tickProduction(w);
  tickHarvest(w);
  const engaged = tickCombat(w);
  tickMovement(w, engaged);
  cleanupDeaths(w);
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
      if (terrainAt(w, tx, ty) !== Terrain.Scrap) break;
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction || u.kind !== "harvester") continue;
        u.order = { type: "harvest", fieldX: tx, fieldY: ty, phase: "toField" };
        u.path = null;
      }
      break;
    }
    case "stop":
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction) continue;
        u.order = { type: "idle" };
        u.path = null;
        u.autoTargetId = null;
      }
      break;
    default:
      applyEconomyCommand(w, c);
  }
}
