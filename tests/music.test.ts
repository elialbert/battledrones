import { describe, expect, it } from "vitest";
import { parseAudioSettings } from "../src/game/audio";
import {
  BattleMood,
  Composer,
  FLAVOURS,
  LAYERS,
  MUSIC,
  arpBar,
  bassBar,
  bellRange,
  chordPcs,
  coinKey,
  coinPitchIn,
  drumBar,
  layerTargets,
  melodyPlays,
  phrase,
  rng,
  stinger,
  voiceLead,
  type MixState,
  type MoodHooks,
  type NoteEvent
} from "../src/game/score";
import type { FxEvent } from "../src/sim/types";

const mod12 = (n: number) => ((n % 12) + 12) % 12;
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const names = (pcs: number[]) => pcs.map((p) => NAMES[p]).join(" ");

describe("harmony", () => {
  it("builds each biome's chords in its mode", () => {
    const t = FLAVOURS.temperate;
    expect(t.progression.map((d) => names(chordPcs(t, d)))).toEqual(["D F A C", "F A C E", "C E G B", "G B D F"]);
    const d = FLAVOURS.desert;
    expect(d.progression.map((x) => names(chordPcs(d, x)))).toEqual(["E Ab B", "F A C", "A C E", "D F A"]);
    const a = FLAVOURS.arctic;
    expect(names(chordPcs(a, 0))).toBe("F A C E"); // Fmaj7: lydian shimmer
    expect(names(chordPcs(a, 1))).toBe("G B D F"); // the lydian II
    const v = FLAVOURS.volcanic;
    expect(v.progression.map((x) => names(chordPcs(v, x)))).toEqual(["C Eb G", "Ab C Eb", "Eb G Bb", "Bb D F"]);
  });

  it("voice-leads every progression smoothly, in range, with no clashes", () => {
    for (const f of Object.values(FLAVOURS)) {
      let prev: number[] | null = null;
      for (let k = 0; k < 12; k++) {
        const pcs = chordPcs(f, f.progression[k % f.progression.length]!);
        const v = voiceLead(prev, pcs, MUSIC.padLo, MUSIC.padHi);
        expect(v).toHaveLength(4);
        expect([...v].sort((a, b) => a - b)).toEqual(v);
        for (const m of v) {
          expect(m).toBeGreaterThanOrEqual(MUSIC.padLo);
          expect(m).toBeLessThanOrEqual(MUSIC.padHi);
          expect(pcs).toContain(mod12(m));
        }
        // every chord tone sounds
        for (const pc of pcs) expect(v.map(mod12)).toContain(pc);
        // no minor seconds / ninths, no voices closer than a tone, no 7th in the bass
        for (let a = 0; a < 4; a++)
          for (let b = a + 1; b < 4; b++) {
            expect(v[b]! - v[a]!).toBeGreaterThanOrEqual(2);
            expect((v[b]! - v[a]!) % 12).not.toBe(1);
          }
        if (pcs.length === 4) expect(mod12(v[0]!)).not.toBe(pcs[3]);
        if (prev) {
          let total = 0;
          for (let i = 0; i < 4; i++) {
            const move = Math.abs(v[i]! - prev[i]!);
            expect(move).toBeLessThanOrEqual(7);
            total += move;
          }
          expect(total).toBeLessThanOrEqual(14);
        }
        prev = v;
      }
    }
  });
});

describe("melody", () => {
  it("walks the motif through the scale, landing strong beats on chord tones", () => {
    for (const f of Object.values(FLAVOURS)) {
      const scale = new Set(f.mode.map((o) => mod12(f.tonic + o)));
      const [lo, hi] = bellRange(f);
      const r = rng(7);
      let prev: number | null = null;
      for (let i = 0; i < 8; i++) {
        const d = f.progression[i % f.progression.length]!;
        const pcs = chordPcs(f, d);
        const notes = phrase(f, d, i, prev, r);
        expect(notes).toHaveLength(f.motif.length);
        for (const n of notes) {
          expect(n.midi).toBeGreaterThanOrEqual(lo);
          expect(n.midi).toBeLessThanOrEqual(hi);
          expect(scale.has(mod12(n.midi))).toBe(true);
          if (n.step % 8 === 0) expect(pcs).toContain(mod12(n.midi));
        }
        // no leaps wider than an octave between neighbours
        for (let k = 1; k < notes.length; k++) expect(Math.abs(notes[k]!.midi - notes[k - 1]!.midi)).toBeLessThanOrEqual(12);
        // answers resolve to the chord's root or fifth
        if (i % 2 === 1) expect([pcs[0], pcs[2]]).toContain(mod12(notes[notes.length - 1]!.midi));
        prev = notes[notes.length - 1]!.midi;
      }
    }
  });

  it("is reproducible from a seed and rests every other pair of phrases", () => {
    const f = FLAVOURS.temperate;
    expect(phrase(f, 0, 0, null, rng(3))).toEqual(phrase(f, 0, 0, null, rng(3)));
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(melodyPlays)).toEqual([true, true, false, false, true, true, false, false]);
  });
});

