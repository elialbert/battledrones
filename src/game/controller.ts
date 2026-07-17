import { BUILDINGS, UNITS } from "../sim/balance";
import { canPlaceBuilding } from "../sim/economy";
import {
  Terrain,
  type BuildingKind,
  type Command,
  type Faction,
  type World
} from "../sim/types";
import { buildingAtTile, terrainAt } from "../sim/world";

export const PLAYER: Faction = "blue";

/**
 * Bridges input/HUD and the sim: owns the player's selection, the command
 * queue drained each sim tick, and building-placement mode.
 */
export class Controller {
  selectedUnits = new Set<number>();
  selectedBuilding: number | null = null;
  /** When set, taps place this building instead of commanding. */
  placing: BuildingKind | null = null;
  /** Debug: render fog of war (display-only — the sim always keeps fog). */
  showFog = true;
  /** Spectator (AI vs AI): taps may inspect but never command. */
  spectator = false;
  private queue: Command[] = [];

  constructor(public world: World) {}

  drainCommands(): Command[] {
    const cmds = this.queue;
    this.queue = [];
    return cmds;
  }

  enqueue(cmd: Command): void {
    this.queue.push(cmd);
  }

  /** Drop selection entries for units that no longer exist. */
  prune(): void {
    for (const id of this.selectedUnits)
      if (!this.world.units.has(id)) this.selectedUnits.delete(id);
    if (this.selectedBuilding !== null && !this.world.buildings.has(this.selectedBuilding))
      this.selectedBuilding = null;
    if (this.placing && this.world.factions[PLAYER].pending?.kind !== this.placing)
      this.placing = null;
  }

  selectUnits(ids: number[]): void {
    this.selectedUnits = new Set(ids);
    this.selectedBuilding = null;
  }

  clearSelection(): void {
    this.selectedUnits.clear();
    this.selectedBuilding = null;
  }

  /** Player tapped world position (wx, wy in tile units). */
  tapWorld(wx: number, wy: number, hit: TapHit): void {
    const w = this.world;
    if (this.spectator) {
      // inspection only: selecting shows rings/health, orders are forbidden
      if (hit.kind === "ownUnit") this.selectUnits([hit.id]);
      else this.clearSelection();
      return;
    }
    if (this.placing) {
      const size = BUILDINGS[this.placing].size;
      const tx = Math.round(wx - size / 2);
      const ty = Math.round(wy - size / 2);
      if (canPlaceBuilding(w, PLAYER, this.placing, tx, ty)) {
        this.enqueue({ type: "placeBuilding", faction: PLAYER, tx, ty });
        this.placing = null;
      }
      return;
    }

    if (hit.kind === "ownUnit") {
      this.selectUnits([hit.id]);
      return;
    }
    if (hit.kind === "ownBuilding") {
      this.selectedUnits.clear();
      this.selectedBuilding = hit.id;
      return;
    }
    if (hit.kind === "enemy") {
      const attackers = this.selectedAttackers(hit.targetsAir);
      if (attackers.length > 0) {
        this.enqueue({ type: "attack", faction: PLAYER, unitIds: attackers, targetId: hit.id });
        return;
      }
      return; // tapping enemies with no army selected does nothing
    }

    // ground tap
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    if (this.selectedUnits.size > 0) {
      const ids = [...this.selectedUnits].filter((id) => w.units.has(id));
      const harvesters = ids.filter((id) => w.units.get(id)!.kind === "harvester");
      const rest = ids.filter((id) => w.units.get(id)!.kind !== "harvester");
      if (terrainAt(w, tx, ty) === Terrain.Scrap && harvesters.length > 0) {
        this.enqueue({ type: "harvest", faction: PLAYER, unitIds: harvesters, x: wx, y: wy });
        if (rest.length > 0)
          this.enqueue({ type: "attackMove", faction: PLAYER, unitIds: rest, x: wx, y: wy });
      } else {
        this.enqueue({ type: "attackMove", faction: PLAYER, unitIds: ids, x: wx, y: wy });
      }
      return;
    }
    if (this.selectedBuilding !== null) {
      this.enqueue({ type: "rally", faction: PLAYER, buildingId: this.selectedBuilding, x: wx, y: wy });
    }
  }

  stopSelected(): void {
    if (this.selectedUnits.size > 0)
      this.enqueue({ type: "stop", faction: PLAYER, unitIds: [...this.selectedUnits] });
  }

  /** Selected units able to shoot at the given domain (air or ground). */
  private selectedAttackers(air: boolean): number[] {
    const out: number[] = [];
    for (const id of this.selectedUnits) {
      const u = this.world.units.get(id);
      if (!u) continue;
      const t = UNITS[u.kind].targets;
      if (t === "both" || t === (air ? "air" : "ground")) out.push(id);
    }
    // if nothing can hit it, send everyone anyway (attack-move onto the spot)
    return out;
  }
}

export type TapHit =
  | { kind: "ownUnit"; id: number }
  | { kind: "ownBuilding"; id: number }
  | { kind: "enemy"; id: number; targetsAir: boolean }
  | { kind: "ground" };

/** Hit-test a world point against entities with a forgiving radius. */
export function hitTest(w: World, wx: number, wy: number, radiusTiles: number): TapHit {
  let best: TapHit = { kind: "ground" };
  let bestD = radiusTiles;
  for (const u of w.units.values()) {
    const d = Math.hypot(u.x - wx, u.y - wy);
    if (d < bestD) {
      bestD = d;
      best =
        u.faction === PLAYER
          ? { kind: "ownUnit", id: u.id }
          : { kind: "enemy", id: u.id, targetsAir: UNITS[u.kind].domain === "air" };
    }
  }
  if (best.kind !== "ground") return best;
  const b = buildingAtTile(w, Math.floor(wx), Math.floor(wy));
  if (b)
    return b.faction === PLAYER
      ? { kind: "ownBuilding", id: b.id }
      : { kind: "enemy", id: b.id, targetsAir: false };
  return best;
}
