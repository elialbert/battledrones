import { BUILDINGS, UNITS } from "../sim/balance";
import { isInfantry, isTransport } from "../sim/infantry";
import { placementBlocker, snapPlacement } from "../sim/placement";
import { freeSeats, isLoaded } from "../sim/transport";
import type { BuildingKind, Command, Faction, Unit, World } from "../sim/types";
import { buildingAtTile, isResource, tileIndex } from "../sim/world";
import { Squads } from "./squads";

export const PLAYER: Faction = "blue";

const PRODUCERS: ReadonlySet<BuildingKind> = new Set(Object.values(UNITS).map((u) => u.builtAt));
/** Does this building turn out units (so a tap with it selected sets its rally point)? HQ, Fab Plant, Airpad, Assembly Bay. */
export const isProducer = (kind: BuildingKind): boolean => PRODUCERS.has(kind);

/**
 * What the player's last tap did, for on-map feedback markers: "board" —
 * squads were sent to climb into a Condor; "drop" — loaded Condors were sent
 * to put their squads down (a long-press on the map, or the Unload chip).
 */
export type TapFeedback = {
  kind: "move" | "attack" | "harvest" | "rally" | "place" | "board" | "drop";
  x: number;
  y: number;
} | null;

/**
 * Bridges input/HUD and the sim: owns the player's selection, the command
 * queue drained each sim tick, and building-placement mode.
 */
export class Controller {
  selectedUnits = new Set<number>();
  selectedBuilding: number | null = null;
  /** When set, taps place this building instead of commanding. */
  placing: BuildingKind | null = null;
  /** Next ground tap issues a plain move (retreat) instead of attack-move. */
  forceMove = false;
  /** Debug: render fog of war (display-only — the sim always keeps fog). */
  showFog = true;
  /** Spectator (AI vs AI): taps may inspect but never command. */
  spectator = false;
  paused = false;
  lastFeedback: TapFeedback = null;
  /** Where the placement ghost sits (top-left tile) while placing. */
  placeAt: { tx: number; ty: number } | null = null;
  /** A placement attempt that failed, for the ghost shake (the scene consumes it). */
  denied: { reason: string; tx: number; ty: number } | null = null;
  /** A short note about the last order ("Condor full"), for the HUD ticker (the scene consumes it). */
  tip: string | null = null;
  /** Three saved control groups (squad chips, keys 1–3). */
  readonly squads = new Squads(PLAYER);
  private queue: Command[] = [];

  constructor(public world: World) {}

  drainCommands(): Command[] {
    const cmds = this.queue;
    this.queue = [];
    return cmds;
  }

  enqueue(cmd: Command): void {
    if (this.spectator) return;
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
    if (!this.placing) this.placeAt = null;
    this.squads.prune(this.world);
  }

  selectUnits(ids: number[]): void {
    this.selectedUnits = new Set(ids);
    this.selectedBuilding = null;
    this.forceMove = false;
  }

  clearSelection(): void {
    this.selectedUnits.clear();
    this.selectedBuilding = null;
    this.forceMove = false;
  }

  /** Shift+click: add a unit to the selection, or take it out if it's already in. */
  toggleUnit(id: number): void {
    this.selectedBuilding = null;
    if (this.selectedUnits.delete(id)) return; // taken out quietly
    // adding makes a fresh selection set, so the voices answer
    this.selectedUnits = new Set([...this.selectedUnits, id]);
  }

  /** Select every combat unit the player owns. */
  selectArmy(): void {
    const ids = [...this.world.units.values()]
      .filter((u) => u.faction === PLAYER && u.kind !== "harvester")
      .map((u) => u.id);
    this.selectUnits(ids);
  }

  /** Combat units with no orders (sitting at home, or done with their last order). */
  idleArmy(): number[] {
    return [...this.world.units.values()]
      .filter((u) => u.faction === PLAYER && u.kind !== "harvester" && u.order.type === "idle")
      .map((u) => u.id);
  }

  /** Save the current unit selection as squad i. Returns how many were saved. */
  assignSquad(i: number): number {
    return this.squads.assign(i, this.selectedUnits, this.world);
  }

