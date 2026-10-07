import type { Difficulty } from "../sim/ai/commander";
import type { MatchOptions } from "../sim/maps";

/** Skirmish (vs an AI commander) or Last Stand (survive endless waves). */
export type GameType = "skirmish" | "survival";

/** Match settings, chosen on the menu before the game boots. */
export const gameMode = {
  /** AI vs AI: both factions computer-controlled, player just watches. */
  spectator: false,
  mapId: "riverlands",
  difficulty: "normal" as Difficulty,
  mode: "skirmish" as GameType
};

/**
 * The sim setup for the next match, built from the menu choices. A fresh
 * random seed per match (render side, so Math.random is fine here) keeps
 * seeded events varied while each match stays internally deterministic.
 */
export function matchOptions(): MatchOptions {
  return {
    seed: (Math.random() * 0x7fffffff) | 0,
    ...(gameMode.mode === "survival" ? { survival: { difficulty: gameMode.difficulty } } : {})
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
    if (s.mode === "skirmish" || s.mode === "survival") gameMode.mode = s.mode;
  } catch {
    /* storage unavailable — defaults are fine */
  }
}

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ mapId: gameMode.mapId, difficulty: gameMode.difficulty, mode: gameMode.mode }));
  } catch {
    /* ignore */
  }
}