describe("patterns", () => {
  it("gives every biome a full bar of drums, with fills and half-time where it should", () => {
    for (const f of Object.values(FLAVOURS))
      for (const level of [1, 2] as const)
        for (const bar of [0, 3]) for (const steps of Object.values(drumBar(f, level, bar))) expect(steps).toHaveLength(16);
    const hits = (a: number[] | undefined) => (a ?? []).filter((v) => v > 0).length;
    const t = FLAVOURS.temperate;
    expect(hits(drumBar(t, 2, 3).snare)).toBeGreaterThan(hits(drumBar(t, 2, 0).snare)); // fill
    expect(hits(drumBar(t, 2, 0).hat)).toBeGreaterThan(hits(drumBar(t, 1, 0).hat)); // 16th hats when it's big
    expect(hits(drumBar(FLAVOURS.arctic, 1, 0).snare)).toBeLessThan(hits(drumBar(t, 1, 0).snare)); // half-time
    expect(hits(drumBar(FLAVOURS.desert, 1, 0).tak)).toBeGreaterThan(0); // tabla
    expect(hits(drumBar(FLAVOURS.volcanic, 2, 3).tom)).toBeGreaterThan(0); // tom fill
  });

  it("drives the bass harder at level 2", () => {
    for (const f of Object.values(FLAVOURS)) {
      const a = bassBar(f, 1);
      const b = bassBar(f, 2);
      expect(b.length).toBeGreaterThan(a.length);
      for (const h of [...a, ...b]) {
        expect(h.step).toBeGreaterThanOrEqual(0);
        expect(h.step + h.len).toBeLessThanOrEqual(16);
        expect(h.len).toBeGreaterThan(0);
        expect([0, 7, 12]).toContain(h.interval);
      }
      expect(a[0]!.step).toBe(0); // always on the downbeat
    }
  });

  it("arpeggiates the voicing, swapping in a tritone during an alarm", () => {
    const v = [50, 57, 62, 65];
    const calm = arpBar(v, 2, false);
    expect(calm).toHaveLength(16);
    for (const m of calm) expect(m).toBeLessThanOrEqual(96);
    const alarm = arpBar(v, 2, true);
    const root = Math.min(...alarm);
    expect(mod12(root)).toBe(2);
    expect(alarm).toContain(root + 6);
  });
});

describe("layers", () => {
  it("adds bass, then drums, then the arp as intensity rises; the melody steps aside", () => {
    const at = (i: number) => layerTargets("battle", i, false);
    expect(at(0)).toMatchObject({ pad: 1, bell: 1, bass: 0, drums: 0, arp: 0 });
    let prev = at(0);
    for (let i = 0.05; i <= 1.001; i += 0.05) {
      const cur = at(i);
      expect(cur.bass).toBeGreaterThanOrEqual(prev.bass);
      expect(cur.drums).toBeGreaterThanOrEqual(prev.drums);
      expect(cur.arp).toBeGreaterThanOrEqual(prev.arp);
      expect(cur.bell).toBeLessThanOrEqual(prev.bell);
      expect(cur.pad).toBeGreaterThan(0.5);
      prev = cur;
    }
    expect(at(0.3).bass).toBeGreaterThan(0.5);
    expect(at(0.3).drums).toBe(0);
    expect(at(0.6).drums).toBe(1);
    expect(at(0.6).arp).toBe(0);
    expect(at(1)).toMatchObject({ bass: 1, drums: 1, arp: 1, bell: 0 });
    expect(layerTargets("battle", 0.1, true).arp).toBeGreaterThan(0.5);
    expect(layerTargets("menu", 1, true)).toMatchObject({ bass: 0, drums: 0 });
    expect(layerTargets("end", 1, true)).toMatchObject({ bass: 0, drums: 0, arp: 0 });
  });
});

