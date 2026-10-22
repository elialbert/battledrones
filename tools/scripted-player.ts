// The scripted phone player (src/sim/ai/player.ts) in a match against the AI
// commander, for tools/beginner.ts: blue is the player, red the commander.
import { createAiState, tickAi, type Difficulty, type StrategyName } from "../src/sim/ai/commander";
import { scriptedPlayer, type PlayerProfile } from "../src/sim/ai/player";
import { TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { pickAiOpener, type OpenerId } from "../src/sim/openers";
import { step } from "../src/sim/sim";

export { PROFILES, scriptedPlayer, type PlayerProfile } from "../src/sim/ai/player";

export interface PlayerMatch {
  map: string;
  ai: StrategyName;
  opener: OpenerId;
  winner: string;
  min: number;
}

export function playerMatch(profile: PlayerProfile, map: string, ai: StrategyName, diff: Difficulty, opener: OpenerId, seed: number, maxMin = 25): PlayerMatch {
  const w = createMapWorld(map, { seed, objectives: true, openers: { blue: opener, red: pickAiOpener(ai, seed, "red") } });
  const red = createAiState(ai, diff, seed * 3 + 1);
  const blue = scriptedPlayer(profile);
  for (let i = 0; i < maxMin * 60 * TICK_RATE && !w.winner; i++) step(w, [...blue(w), ...tickAi(w, "red", red)]);
  return { map, ai, opener, winner: w.winner ?? "draw", min: w.tick / TICK_RATE / 60 };
}

