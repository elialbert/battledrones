import { BUILDINGS } from "./balance";
import { Terrain, type Biome, type World } from "./types";
import { createWorld, inBounds, setTerrain, spawnBuilding, spawnUnit, terrainAt } from "./world";
import { setupSurvival, type SurvivalOptions } from "./modes/survival";
import { applyMutators, type MutatorId } from "./rules";
import { setupOp } from "./ops";

/**
 * Skirmish maps. Every map is 2-player and point-symmetric (rotated 180°
 * about the centre), so both sides get identical terrain. Maps are painted
 * procedurally from a fixed seed with simple shape primitives — the same
 * definition feeds the simulation and (via tools/export-maps.ts) the
 * offline terrain renderer that paints the matching ground art.
 */

export interface MapDef {
  id: string;
  name: string;
  biome: Biome;
  size: number;
  /** One-line flavour for the map picker. */
  blurb: string;
  /** Blue HQ top-left tile; red is mirrored. */
  hq: [number, number];
  seed: number;
  paint(p: Painter): void;
}

// ---------------------------------------------------------------- noise ---

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1). */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// -------------------------------------------------------------- painter ---

type Pt = [number, number];

/** Paints terrain shapes, always mirrored through the map centre. */
export class Painter {
  constructor(public w: World, public seed: number) {}

  private n(x: number, y: number, scale = 0.35): number {
    return valueNoise(x * scale, y * scale, this.seed) - 0.5;
  }

  /** Paint one tile and its mirror. `only` restricts which terrain may be overwritten. */
  set(tx: number, ty: number, t: Terrain, only?: Terrain[]): void {
    const { w } = this;
    for (const [x, y] of [
      [tx, ty],
      [w.width - 1 - tx, w.height - 1 - ty]
    ] as Pt[]) {
      if (!inBounds(w, x, y)) continue;
      if (only && !only.includes(terrainAt(w, x, y))) continue;
      setTerrain(w, x, y, t);
    }
  }

  /** Organic blob: a disc whose edge wobbles with noise. */
  blob(cx: number, cy: number, r: number, t: Terrain, wobble = 0.35, only?: Terrain[]): void {
    const R = Math.ceil(r * (1 + wobble) + 1);
    for (let ty = Math.floor(cy - R); ty <= cy + R; ty++)
      for (let tx = Math.floor(cx - R); tx <= cx + R; tx++) {
        const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
        if (d <= r * (1 + wobble * 2 * this.n(tx, ty))) this.set(tx, ty, t, only);
      }
  }

  /** Thick, gently wobbling polyline (rivers, ridges, roads). */
  stroke(pts: Pt[], width: number, t: Terrain, wobble = 0.25, only?: Terrain[]): void {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.ceil(len * 3);
      for (let s = 0; s <= steps; s++) {
        const x = x0 + ((x1 - x0) * s) / steps;
        const y = y0 + ((y1 - y0) * s) / steps;
        const r = (width / 2) * (1 + wobble * 2 * this.n(x * 1.7, y * 1.7));
        const R = Math.ceil(r + 1);
        for (let ty = Math.floor(y - R); ty <= y + R; ty++)
          for (let tx = Math.floor(x - R); tx <= x + R; tx++)
            if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) <= r) this.set(tx, ty, t, only);
      }
    }
  }

  /** Axis-aligned rectangle (inclusive). */
  rect(x0: number, y0: number, x1: number, y1: number, t: Terrain, only?: Terrain[]): void {
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) this.set(tx, ty, t, only);
  }

  /** Scatter small blobs of `t` with the given density over a region. */
  scatter(x0: number, y0: number, x1: number, y1: number, count: number, r: number, t: Terrain, only?: Terrain[]): void {
    for (let i = 0; i < count; i++) {
      const x = x0 + hash(i, 17, this.seed) * (x1 - x0);
      const y = y0 + hash(i, 91, this.seed) * (y1 - y0);
      this.blob(x, y, r * (0.6 + hash(i, 5, this.seed) * 0.8), t, 0.4, only);
    }
  }
}

const G = Terrain.Ground;
const OPEN = [Terrain.Ground, Terrain.Rough, Terrain.Forest];
const LAND = [Terrain.Ground, Terrain.Rough, Terrain.Forest, Terrain.Rock];

// ------------------------------------------------------------------ maps ---