describe("composer", () => {
  const run = (c: Composer, steps: number, mix: (s: number) => MixState) => {
    const out: { step: number; ev: NoteEvent[] }[] = [];
    for (let s = 0; s < steps; s++) out.push({ step: s, ev: c.next(mix(s)) });
    return out;
  };

  it("opens layers only on bar lines, and drums arrive with a crash", () => {
    const c = new Composer(FLAVOURS.temperate, 1);
    const log = run(c, 96, (s) => ({ mode: "battle", intensity: s < 21 ? 0 : 0.9, alarm: false }));
    const gates = log.flatMap(({ step, ev }) => ev.filter((e) => e.kind === "gate").map((e) => ({ step, e })));
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) expect(g.step % 16).toBe(0);
    const drumsOn = gates.find((g) => g.e.kind === "gate" && g.e.layer === "drums" && g.e.on)!;
    expect(drumsOn.step).toBe(32); // intensity rose mid-bar 2: the drums wait for bar 3
    expect(log[32]!.ev).toContainEqual({ kind: "drum", voice: "crash", vel: 0.8 });
    // nothing from a closed layer
    for (const { step, ev } of log)
      if (step < 32) expect(ev.some((e) => e.kind === "drum" || e.kind === "bass" || e.kind === "arp")).toBe(false);
    expect(log.slice(32).some(({ ev }) => ev.some((e) => e.kind === "arp"))).toBe(true);
  });

  it("changes chord every two bars and plays the calm melody only while calm", () => {
    const c = new Composer(FLAVOURS.desert, 2);
    const log = run(c, 32 * 8, () => ({ mode: "battle", intensity: 0, alarm: false }));
    const chords = log.filter(({ ev }) => ev.some((e) => e.kind === "chord")).map((x) => x.step);
    expect(chords).toEqual([0, 32, 64, 96, 128, 160, 192, 224]);
    const bells = log.filter(({ ev }) => ev.some((e) => e.kind === "bell")).map((x) => Math.floor(x.step / 32));
    expect(new Set(bells)).toEqual(new Set([0, 1, 4, 5]));
    const c2 = new Composer(FLAVOURS.desert, 2);
    const loud = run(c2, 32 * 4, () => ({ mode: "battle", intensity: 1, alarm: false }));
    expect(loud.some(({ ev }) => ev.some((e) => e.kind === "bell"))).toBe(false);
  });

  it("switches biome and tempo on a bar line", () => {
    const c = new Composer(FLAVOURS.temperate, 3);
    run(c, 5, () => ({ mode: "menu", intensity: 0, alarm: false }));
    expect(c.bpm).toBe(MUSIC.menuBpm);
    c.setFlavour(FLAVOURS.arctic);
    run(c, 11, () => ({ mode: "battle", intensity: 0, alarm: false })); // steps 5–15
    expect(c.flavour.biome).toBe("temperate"); // still finishing the bar
    const ev = c.next({ mode: "battle", intensity: 0, alarm: false });
    expect(c.flavour.biome).toBe("arctic");
    expect(c.bpm).toBe(MUSIC.battleBpm);
    expect(c.stepSeconds).toBeCloseTo(60 / 96 / 4);
    expect(ev.find((e) => e.kind === "chord")).toMatchObject({ kind: "chord", root: 5 }); // F
  });

  it("closes the band and holds the tonic for the finale", () => {
    const c = new Composer(FLAVOURS.volcanic, 4);
    run(c, 48, () => ({ mode: "battle", intensity: 1, alarm: false }));
    expect(c.gates.drums).toBe(true);
    const closed = c.closeGates();
    expect(closed.map((e) => e.kind === "gate" && e.layer).sort()).toEqual(["arp", "bass", "drums"]);
    for (const l of LAYERS) expect(c.gates[l]).toBe(l === "pad");
    const hold = c.holdTonic(false, 64);
    expect(hold.notes.map(mod12).sort()).toEqual([0, 0, 3, 7].sort((a, b) => a - b)); // C minor
    const log = run(c, 60, () => ({ mode: "end", intensity: 1, alarm: false }));
    expect(log.some(({ ev }) => ev.some((e) => e.kind === "chord"))).toBe(false);
    expect(log.some(({ ev }) => ev.some((e) => e.kind === "drum" || e.kind === "bass"))).toBe(false);
  });
});