  /** Select squad i's living members. Returns how many. */
  selectSquad(i: number): number {
    const ids = this.squads.ids(i, this.world);
    if (ids.length > 0) this.selectUnits(ids);
    return ids.length;
  }

  // ----------------------------------------------------------- placement --

  /** Why the ghost can't be built where it sits, or null when it can. */
  placementProblem(): string | null {
    if (!this.placing || !this.placeAt) return null;
    return placementBlocker(this.world, PLAYER, this.placing, this.placeAt.tx, this.placeAt.ty);
  }

  /** Move the ghost to (tx, ty), nudged onto a valid spot a tile away if that's all it takes. */
  movePlacement(tx: number, ty: number, snap = true): void {
    if (!this.placing) return;
    this.placeAt = snap ? snapPlacement(this.world, PLAYER, this.placing, tx, ty) : { tx, ty };
  }

  /** Build the ghost where it sits. On failure, records why in `denied`. */
  commitPlacement(): boolean {
    const kind = this.placing;
    const at = this.placeAt;
    if (!kind || !at || this.spectator) return false;
    const why = placementBlocker(this.world, PLAYER, kind, at.tx, at.ty);
    if (why) {
      this.denied = { reason: why, tx: at.tx, ty: at.ty };
      return false;
    }
    const size = BUILDINGS[kind].size;
    this.enqueue({ type: "placeBuilding", faction: PLAYER, tx: at.tx, ty: at.ty });
    this.placing = null;
    this.placeAt = null;
    this.lastFeedback = { kind: "place", x: at.tx + size / 2, y: at.ty + size / 2 };
    return true;
  }

  /** Player tapped world position (wx, wy in tile units); `toggle` (Shift) adds or removes a tapped unit. */
  tapWorld(wx: number, wy: number, hit: TapHit, toggle = false): void {
    const w = this.world;
    this.lastFeedback = null;
    if (this.spectator) {
      // inspection only: selecting shows rings/health, orders are forbidden
      if (hit.kind === "ownUnit" || hit.kind === "enemy") this.selectUnits(w.units.has(hit.id) ? [hit.id] : []);
      else this.clearSelection();
      return;
    }
    if (this.placing) {
      // one-click placement (mouse): the ghost goes where you click and builds if it can
      const size = BUILDINGS[this.placing].size;
      this.placeAt = { tx: Math.round(wx - size / 2), ty: Math.round(wy - size / 2) };
      this.commitPlacement();
      return;
    }

    if (hit.kind === "ownUnit") {
      if (toggle) this.toggleUnit(hit.id);
      else if (!this.boardTap(hit.id)) this.selectUnits([hit.id]);
      return;
    }
    if (hit.kind === "ownBuilding") {
      // with units selected, tapping our own building just moves them there
      if (this.selectedUnits.size === 0) {
        this.selectedUnits.clear();
        this.selectedBuilding = hit.id;
        return;
      }
    }
    if (hit.kind === "enemy" && this.selectedUnits.size > 0) {
      const attackers = this.selectedAttackers(hit.targetsAir);
      if (attackers.length > 0) {
        this.enqueue({ type: "attack", faction: PLAYER, unitIds: attackers, targetId: hit.id });
        const others = [...this.selectedUnits].filter((id) => !attackers.includes(id));
        if (others.length > 0)
          this.enqueue({ type: "move", faction: PLAYER, unitIds: others, x: wx, y: wy });
        this.lastFeedback = { kind: "attack", x: wx, y: wy };
        return;
      }
    }
    if (hit.kind === "enemy" && this.selectedUnits.size === 0) return;

    // ground tap
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    if (this.selectedUnits.size > 0) {
      const ids = [...this.selectedUnits].filter((id) => w.units.has(id));
      const harvesters = ids.filter((id) => w.units.get(id)!.kind === "harvester");
      const rest = ids.filter((id) => w.units.get(id)!.kind !== "harvester");
      const onResource =
        tx >= 0 && ty >= 0 && tx < w.width && ty < w.height && isResource(w, tileIndex(w, tx, ty));
      const type = this.forceMove ? "move" : "attackMove";
      if (onResource && harvesters.length > 0) {
        this.enqueue({ type: "harvest", faction: PLAYER, unitIds: harvesters, x: wx, y: wy });
        if (rest.length > 0) this.enqueue({ type, faction: PLAYER, unitIds: rest, x: wx, y: wy });
        this.lastFeedback = { kind: "harvest", x: wx, y: wy };
      } else {
        // harvesters always just drive (they have no guns to stop for)
        if (harvesters.length > 0) this.enqueue({ type: "move", faction: PLAYER, unitIds: harvesters, x: wx, y: wy });
        if (rest.length > 0) this.enqueue({ type, faction: PLAYER, unitIds: rest, x: wx, y: wy });
        this.lastFeedback = { kind: "move", x: wx, y: wy };
      }
      this.forceMove = false;
      return;
    }
    if (this.selectedBuilding !== null) {
      const b = w.buildings.get(this.selectedBuilding);
      if (b && isProducer(b.kind)) {
        this.enqueue({ type: "rally", faction: PLAYER, buildingId: this.selectedBuilding, x: wx, y: wy });
        this.lastFeedback = { kind: "rally", x: wx, y: wy };
      } else this.clearSelection();
    }
  }