export const MAPS: MapDef[] = [
  {
    id: "riverlands",
    name: "Riverlands",
    biome: "temperate",
    size: 56,
    blurb: "A wide river splits the valley. One bridge, two muddy fords.",
    hq: [4, 48],
    seed: 11,
    paint(p) {
      // meandering river from the NW corner to the centre (mirrored to SE)
      const river: Pt[] = [[-2, 1], [5, 6], [11, 13], [17, 16], [23, 23], [28, 28]];
      p.stroke(river, 4.2, Terrain.Water, 0.2);
      // banks: reeds and mud along the water, woods behind
      p.stroke(river, 7, Terrain.Rough, 0.35, [G]);
      p.blob(12, 27, 3.4, Terrain.Forest, 0.45, OPEN);
      p.blob(27, 42, 3.8, Terrain.Forest, 0.45, OPEN);
      p.blob(3, 21, 3, Terrain.Forest, 0.45, OPEN);
      p.blob(39, 51, 3.2, Terrain.Forest, 0.45, OPEN);
      p.blob(18, 52, 2.2, Terrain.Forest, 0.45, OPEN);
      // rocky outcrops shaping the approaches
      p.blob(21, 45, 2.2, Terrain.Rock, 0.4, OPEN);
      p.blob(8, 33, 1.6, Terrain.Rock, 0.4, OPEN);
      p.blob(33, 35, 1.8, Terrain.Rock, 0.3, OPEN);
      // crossings: a stone bridge at the centre, shallow fords near the ends
      p.stroke([[23, 32], [32, 23]], 2.2, Terrain.Bridge, 0, [Terrain.Water]);
      p.stroke([[23, 32], [32, 23]], 2.2, Terrain.Road, 0, [G, Terrain.Rough, Terrain.Forest]);
      p.stroke([[8, 14], [13, 9]], 3, Terrain.Shallows, 0.1, [Terrain.Water]);
      // roads from each HQ to the bridge
      p.stroke([[6, 49], [11, 46], [16, 40], [21, 35], [23.5, 32]], 2, Terrain.Road, 0, OPEN);
      // resources: home field, natural expansion, contested crystals
      p.blob(13, 44, 2.1, Terrain.Scrap, 0.25);
      p.blob(5, 36, 1.7, Terrain.Scrap, 0.25);
      p.blob(19, 30, 1.5, Terrain.Crystal, 0.2);
      p.blob(34, 46, 1.6, Terrain.Scrap, 0.25);
    }
  },
  {
    id: "dune-sea",
    name: "Dune Sea",
    biome: "desert",
    size: 56,
    blurb: "Open sands between towering mesas. Three lanes, rich wrecks.",
    hq: [4, 48],
    seed: 23,
    paint(p) {
      // two great mesas flank the central corridor
      p.blob(17, 23, 6.2, Terrain.Rough, 0.3, [G]);
      p.blob(17, 23, 4.8, Terrain.Rock, 0.3);
      p.blob(9, 13, 3, Terrain.Rough, 0.3, [G]);
      p.blob(9, 13, 2, Terrain.Rock, 0.35);
      p.blob(25, 45, 2.6, Terrain.Rough, 0.3, [G]);
      p.blob(25, 45, 1.7, Terrain.Rock, 0.35);
      // oases: a central pool with palms, and corner springs
      p.blob(27.5, 27.5, 3.6, Terrain.Forest, 0.3, [G, Terrain.Rough]);
      p.blob(27.5, 27.5, 2.1, Terrain.Water, 0.2);
      p.blob(4, 4, 3.2, Terrain.Forest, 0.35, [G]);
      p.blob(3, 3, 2, Terrain.Water, 0.3);
      // dusty tracks along the central corridor, swinging round the oasis
      p.stroke([[6, 49], [12, 44], [18, 38], [22, 34], [25, 32.5], [31, 31]], 2, Terrain.Road, 0, OPEN);
      // resources
      p.blob(13, 44, 2.1, Terrain.Scrap, 0.25);
      p.blob(4, 35, 1.8, Terrain.Scrap, 0.25);
      p.blob(8, 24, 1.5, Terrain.Scrap, 0.25);
      p.blob(22, 35, 1.5, Terrain.Crystal, 0.2);
      p.blob(34, 44, 1.5, Terrain.Crystal, 0.2);
      // scree fields slow the flanks
      p.scatter(30, 36, 50, 54, 5, 1.6, Terrain.Rough, [G]);
    }
  },
  {
    id: "frostbite",
    name: "Frostbite",
    biome: "arctic",
    size: 48,
    blurb: "A frozen sea in the middle. Short, brutal and hover-friendly.",
    hq: [4, 40],
    seed: 37,
    paint(p) {
      // central icy sea — ground armies must skirt it
      p.blob(23.5, 23.5, 9.5, Terrain.Water, 0.18);
      p.blob(23.5, 23.5, 11.5, Terrain.Shallows, 0.2, [G]);
      // snowy pine woods
      p.blob(15, 38, 2.4, Terrain.Forest, 0.4, OPEN);
      p.blob(5, 26, 3, Terrain.Forest, 0.45, OPEN);
      p.blob(26, 44, 2.6, Terrain.Forest, 0.45, OPEN);
      p.blob(2, 12, 2.4, Terrain.Forest, 0.45, OPEN);
      // ridges near the bases
      p.stroke([[12, 30], [9, 31], [7, 33]], 1.8, Terrain.Rock, 0.3, OPEN);
      p.blob(34, 41, 1.8, Terrain.Rock, 0.4, OPEN);
      // slush in the lanes
      p.blob(8, 8, 3, Terrain.Rough, 0.4, [G]);
      p.blob(20, 42, 2, Terrain.Rough, 0.4, [G]);
      // plowed road
      p.stroke([[6, 41], [11, 42], [18, 43], [24, 44]], 1.8, Terrain.Road, 0, OPEN);
      // resources: home field, contested crystal in each lane
      p.blob(11, 36, 2, Terrain.Scrap, 0.25);
      p.blob(9, 9, 1.6, Terrain.Crystal, 0.2);
      p.blob(3, 31, 1.4, Terrain.Scrap, 0.25);
    }
  },
  {
    id: "ashlands",
    name: "Ashlands",
    biome: "volcanic",
    size: 64,
    blurb: "Lava rivers carve three plateaus. Bridges are choke points; air rules.",
    hq: [5, 55],
    seed: 53,
    paint(p) {
      // a lava river between the blue plateau and the central one (mirrored)
      const lava: Pt[] = [[-2, 12], [8, 21], [16, 27], [26, 38], [36, 46], [44, 55], [52, 66]];
      p.stroke(lava, 3.6, Terrain.Water, 0.25);
      p.stroke(lava, 6.5, Terrain.Rough, 0.4, [G]);
      // metal bridges across
      p.stroke([[9, 26], [14, 21]], 2.2, Terrain.Bridge, 0, [Terrain.Water]);
      p.stroke([[9, 26], [14, 21]], 2.2, Terrain.Road, 0, OPEN);
      p.stroke([[30, 47], [35, 42]], 2.2, Terrain.Bridge, 0, [Terrain.Water]);
      p.stroke([[30, 47], [35, 42]], 2.2, Terrain.Road, 0, OPEN);
      // plated roads from the HQ to both bridges
      p.stroke([[7, 56], [10, 48], [11, 36], [11.5, 24]], 2, Terrain.Road, 0, OPEN);
      p.stroke([[8, 57], [18, 53], [28, 50], [32, 45]], 2, Terrain.Road, 0, OPEN);
      // obsidian spires and dead woods
      p.blob(20, 58, 2.2, Terrain.Rock, 0.4, OPEN);
      p.blob(3, 42, 2.4, Terrain.Rock, 0.4, OPEN);
      p.blob(31.5, 31.5, 2.2, Terrain.Rock, 0.3, OPEN);
      p.blob(22, 31, 2.4, Terrain.Forest, 0.45, OPEN);
      p.blob(16, 44, 2.8, Terrain.Forest, 0.45, OPEN);
      p.blob(4, 5, 3, Terrain.Forest, 0.45, OPEN);
      // resources: home, safe expansion, contested crystal on the centre plateau
      p.blob(14, 51, 2.2, Terrain.Scrap, 0.25);
      p.blob(4, 32, 1.8, Terrain.Scrap, 0.25);
      p.blob(24, 24, 1.6, Terrain.Crystal, 0.2, LAND);
      p.blob(17, 12, 1.8, Terrain.Scrap, 0.25, LAND);
    }
  },
  {
    id: "proving-grounds",
    name: "Proving Grounds",
    biome: "temperate",
    size: 48,
    blurb: "The classic: rock ridges, one contested field. Learn the ropes here.",
    hq: [4, 40],
    seed: 5,
    paint() {
      /* painted by createClassicTerrain (kept tile-exact for the test suite) */
    }
  }
];