describe("stingers", () => {
  it("resolves victory on the tonic major and descends to the tonic for defeat", () => {
    for (const f of Object.values(FLAVOURS)) {
      const v = stinger("victory", f, 0);
      const last = v.filter((n) => n.voice === "brass").sort((a, b) => b.beat - a.beat)[0]!;
      const pcs = new Set(last.midi.map(mod12));
      const t = mod12(f.tonic);
      expect(pcs).toEqual(new Set([t, mod12(t + 4), mod12(t + 7)]));
      const lament = stinger("defeat", f, 0).filter((n) => n.voice === "lead").map((n) => n.midi[0]!);
      for (let i = 1; i < lament.length; i++) expect(lament[i]!).toBeLessThan(lament[i - 1]!);
      expect(mod12(lament[lament.length - 1]!)).toBe(t);
      for (const k of ["epic", "bad", "good", "first-blood"] as const)
        for (const n of stinger(k, f, chordPcs(f, 2)[0]!)) {
          expect(n.len).toBeGreaterThan(0);
          for (const m of n.midi) expect(m).toBeGreaterThan(12);
        }
    }
  });
});

describe("coin tuning", () => {
  it("keeps both tones of every streak step in the biome's scale, climbing to an octave", () => {
    const COIN = 88; // the coin recipe's E6 (1320 Hz), with a partner a fourth above
    for (const f of Object.values(FLAVOURS)) {
      const scale = new Set(f.mode.map((o) => mod12(f.tonic + o)));
      const k = coinKey(f.biome);
      for (const s of k.steps) {
        expect(scale.has(mod12(COIN + k.shift + s))).toBe(true);
        expect(scale.has(mod12(COIN + k.shift + s + 5))).toBe(true);
      }
      expect(k.steps[0]).toBe(0);
      expect(k.steps[k.steps.length - 1]).toBe(12);
      for (let i = 1; i < k.steps.length; i++) expect(k.steps[i]!).toBeGreaterThan(k.steps[i - 1]!);
      expect(coinPitchIn(f.biome, 99)).toBeCloseTo(2 * coinPitchIn(f.biome, 0)); // capped at the octave
    }
  });
});

// ----------------------------------------------------------------- mood ---

function hooks(over: Partial<MoodHooks> = {}): MoodHooks {
  return {
    player: "blue",
    spectator: false,
    earshot: () => 1,
    sees: () => true,
    factionOf: (id) => (id < 100 ? "blue" : "red"),
    ...over
  };
}
const shot = (sourceId: number, x = 10, y = 10): FxEvent => ({
  type: "shot", fx: "cannon", x, y, tx: x + 1, ty: y, fromAir: false, air: false, sourceId
});
const hit = (faction: "blue" | "red", building: boolean): FxEvent => ({
  type: "hit", faction, id: 5, x: 3, y: 3, building, attackerId: 200
});
const death = (faction: "blue" | "red"): FxEvent => ({
  type: "death", id: 6, faction, unitKind: "stinger", buildingKind: null, x: 4, y: 4, air: false,
  value: 75, killerId: null, killerKind: null, rank: 0, kills: 0
});

