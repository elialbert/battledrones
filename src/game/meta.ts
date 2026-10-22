import { capApm } from "../sim/ai/apm";
import { BOTS, botSeat, isBotId, type Bot } from "../sim/ai/bots";
import { DIFFICULTY, STRATEGIES, type AiState, type Difficulty, type StrategyName } from "../sim/ai/commander";
import type { OpenerId } from "../sim/openers";
import { MARSHAL, MARSHAL_POOL, marshal, marshalPlan, planStrategy } from "../sim/ai/marshal";
import { opAiState } from "../sim/ops";
import { MUTATORS, makeRules, rulesOf, strategyFits } from "../sim/rules";
import type { Faction, World } from "../sim/types";
import { announce } from "./announce";
import { settleMatch, type Settlement } from "./career";
import { activeMutators, gameMode } from "./mode";

/**
 * Glue between the match and the meta layer (mutators, Daily Op, career):
 * the AI personality the rules allow, the opening rules banner, and banking
 * the result when the HQ falls. Kept out of GameScene so it stays a few hooks.
 */

/**
 * The AI personality for a commander: the Daily Op's, or (with mutators on)
 * a random one from the difficulty's pool whose plan survives the rules.
 * Undefined = let createAiState pick as usual.
 */
export function aiStrategy(difficulty: Difficulty): StrategyName | undefined {
  if (gameMode.daily) return gameMode.daily.strategy;
  const muts = activeMutators();
  if (muts.length === 0) return undefined;
  const rules = makeRules(muts);
  const pool = DIFFICULTY[difficulty].pool.filter((n) => strategyFits(STRATEGIES[n], rules));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "balanced";
}

/**
 * The menu's difficulty (🎲 Random opponent, the Daily Op): Marshal at that
 * difficulty, fair and on a human's budget of actions (ai/marshal.ts),
 * drawing a plan the rules allow, or playing the Daily Op's personality.
 */
export function difficultyBot(side: Faction): WatchedBot {
  const difficulty = gameMode.difficulty;
  const s = aiSeed(side === "blue" ? 2 : 1);
  const rules = makeRules(activeMutators());
  const plan = gameMode.daily
    ? gameMode.daily.strategy
    : marshalPlan(s, difficulty, MARSHAL_POOL[difficulty].filter((n) => strategyFits(planStrategy(n, MARSHAL[difficulty].fast), rules)));
  const bot = marshal(side, s, difficulty, { ...MARSHAL[difficulty], strategy: plan });
  const label = planStrategy(plan).label;
  return {
    bot: capApm(bot, MARSHAL[difficulty].apm, MARSHAL[difficulty].burst),
    label,
    versus: `vs ${label} AI (${DIFFICULTY[difficulty].label})`,
    opener: bot.opener!,
    seat: botSeat("marshal", difficulty),
    ladder: true
  };
}

/** A bot on one side of a match (AI vs AI, or the opponent picked on the menu): what it is, its opener, and the record's name for it. */
export interface WatchedBot {
  bot: Bot;
  /** "Rush", "Novice player". */
  label: string;
  /** "vs Rush bot · Hard", "vs Novice player bot": a picked opponent on the opener cards, pause screen and report. */
  versus: string;
  opener: OpenerId;
  seat: string;
  /** The menu's difficulty, not a picked opponent: the career ladder, its tips and stars (difficultyBot). */
  ladder?: boolean;
}

function seatBot(id: string, side: Faction, seed: number, difficulty: Difficulty): WatchedBot {
  const def = BOTS[id]!;
  const bot = def.create(side, aiSeed(side === "blue" ? 2 : 1), difficulty);
  const apm = def.apm?.(difficulty); // (a bot built for a budget plays under it, as in the arena)
  return {
    bot: apm ? capApm(bot, apm, def.burst?.(difficulty)) : bot,
    label: def.label,
    versus: `vs ${def.label} bot${def.difficulties ? ` · ${DIFFICULTY[difficulty].label}` : ""}`,
    opener: bot.opener ?? def.opener(seed, side),
    seat: botSeat(id, difficulty)
  };
}

/** Is the coming skirmish against a bot picked on the menu (not 🎲 the classic commander)? */
export const opponentPicked = (): boolean =>
  gameMode.mode === "skirmish" && !gameMode.spectator && !gameMode.daily && !gameMode.op && isBotId(gameMode.opponent);

/**
 * The menu's picked opponent for `side`, at the menu's difficulty if it takes
 * one. It plays fair: no income handicap (🎲 Random keeps the classic one).
 */
export function opponentBot(side: Faction, seed: number): WatchedBot | null {
  if (!opponentPicked()) return null;
  const def = BOTS[gameMode.opponent]!;
  return seatBot(def.id, side, seed, def.difficulties ? gameMode.difficulty : "normal");
}

/**
 * The bot watching puts on `side`: the menu's pick in a skirmish, else (and
 * for "random") a Normal commander whose plan the rules allow, as before.
 */
export function watchBot(side: Faction, seed: number): WatchedBot {
  const pick = gameMode.watch[side];
  const picked = gameMode.mode === "skirmish" && !gameMode.daily && isBotId(pick);
  const pool = DIFFICULTY.normal.pool;
  const id = picked ? pick : aiStrategy("normal") ?? pool[Math.floor(Math.random() * pool.length)]!;
  return seatBot(id, side, seed, "normal");
}

/** Seed for the AI's tie-breaks: the Daily Op's (same match for everyone) or random. */
export const aiSeed = (salt: number): number =>
  gameMode.daily ? (gameMode.daily.seed + salt) | 0 : (Math.random() * 1e9) | 0;

/** "💥 Glass Cannons · ⚡ Blitz" for the active rules ("" if classic). */
export function mutatorLine(w: World, sep = " · "): string {
  return rulesOf(w)
    .mutators.map((id) => `${MUTATORS[id].icon} ${MUTATORS[id].name}`)
    .join(sep);
}

/** An op's enemy commander (null outside ops, or when the op has none: waves or no enemy). */
export const opEnemyAi = (): AiState | null => (gameMode.op ? opAiState(gameMode.op, aiSeed(1)) : null);

/** Opening banner naming the Daily Op and/or the mutators in play. */
export function announceRules(w: World): void {
  if (w.ops) return; // an op opens with its own briefing banner (game/ops.ts)
  const line = mutatorLine(w);
  const d = gameMode.daily;
  if (!line && !d) return;
  announce({
    key: "match-rules",
    text: d ? `Daily Op #${d.number}` : "Mutators active",
    sub: line,
    tone: "info",
    priority: 1
  });
}

/** Bank the finished match in the career (spectators never do, nor a match against a picked opponent: stars are for the classic AI). */
export function settleCareer(w: World, pov: Faction): Settlement | null {
  if (gameMode.spectator || opponentPicked()) return null;
  const d = gameMode.daily;
  return settleMatch(w, {
    pov,
    difficulty: w.survival?.difficulty ?? gameMode.difficulty,
    daily: d ? { day: d.day, number: d.number } : null
  });
}