export const mapById = (id: string): MapDef => MAPS.find((m) => m.id === id) ?? MAPS[0]!;

/** The original MVP map layout, tile for tile. */
function createClassicTerrain(w: World): void {
  const S = w.width;
  const mirror = (tx: number, ty: number): Pt => [S - 1 - tx, S - 1 - ty];
  const both = (tx: number, ty: number, t: Terrain) => {
    if (inBounds(w, tx, ty)) setTerrain(w, tx, ty, t);
    const [mx, my] = mirror(tx, ty);
    if (inBounds(w, mx, my)) setTerrain(w, mx, my, t);
  };
  // Central ridge with two gaps (chokepoints), running NW–SE across the middle.
  for (let i = -14; i <= 14; i++) {
    const tx = 24 + i;
    const ty = 24 - Math.round(i * 0.35);
    if (Math.abs(i) === 5 || Math.abs(i) === 6) continue; // the gaps
    both(tx, ty, Terrain.Rock);
    both(tx, ty + 1, Terrain.Rock);
  }
  // Rock clusters shielding each base's flank.
  for (const [cx, cy] of [
    [14, 30],
    [30, 42]
  ] as const)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (Math.abs(dx) + Math.abs(dy) < 2) both(cx + dx, cy + dy, Terrain.Rock);
  // Home scrap field near the blue base (mirrored for red).
  for (let ty = 36; ty <= 38; ty++) for (let tx = 12; tx <= 14; tx++) both(tx, ty, Terrain.Scrap);
  // Contested central field (self-mirroring around the centre).
  for (let ty = 22; ty <= 25; ty++)
    for (let tx = 22; tx <= 25; tx++)
      if (w.terrain[ty * S + tx] === Terrain.Ground) setTerrain(w, tx, ty, Terrain.Scrap);
}