describe("battle mood", () => {
  it("is silent without combat and full with a big on-screen fight", () => {
    const m = new BattleMood(hooks());
    expect(m.raw(0)).toBe(0);
    m.events(Array.from({ length: MUSIC.shotsForFull }, () => shot(200)), 1);
    expect(m.raw(1)).toBe(1);
    // the shots age out of the 4 s window
    expect(m.raw(1 + MUSIC.shotWindowS + 0.1)).toBe(0);
  });

  it("only counts shots the player can hear and see", () => {
    const far = new BattleMood(hooks({ earshot: () => 0 }));
    far.events(Array.from({ length: 30 }, () => shot(200)), 1);
    expect(far.raw(1)).toBe(0);
    const fogged = new BattleMood(hooks({ sees: () => false }));
    fogged.events(Array.from({ length: 30 }, () => shot(200)), 1);
    expect(fogged.raw(1)).toBe(0);
    const half = new BattleMood(hooks({ earshot: () => 0.5 }));
    half.events(Array.from({ length: MUSIC.shotsForFull / 2 }, () => shot(200)), 1);
    expect(half.raw(1)).toBeCloseTo(0.25);
  });

  it("keeps a tension floor while our units fight anywhere, and raises the alarm when our base is hit", () => {
    const m = new BattleMood(hooks({ earshot: () => 0 }));
    m.events([shot(7)], 2); // one of ours fires off-screen
    expect(m.raw(2)).toBe(MUSIC.contactFloor);
    expect(m.raw(2 + MUSIC.contactS + 0.1)).toBe(0);
    expect(m.alarm(2)).toBe(false);
    m.events([hit("blue", true)], 20); // a stray shot at a building: no alarm
    expect(m.alarm(20)).toBe(false);
    m.events([hit("blue", true)], 21);
    m.events([hit("blue", true)], 22); // three hits in 4 s: a real attack
    expect(m.alarm(22)).toBe(true);
    expect(m.raw(22)).toBeGreaterThanOrEqual(MUSIC.buildingHitBoost);
    m.events([hit("blue", true)], 26); // a single hit now keeps the running alarm going
    expect(m.alarm(30)).toBe(true);
    expect(m.alarm(26 + MUSIC.buildingHitS + 0.1)).toBe(false);
    // a long siege: the motif is a warning, so it stops after alarmMaxS (the intensity stays up)
    for (let t = 40; t <= 70; t += 2) m.events([hit("blue", true), hit("blue", true), hit("blue", true)], t);
    expect(m.alarm(41)).toBe(true);
    expect(m.alarm(40 + MUSIC.alarmMaxS + 1)).toBe(false);
    expect(m.raw(70)).toBeGreaterThanOrEqual(MUSIC.buildingHitBoost);
    // once it has been quiet for a while, a new attack re-arms it
    m.events([hit("blue", true), hit("blue", true), hit("blue", true)], 90);
    expect(m.alarm(90)).toBe(true);
    // enemy buildings being hit are not our alarm
    const n = new BattleMood(hooks());
    n.events([hit("red", true)], 1);
    expect(n.alarm(1)).toBe(false);
  });

  it("adds our losses", () => {
    const m = new BattleMood(hooks({ earshot: () => 0 }));
    m.events([death("blue"), death("blue"), death("blue"), death("red")], 1);
    // three of our losses add the full +0.25 (deaths alone set no contact floor)
    expect(m.raw(1)).toBeCloseTo(MUSIC.deathBoost);
    expect(m.raw(1 + MUSIC.deathWindowS + 0.1)).toBe(0);
  });

  it("swells fast and settles slowly", () => {
    const m = new BattleMood(hooks());
    m.events(Array.from({ length: MUSIC.shotsForFull }, () => shot(200)), 0);
    for (let i = 0; i < 10; i++) m.update(0.1, 0); // 1 s of a full-on fight
    expect(m.level).toBeGreaterThan(0.8);
    for (let i = 0; i < 30; i++) m.update(0.1, 10); // 3 s after it ended
    expect(m.level).toBeGreaterThan(0.4);
    for (let i = 0; i < 300; i++) m.update(0.1, 20);
    expect(m.level).toBeLessThan(0.02);
  });

  it("gives spectators the on-screen battle with no alarm or contact floor", () => {
    const m = new BattleMood(hooks({ spectator: true, earshot: (x) => (x > 50 ? 0 : 1) }));
    m.events([shot(7, 80, 80)], 1); // a blue shot far off-screen
    expect(m.raw(1)).toBe(0);
    m.events([hit("blue", true), hit("red", true), hit("blue", true)], 2); // an on-screen siege
    expect(m.alarm(2)).toBe(false);
    expect(m.raw(2)).toBeCloseTo(0.3);
    m.events([death("red"), death("blue")], 3);
    expect(m.raw(3)).toBeGreaterThan(0.3);
  });
});

describe("audio settings", () => {
  it("defaults to everything on and migrates the old mute flag", () => {
    expect(parseAudioSettings(null)).toEqual({ muted: false, music: true, sfx: true, voice: true, speech: true });
    expect(parseAudioSettings(null, "1").muted).toBe(true);
    expect(parseAudioSettings(JSON.stringify({ muted: false, music: false }), "1")).toEqual({
      muted: false, music: false, sfx: true, voice: true, speech: true
    });
  });

  it("tolerates junk", () => {
    expect(parseAudioSettings("{nope")).toEqual({ muted: false, music: true, sfx: true, voice: true, speech: true });
    expect(parseAudioSettings(JSON.stringify({ music: "off", voice: false }))).toEqual({
      muted: false, music: true, sfx: true, voice: false, speech: true
    });
    expect(parseAudioSettings("null").music).toBe(true);
  });
});