  stopSelected(): void {
    if (this.selectedUnits.size > 0)
      this.enqueue({ type: "stop", faction: PLAYER, unitIds: [...this.selectedUnits] });
  }

  // ------------------------------------------------------------ transport --

  /** Selected Condors with squads aboard. */
  loadedSelected(): Unit[] {
    return this.selectedOwn().filter((u) => isLoaded(u));
  }

  /** Squads aboard the selected Condors (the Unload chip's count). */
  aboardSelected(): number {
    let n = 0;
    for (const c of this.loadedSelected()) n += c.passengers!.length;
    return n;
  }

  /** Unload chip / U key: the selected Condors put their squads down where they are. */
  unloadSelected(): boolean {
    if (this.spectator) return false;
    const cs = this.loadedSelected();
    if (cs.length === 0) return false;
    this.enqueue({ type: "unload", faction: PLAYER, unitIds: cs.map((c) => c.id) });
    this.lastFeedback = { kind: "drop", x: cs[0]!.x, y: cs[0]!.y };
    return true;
  }

  /**
   * Long-press on the map: the selected loaded Condors fly to (wx, wy) and
   * drop their squads (the sim snaps the drop to the nearest ground a squad
   * can stand on); the rest of the selection heads there too. False (nothing
   * done) when no loaded Condor is selected.
   */
  dropAt(wx: number, wy: number): boolean {
    if (this.spectator || this.placing) return false;
    const cs = this.loadedSelected();
    if (cs.length === 0) return false;
    const ids = cs.map((c) => c.id);
    this.enqueue({ type: "unload", faction: PLAYER, unitIds: ids, x: wx, y: wy });
    const rest = this.selectedOwn().filter((u) => !ids.includes(u.id)).map((u) => u.id);
    if (rest.length > 0) this.enqueue({ type: this.forceMove ? "move" : "attackMove", faction: PLAYER, unitIds: rest, x: wx, y: wy });
    this.forceMove = false;
    this.lastFeedback = { kind: "drop", x: wx, y: wy };
    return true;
  }

