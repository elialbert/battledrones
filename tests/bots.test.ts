import { describe, expect, it } from "vitest";
import { Arena, SIDES, parseSeat, seatName } from "../src/arena/match";
import { replay, type BattleRecord } from "../src/arena/record";
import { APM_BURST, capApm } from "../src/sim/ai/apm";
import { BOTS, BOT_IDS, type Bot } from "../src/sim/ai/bots";
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

  it("takes an APM cap, @apm=<n>, and names it the same way back", () => {
    expect(parseSeat("bot:ironclad:hard@apm=100")).toEqual({ kind: "bot", bot: "ironclad", difficulty: "hard", apm: 100 });
    expect(parseSeat("bot:decent@apm=40")).toEqual({ kind: "bot", bot: "decent", difficulty: "normal", apm: 40 });
    for (const s of ["bot:ironclad:hard@apm=100", "bot:decent@apm=40", "bot:rush:normal@apm=7"]) expect(seatName(parseSeat(s))).toBe(s);
    expect(seatName(parseSeat("bot:rush@apm=60"))).toBe("bot:rush:normal@apm=60");
    expect(seatName(parseSeat("ai:boom@apm=60"))).toBe("bot:boom:normal@apm=60");
    expect(() => parseSeat("bot:rush@apm=0")).toThrow(/1 or more/);
    expect(parseSeat("bot:rush@apm=fast")).toEqual({ kind: "agent", player: "bot:rush@apm=fast" });
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

describe("an APM cap", () => {
  /** Each command tick of `side`: [tick, commands]. */
  const sends = (r: BattleRecord, side: string) => r.turns.filter(([, s]) => s === side).map(([t, , c]) => [t, c.length] as const);

  /** Over every stretch of ticks, no more than the burst plus what the cap refills. */
  function withinBudget(r: BattleRecord, side: string, apm: number): void {
    const s = sends(r, side);
    for (let i = 0; i < s.length; i++) {
      let n = 0;
      for (let j = i; j < s.length; j++) {
        n += s[j]![1];
        expect(n * 600).toBeLessThanOrEqual(APM_BURST * 600 + (s[j]![0] - s[i]![0]) * apm);
      }
    }
  }

  it("keeps the first commands it can pay for, drops the rest, and says what got through", () => {
    let t = 0;
    const got: number[][] = [];
    const spam: Bot = {
      tick: () => Array.from({ length: 4 }, (_, i) => ({ type: "stop", faction: "blue", unitIds: [t * 10 + i] }) as const),
      sent: (cmds) => got.push(cmds.map((c) => (c.type === "stop" ? c.unitIds[0]! : -1)))
    };
    const capped = capApm(spam, 60); // one action a second, ten banked
    const out: number[][] = [];
    for (t = 0; t < 100; t++) out.push(capped.tick({ tick: t } as never).map((c) => (c.type === "stop" ? c.unitIds[0]! : -1)));
    expect(got).toEqual(out);
    expect(out.slice(0, 4)).toEqual([[0, 1, 2, 3], [10, 11, 12, 13], [20, 21], []]); // the burst, spent in order
    expect(out.flat().length).toBe(10 + 9); // and then one every 10 ticks
    expect(out[10]).toEqual([100]);
  });

  it("holds a real bot to its budget, burst included, and plays the same match twice", () => {
    const play = () => {
      const a = new Arena({ map: "riverlands", seed: 3, seats: { blue: parseSeat("bot:ironclad@apm=30"), red: parseSeat("bot:balanced") }, maxTicks: 4 * 600 });
      while (!a.over) a.advance();
      return JSON.parse(JSON.stringify(a.record)) as BattleRecord;
    };
    const r = play();
    expect(r.seats.blue.player).toBe("bot:ironclad:normal@apm=30");
    const n = sends(r, "blue").reduce((x, [, c]) => x + c, 0);
    expect(n).toBeGreaterThan(30); // it plays, up to the cap
    withinBudget(r, "blue", 30);
    expect(play().turns).toEqual(r.turns);
  });
});