/**
 * Per-match setup beyond the map itself. Every field is optional and the
 * defaults reproduce the classic skirmish start exactly (tests rely on it).
 */
export interface MatchOptions {
  /** Match seed for deterministic randomness (see rand.ts). Default: the map's seed. */
  seed?: number;
  /** Last Stand: no red base; a wave director attacks blue instead (modes/survival.ts). */
  survival?: SurvivalOptions;
  /** Match mutators for both sides (rules.ts). */
  mutators?: MutatorId[];
  /** Ops: play this scenario (ops.ts) — its own rules, enemy, setup and goals. */
  op?: string;
}

/** Build a ready-to-play world for a map: terrain, HQs, starting harvesters. */
export function createMapWorld(id: string, opts: MatchOptions = {}): World {
  const def = mapById(id);
  const w = createWorld(def.size, def.size);
  w.mapId = def.id;
  w.biome = def.biome;
  w.seed = (opts.seed ?? def.seed) >>> 0;
  if (def.id === "proving-grounds") createClassicTerrain(w);
  else {
    def.paint(new Painter(w, def.seed));
    clearBase(w, def);
  }
  const [hx, hy] = def.hq;
  const hs = BUILDINGS.hq.size;
  const rx = def.size - hx - hs;
  const ry = def.size - hy - hs;
  spawnBuilding(w, "hq", "blue", hx, hy);
  spawnBuilding(w, "hq", "red", rx, ry);
  // starting harvester just east of each HQ (mirrored: west of red's)
  spawnUnit(w, "harvester", "blue", hx + hs + 1.5, hy + 1.5);
  spawnUnit(w, "harvester", "red", rx - 1.5, ry + 1.5);
  if (opts.mutators?.length) applyMutators(w, opts.mutators);
  if (opts.survival) setupSurvival(w, opts.survival);
  if (opts.op) setupOp(w, opts.op);
  return w;
}

/** Guarantee open, buildable ground around each HQ. */
function clearBase(w: World, def: MapDef): void {
  const [hx, hy] = def.hq;
  const cx = hx + 1.5;
  const cy = hy + 1.5;
  const keep = new Set<Terrain>([Terrain.Road, Terrain.Scrap, Terrain.Crystal]);
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
      if (d > 5.2) continue;
      for (const [x, y] of [
        [tx, ty],
        [w.width - 1 - tx, w.height - 1 - ty]
      ] as Pt[])
        if (!keep.has(terrainAt(w, x, y))) setTerrain(w, x, y, Terrain.Ground);
    }
}
