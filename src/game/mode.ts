import type { Difficulty } from "../sim/ai/commander";
import type { MatchOptions } from "../sim/maps";
import { isMutatorId, type MutatorId } from "../sim/rules";
import { opById, type OpDef } from "../sim/ops";
import type { DailyOp } from "./daily";

/** Skirmish (vs an AI commander), Last Stand (survive endless waves) or the Ops campaign. */
export type GameType = "skirmish" | "survival" | "ops";

/** Match settings, chosen on the menu before the game boots. */
export const gameMode = {
  /** AI vs AI: both factions computer-controlled, player just watches. */
  spectator: false,
  mapId: "riverlands",
  difficulty: "normal" as Difficulty,
  mode: "skirmish" as GameType,
  /** Skirmish mutators picked on the menu (saved with the settings). */
  mutators: [] as MutatorId[],
  /** Set while playing the Daily Op (never saved: it overrides map, difficulty and mutators). */
  daily: null as DailyOp | null,
  /** Set while playing an op (never saved: the op fixes map, enemy and rules). */
  op: null as OpDef | null,
  /** The op card picked on the menu (saved). */
  opId: ""
};

/** The mutators the next match runs with (Last Stand runs classic rules). */
export function activeMutators(): MutatorId[] {
  if (gameMode.op) return []; // an op brings its own rules
  if (gameMode.daily) return gameMode.daily.mutators;
  return gameMode.mode === "skirmish" ? gameMode.mutators : [];
}

/** What the end screen's Rematch stores, so the reload replays the same kind of match. */
export const rematchToken = (): string => (gameMode.op ? `op:${gameMode.op.id}` : gameMode.daily ? "daily" : "1");

/**
 * The sim setup for the next match, built from the menu choices. A fresh
 * random seed per match (render side, so Math.random is fine here) keeps
 * seeded events varied while each match stays internally deterministic.
 * Skirmishes play with the map objectives (Uplinks, supply drops).
 */
export function matchOptions(): MatchOptions {
  if (gameMode.op) return { seed: (Math.random() * 0x7fffffff) | 0, op: gameMode.op.id };
  const mutators = activeMutators();
  const survival = gameMode.mode === "survival";
  return {
    seed: (Math.random() * 0x7fffffff) | 0,
    // Uplinks and supply drops: skirmish (and the Daily Op); Last Stand has its waves
    ...(survival ? { survival: { difficulty: gameMode.difficulty } } : { objectives: true }),
    // mutators, and the Daily Op's date seed (everyone plays the same match)
    ...(mutators.length ? { mutators } : {}),
    ...(gameMode.daily ? { seed: gameMode.daily.seed } : {})
  };
}

const KEY = "battledrones.settings";

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as Partial<typeof gameMode>;
    if (typeof s.mapId === "string") gameMode.mapId = s.mapId;
    if (s.difficulty === "easy" || s.difficulty === "normal" || s.difficulty === "hard")
      gameMode.difficulty = s.difficulty;
    if (s.mode === "skirmish" || s.mode === "survival" || s.mode === "ops") gameMode.mode = s.mode;
    if (typeof s.opId === "string" && opById(s.opId)) gameMode.opId = s.opId;
    if (Array.isArray(s.mutators)) gameMode.mutators = s.mutators.filter(isMutatorId);
  } catch {
    /* storage unavailable — defaults are fine */
  }
}

export function saveSettings(): void {
  if (gameMode.daily || gameMode.op) return; // the Daily Op's / an op's map and difficulty are not the player's picks
  try {
    localStorage.setItem(KEY, JSON.stringify({ mapId: gameMode.mapId, difficulty: gameMode.difficulty, mode: gameMode.mode, mutators: gameMode.mutators, opId: gameMode.opId }));
  } catch {
    /* ignore */
  }
}