  /**
   * A tap on one of our own units that loads a Condor instead of selecting:
   * with squads selected, tapping a Condor sends them aboard it (as many as
   * it has seats, nearest first); with Condors (and no squads) selected,
   * tapping a squad sends it aboard the nearest selected Condor with a seat.
   * A Condor that is flying somewhere stops to come and meet them. Returns
   * false when the tap is an ordinary selection. (A right-click on our own
   * unit loads the same way.)
   */
  boardTap(id: number): boolean {
    if (this.spectator || this.placing) return false;
    const w = this.world;
    const tapped = w.units.get(id);
    if (!tapped || tapped.faction !== PLAYER) return false;
    const sel = this.selectedOwn();
    const squads = sel.filter((u) => isInfantry(u.kind));
    let carrier: Unit | null = null;
    let riders: Unit[] = [];
    if (isTransport(tapped.kind) && squads.length > 0) {
      const seats = this.openSeats(tapped, squads);
      if (seats <= 0) {
        this.tip = `${UNITS[tapped.kind].name} full: unload it first`;
        return false; // (selects it, Unload chip and all)
      }
      riders = [...squads].sort((a, b) => dist(a, tapped) - dist(b, tapped) || a.id - b.id).slice(0, seats);
      if (riders.length < squads.length) this.tip = `Room for ${seats} squad${seats === 1 ? "" : "s"} only`;
      carrier = tapped;
    } else if (isInfantry(tapped.kind) && squads.length === 0) {
      const condors = sel.filter((u) => isTransport(u.kind));
      if (condors.length === 0) return false;
      const open = condors.filter((c) => this.openSeats(c, [tapped]) > 0);
      if (open.length === 0) {
        this.tip = condors.length > 1 ? "Those Condors are full" : `${UNITS[condors[0]!.kind].name} full: unload it first`;
        return false;
      }
      carrier = open.sort((a, b) => dist(a, tapped) - dist(b, tapped) || a.id - b.id)[0]!;
      riders = [tapped];
    } else return false;
    this.enqueue({ type: "board", faction: PLAYER, unitIds: riders.map((u) => u.id), carrierId: carrier.id });
    // a Condor on its way somewhere waits for them instead (idle, it flies over to meet them)
    if (carrier.order.type === "move" || carrier.order.type === "attackMove")
      this.enqueue({ type: "stop", faction: PLAYER, unitIds: [carrier.id] });
    this.forceMove = false;
    this.lastFeedback = { kind: "board", x: carrier.x, y: carrier.y };
    return true;
  }

  /** Seats on Condor `c` not already promised to squads walking to it (other than `riders`). */
  private openSeats(c: Unit, riders: readonly Unit[]): number {
    let promised = 0;
    for (const u of this.world.units.values())
      if (u.order.type === "board" && u.order.carrierId === c.id && !riders.includes(u)) promised++;
    return freeSeats(c) - promised;
  }

  /** The player's own selected units on the field. */
  private selectedOwn(): Unit[] {
    const out: Unit[] = [];
    for (const id of this.selectedUnits) {
      const u = this.world.units.get(id);
      if (u && u.faction === PLAYER) out.push(u);
    }
    return out;
  }

  sellSelected(): void {
    if (this.selectedBuilding !== null)
      this.enqueue({ type: "sell", faction: PLAYER, buildingId: this.selectedBuilding });
    this.selectedBuilding = null;
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
    return out;
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export type TapHit =
  | { kind: "ownUnit"; id: number }
  | { kind: "ownBuilding"; id: number }
  | { kind: "enemy"; id: number; targetsAir: boolean }
  | { kind: "ground" };

/**
 * Hit-test a world point against entities with a forgiving radius.
 * `canSee` filters out enemies hidden in the fog.
 */
export function hitTest(
  w: World,
  wx: number,
  wy: number,
  radiusTiles: number,
  canSee: (id: number) => boolean = () => true
): TapHit {
  let best: TapHit = { kind: "ground" };
  let bestD = radiusTiles;
  for (const u of w.units.values()) {
    // aircraft are drawn lifted: test against where they appear
    const lift = UNITS[u.kind].domain === "air" ? 0.35 : 0;
    const d = Math.hypot(u.x - wx, u.y - lift - wy);
    if (d < bestD) {
      if (u.faction !== PLAYER && !canSee(u.id)) continue;
      bestD = d;
      best =
        u.faction === PLAYER
          ? { kind: "ownUnit", id: u.id }
          : { kind: "enemy", id: u.id, targetsAir: UNITS[u.kind].domain === "air" };
    }
  }
  if (best.kind !== "ground") return best;
  const b = buildingAtTile(w, Math.floor(wx), Math.floor(wy));
  if (b) {
    if (b.faction === PLAYER) return { kind: "ownBuilding", id: b.id };
    if (canSee(b.id)) return { kind: "enemy", id: b.id, targetsAir: false };
  }
  return best;
}
