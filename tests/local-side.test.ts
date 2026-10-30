import { afterEach, describe, expect, it } from "vitest";
import { createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { canPlaceBuilding } from "../src/sim/economy";
import { tickFog } from "../src/sim/fog";
import { randomMapId } from "../src/sim/mapgen";
import { createMapWorld } from "../src/sim/maps";
import { allowedOpener, applyOpener, AI_OPENER, type OpenerId } from "../src/sim/openers";
import type { MutatorId } from "../src/sim/rules";
import { setupWorld, type MatchSetup } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { Command, Faction, World } from "../src/sim/types";
import { hqOf } from "../src/sim/world";
import { Controller, ENEMY, PLAYER, setLocalSide } from "../src/game/controller";
import { applyOpenersCanonical, composeTick } from "../src/game/local-side";
import { minimapDot } from "../src/ui/hud";

// (vitest keeps the module between tests: every other test expects to play blue)
afterEach(() => setLocalSide("blue"));

const SIDES: Faction[] = ["blue", "red"];

/** Built-in and random maps, with and without mutators (Nomads: no HQ; Air War: some openers banned). */
const SETUPS: MatchSetup[] = [
  { map: "riverlands", seed: 42, mutators: [], openers: { blue: "blitz", red: "airwing" } },
  { map: "ashlands", seed: 7, mutators: ["nomads"], openers: { red: "industry", blue: "blitz" } },
  { map: randomMapId("volcanic", 0x3a9f), seed: 99, mutators: ["veterans", "goldrush"], openers: { blue: "airwing", red: "industry" } },
  { map: "archipelago", seed: 5, mutators: ["airwar"], openers: { blue: "airwing" } }
];

/** The world a skirmish shows behind the opener cards (GameScene: the map, then a first look at the fog). */
function preview(map: string, seed: number, mutators: MutatorId[]): World {
  const w = createMapWorld(map, { seed, objectives: true, ...(mutators.length ? { mutators } : {}) });
  tickFog(w);
  return w;
}

describe("the local side", () => {
  it("is blue until told otherwise, and the enemy is always the other side", () => {
    expect([PLAYER, ENEMY]).toEqual(["blue", "red"]);
    setLocalSide("red");
    expect([PLAYER, ENEMY]).toEqual(["red", "blue"]);
    setLocalSide("blue");
    expect([PLAYER, ENEMY]).toEqual(["blue", "red"]);
  });

  it("never reaches the match setup: setupWorld builds the same world whoever is local", () => {
    for (const s of SETUPS) {
      const [a, b] = SIDES.map((f) => {
        setLocalSide(f);
        return setupWorld(s);
      });
      expect(worldHash(a!)).toBe(worldHash(b!));
      expect(a).toEqual(b);
    }
  });
});

describe("composeTick", () => {
  const move = (faction: Faction, x: number): Command => ({ type: "move", faction, unitIds: [1], x, y: 1 });

  it("puts blue's commands before red's whichever side is local, each side's in order", () => {
    const blue = [move("blue", 1), move("blue", 2)];
    const red = [move("red", 3), move("red", 4)];
    expect(composeTick("blue", blue, red)).toEqual([...blue, ...red]);
    expect(composeTick("red", red, blue)).toEqual([...blue, ...red]);
    expect(composeTick("red", [], blue)).toEqual(blue);
    expect(composeTick("blue", [], [])).toEqual([]);
  });

  it("leaves the lists it was given alone", () => {
    const mine = [move("red", 1)];
    const theirs = [move("blue", 2)];
    const out = composeTick("red", mine, theirs);
    out.push(move("red", 9));
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
  });

  it(
    "plays a match the same from either seat",
    () => {
      const s = SETUPS[0]!;
      const strategy: Record<"blue" | "red", StrategyName> = { blue: "rush", red: "boom" };
      const trails = SIDES.map((local) => {
        setLocalSide(local);
        const w = setupWorld(s);
        const ai = { blue: createAiState(strategy.blue, "normal", 1), red: createAiState(strategy.red, "normal", 2) };
        const trail: string[] = [];
        // (3 minutes: stepping our own commands first splits the two trails at about 80 s here)
        for (let t = 0; t < 1800 && !w.winner; t++) {
          // (the commanders think in a fixed order: only who counts as "mine" changes)
          const cmds: Partial<Record<Faction, Command[]>> = { blue: tickAi(w, "blue", ai.blue), red: tickAi(w, "red", ai.red) };
          step(w, composeTick(PLAYER, cmds[PLAYER]!, cmds[ENEMY]!));
          trail.push(worldHash(w));
        }
        return trail;
      });
      expect(trails[0]!.length).toBeGreaterThan(0);
      expect(trails[1]).toEqual(trails[0]);
    },
    60_000
  );
});

describe("applyOpenersCanonical", () => {
  it("gives blue's opener first whatever order the picks are listed in", () => {
    for (const s of SETUPS) {
      const [a, b] = SIDES.map((local) => {
        setLocalSide(local);
        const w = preview(s.map, s.seed, s.mutators);
        // (listed ours first, as a phone would)
        const picks: Partial<Record<Faction, OpenerId>> = {};
        if (s.openers[PLAYER]) picks[PLAYER] = s.openers[PLAYER];
        if (s.openers[ENEMY]) picks[ENEMY] = s.openers[ENEMY];
        const applied = applyOpenersCanonical(w, picks);
        if (applied.blue && applied.red) expect(applied.blue.unitIds[0]!).toBeLessThan(applied.red.unitIds[0]!);
        return w;
      });
      expect(worldHash(a!)).toBe(worldHash(b!));
      expect(a).toEqual(b);
    }
  });

  it("is what setupWorld does after the map", () => {
    for (const s of SETUPS) {
      const w = createMapWorld(s.map, { seed: s.seed, objectives: true, ...(s.mutators.length ? { mutators: s.mutators } : {}) });
      applyOpenersCanonical(w, s.openers);
      expect(w).toEqual(setupWorld(s));
    }
  });

  it("sets up single player as blue exactly as before (ours, then the AI's, then the fog)", () => {
    const cases: { map: string; seed: number; mutators: MutatorId[]; pick: OpenerId; ai: StrategyName }[] = [
      { map: "riverlands", seed: 1234, mutators: [], pick: "blitz", ai: "balanced" },
      { map: "dune-sea", seed: 77, mutators: [], pick: "industry", ai: "airswarm" },
      { map: "ashlands", seed: 3, mutators: ["nomads"], pick: "airwing", ai: "ironclad" },
      { map: "frostbite", seed: 31337, mutators: ["airwar"], pick: "airwing", ai: "rush" }, // (the AI's Blitz is banned: it falls back)
      { map: "proving-grounds", seed: 8, mutators: ["infantrywar"], pick: "industry", ai: "boom" }, // (every AI pick banned)
      { map: randomMapId("arctic", 0xbeef), seed: 55, mutators: ["clearskies"], pick: "blitz", ai: "skyforce" }
    ];
    for (const c of cases) {
      // the old GameScene.startWithOpener, step by step
      const before = preview(c.map, c.seed, c.mutators);
      applyOpener(before, "blue", c.pick);
      const red = allowedOpener(before, "red", AI_OPENER);
      if (red) applyOpener(before, "red", red);
      tickFog(before);
      // and the new one
      const after = preview(c.map, c.seed, c.mutators);
      const picks: Partial<Record<Faction, OpenerId>> = { [PLAYER]: c.pick };
      const theirs = allowedOpener(after, ENEMY, AI_OPENER);
      if (theirs) picks[ENEMY] = theirs;
      applyOpenersCanonical(after, picks);
      expect(worldHash(after)).toBe(worldHash(before));
      expect(after).toEqual(before);
    }
  });
});

describe("a red Controller", () => {
  it("issues red commands", () => {
    setLocalSide("red");
    const w = setupWorld({ map: "riverlands", seed: 11, mutators: [], openers: { blue: "blitz", red: "blitz" } });
    const c = new Controller(w);
    c.selectArmy();
    const army = [...c.selectedUnits].map((id) => w.units.get(id)!);
    expect(army.length).toBeGreaterThan(3); // (Blitz's Stingers and the starting squad)
    expect(army.every((u) => u.faction === "red")).toBe(true);
    expect(c.assignSquad(0)).toBe(army.length);

    // march on the blue base, then pick on a blue tank, then hold
    const enemy = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "stinger")!;
    c.tapWorld(w.width / 2, w.height / 2, { kind: "ground" });
    c.tapWorld(enemy.x, enemy.y, { kind: "enemy", id: enemy.id, targetsAir: false });
    c.stopSelected();
    // and build a Turret beside the HQ
    const hq = hqOf(w, "red")!;
    w.factions.red.pending = { kind: "turret", remaining: 0, ready: true };
    c.placing = "turret";
    let spot: { tx: number; ty: number } | null = null;
    for (let r = 2; r < 8 && !spot; r++)
      for (let dy = -r; dy <= r && !spot; dy++)
        for (let dx = -r; dx <= r && !spot; dx++)
          if (canPlaceBuilding(w, "red", "turret", hq.tx + dx, hq.ty + dy)) spot = { tx: hq.tx + dx, ty: hq.ty + dy };
    expect(spot).not.toBeNull();
    c.movePlacement(spot!.tx, spot!.ty, false);
    expect(c.commitPlacement()).toBe(true);

    const cmds = c.drainCommands();
    expect(cmds.map((k) => k.type)).toEqual(["attackMove", "attack", "stop", "placeBuilding"]);
    expect(cmds.every((k) => k.faction === "red")).toBe(true);
    // and the sim carries them out for red
    step(w, composeTick(PLAYER, cmds, []));
    expect([...w.buildings.values()].some((b) => b.faction === "red" && b.kind === "turret")).toBe(true);
    expect(w.factions.red.pending).toBeNull();
  });
});

describe("the minimap's unit blips", () => {
  /** Relative luminance of a #rrggbb colour (sRGB, as the canvas paints it). */
  const luma = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it("look as they always did to blue's player and to a spectator", () => {
    // (the two colours the minimap drew before either side could be local: ours, then the enemy's)
    for (const pov of ["blue", null] as const) expect([minimapDot("blue", pov), minimapDot("red", pov)]).toEqual(["#9fd0ff", "#ffb0a0"]);
  });

  it("keep side colours for red's player, with red's own army the brighter tint", () => {
    // blue is blue and red is red on both phones
    for (const pov of SIDES) {
      const [blue, red] = [minimapDot("blue", pov), minimapDot("red", pov)];
      expect(parseInt(blue.slice(5, 7), 16)).toBeGreaterThan(parseInt(blue.slice(1, 3), 16));
      expect(parseInt(red.slice(1, 3), 16)).toBeGreaterThan(parseInt(red.slice(5, 7), 16));
    }
    // and each side's blips are brighter on its own phone than on the other one
    for (const f of SIDES) {
      const other: Faction = f === "blue" ? "red" : "blue";
      expect(luma(minimapDot(f, f))).toBeGreaterThan(luma(minimapDot(f, other)));
    }
  });
});
