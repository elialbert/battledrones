import { describe, expect, it } from "vitest";
import { Arena, SIDES, parseSeat, seatName } from "../src/arena/match";
import { replay, type BattleRecord } from "../src/arena/record";
import { BOTS, BOT_IDS } from "../src/sim/ai/bots";
import { STRATEGIES } from "../src/sim/ai/commander";
import { PROFILES } from "../src/sim/ai/player";

describe("bot seats", () => {
  it("names every commander personality and scripted player, each bot once and described", () => {
    expect(BOT_IDS).toEqual(expect.arrayContaining([...Object.keys(STRATEGIES), ...Object.keys(PROFILES)]));
    for (const id of BOT_IDS) {
      const b = BOTS[id]!;
      expect(b.id).toBe(id);
      expect(id).toMatch(/^[a-z]+$/); // (seat names: bot:<id>:<difficulty>)
      expect(id).not.toBe("random"); // (the menu's 🎲 pick)
      expect(b.about.length).toBeGreaterThan(10);
      expect(b.group.length).toBeGreaterThan(0);
    }
  });

  it("parses bot:<id>[:<difficulty>], and ai:… as the old name for a commander bot", () => {
    expect(parseSeat("bot:rush:hard")).toEqual({ kind: "bot", bot: "rush", difficulty: "hard" });
    expect(parseSeat("bot:decent")).toEqual({ kind: "bot", bot: "decent", difficulty: "normal" });
    expect(parseSeat("ai:rush:hard")).toEqual(parseSeat("bot:rush:hard"));
    expect(parseSeat("ai")).toEqual(parseSeat("bot:balanced"));
    expect(parseSeat("claude-opus-5-5")).toEqual({ kind: "agent", player: "claude-opus-5-5" });
    expect(() => parseSeat("bot")).toThrow(/names its bot/);
    expect(() => parseSeat("bot:nope")).toThrow(/unknown bot/);
    expect(() => parseSeat("ai:novice")).toThrow(/unknown AI personality/);
    expect(() => parseSeat("bot:novice:hard")).toThrow(/no difficulties/);
    expect(() => parseSeat("bot:rush:brutal")).toThrow(/unknown difficulty/);
  });

  it("names seats the one way in records", () => {
    expect(seatName(parseSeat("ai:boom"))).toBe("bot:boom:normal");
    expect(seatName(parseSeat("bot:beginner"))).toBe("bot:beginner");
  });
});

describe("every bot plays", () => {
  function play(blue: string, red: string, ticks = 3 * 600): { a: Arena; record: BattleRecord; income: number[] } {
    const a = new Arena({ map: "proving-grounds", seed: 5, seats: { blue: parseSeat(blue), red: parseSeat(red) }, maxTicks: ticks });
    const income: number[] = [];
    while (!a.over) {
      a.advance();
      for (const s of SIDES) income.push(a.w.factions[s].incomeMult);
    }
    return { a, record: JSON.parse(JSON.stringify(a.record)) as BattleRecord, income };
  }

  it.each(BOT_IDS)("%s, on either side, fairly", (id) => {
    const other = id === "balanced" ? "bot:novice" : "bot:balanced:hard";
    for (const [blue, red, side] of [[`bot:${id}`, other, "blue"], [other, `bot:${id}`, "red"]] as const) {
      const { record, income } = play(blue, red);
      const mine = record.turns.filter(([, s]) => s === side);
      expect(mine.length).toBeGreaterThan(5);
      // its commands are its own side's
      for (const [, , cmds] of mine) for (const c of cmds) expect(c.faction).toBe(side);
      expect(new Set(mine.flatMap(([, , cmds]) => cmds.map((c) => c.type)))).toContain("produce");
      // no income handicap on any bot (a Hard commander included)
      expect(record.income).toBeUndefined();
      expect(income.every((m) => m === 1)).toBe(true);
    }
  });

  it("plays the same match twice, and the record replays exactly", () => {
    const r1 = play("bot:decent", "bot:ironclad:easy", 4 * 600).record;
    const r2 = play("bot:decent", "bot:ironclad:easy", 4 * 600).record;
    expect(r1.turns).toEqual(r2.turns);
    expect(r1.seats.blue.player).toBe("bot:decent");
    expect(r1.seats.red.player).toBe("bot:ironclad:easy");
    const res = replay(r1);
    expect(res.divergedAt).toBeNull();
    expect(res.checked).toBe(r1.hashes.length);
  });
});
