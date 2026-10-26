import { botSeat, type Bot } from "../sim/ai/bots";
import { DIFFICULTY, type Difficulty } from "../sim/ai/commander";
import type { OpenerId } from "../sim/openers";
import { MARSHAL, MARSHAL_POOL, marshalPlan, planStrategy, seatMarshal, type PlanName } from "../sim/ai/marshal";
import { MUTATORS, makeRules, rulesOf, strategyFits } from "../sim/rules";
import type { Faction, World } from "../sim/types";
import { announce } from "./announce";
import { settleMatch, type Settlement } from "./career";
import { activeMutators, gameMode } from "./mode";

/**
 * Glue between the match and the meta layer (mutators, Daily Op, career):
 * the AI that takes each seat, the opening rules banner, and banking the
 * result when the HQ falls. Kept out of GameScene so it stays a few hooks.
 *
 * Every AI a player meets is Marshal (APM-BOTS.md),
 * at some difficulty and plan. The stock commanders and scripted players in
 * sim/ai/bots.ts stay for the arena and the tests (an op's tests pilot its
 * enemy as the stock commander, sim/ops.ts opAiState): nothing in the game seats them.
 */

/** Each side's bot seed salt (blue and red's as they always were). */
const BOT_SALT: Record<Faction, number> = { blue: 2, red: 1, green: 3, purple: 4 };

/** `plan`, or ("random", or a plan the rules don't allow) one drawn from the difficulty's pool that the rules allow. */
export function marshalPlanFor(difficulty: Difficulty, plan: PlanName | "random", seed: number): PlanName {
  const rules = makeRules(activeMutators());
  const fits = (n: PlanName) => strategyFits(planStrategy(n, MARSHAL[difficulty].fast), rules);
  return plan !== "random" && fits(plan) ? plan : marshalPlan(seed, difficulty, MARSHAL_POOL[difficulty].filter(fits));
}

/** Marshal at `difficulty` on `side`, playing `plan` (marshalPlanFor). */
function marshalBot(side: Faction, difficulty: Difficulty, plan: PlanName | "random"): WatchedBot {
  const seed = aiSeed(BOT_SALT[side]);
  const strategy = marshalPlanFor(difficulty, plan, seed);
  const bot = seatMarshal(side, seed, difficulty, strategy);
  const label = planStrategy(strategy).label;
  return {
    bot,
    label,
    versus: `vs Marshal · ${label} (${DIFFICULTY[difficulty].label})`,
    opener: bot.opener!,
    seat: botSeat("marshal", difficulty)
  };
}

/** A bot on one side of a match (AI vs AI, or the opponent picked on the menu): what it is, its opener, and the record's name for it. */
export interface WatchedBot {
  bot: Bot;
  /** "Turtle", "Marshal (Rush, Brutal)". */
  label: string;
  /** "vs Marshal · Rush (Hard)": a picked opponent on the opener cards, pause screen and report. */
  versus: string;
  opener: OpenerId;
  seat: string;
  /** The menu's difficulty with no plan picked: the career ladder, its tips and stars (difficultyBot). */
  ladder?: boolean;
}

/**
 * The menu's difficulty (🎲 any plan, the Daily Op): Marshal at that
 * difficulty, fair and on a human's budget of actions (ai/marshal.ts),
 * drawing a plan the rules allow, or playing the Daily Op's personality.
 */
export function difficultyBot(side: Faction): WatchedBot {
  const bot = marshalBot(side, gameMode.difficulty, gameMode.daily ? gameMode.daily.strategy : "random");
  return { ...bot, versus: `vs ${bot.label} AI (${DIFFICULTY[gameMode.difficulty].label})`, ladder: true };
}

/** Is the coming skirmish against a Marshal plan picked on the menu (not 🎲 any plan: the career ladder)? */
export const opponentPicked = (): boolean =>
  gameMode.mode === "skirmish" && !gameMode.spectator && !gameMode.daily && !gameMode.op && gameMode.opponent !== "random";

/** The menu's picked opponent for `side`: Marshal playing the picked plan at the menu's difficulty (null: none picked). */
export function opponentBot(side: Faction): WatchedBot | null {
  return opponentPicked() ? marshalBot(side, gameMode.difficulty, gameMode.opponent) : null;
}

/** The bot watching puts on `side`: Marshal at the difficulty and plan picked for that side on the menu. */
export function watchBot(side: Faction): WatchedBot {
  const m = gameMode.watchMarshal[side];
  const bot = marshalBot(side, m.difficulty, gameMode.daily ? gameMode.daily.strategy : m.plan);
  return { ...bot, label: `Marshal (${bot.label}, ${DIFFICULTY[m.difficulty].label})` };
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

/** An op's enemy: Marshal playing the op's personality, difficulty and tweaks (null outside ops, or when the op has none: waves or no enemy). */
export function opEnemyBot(side: Faction): WatchedBot | null {
  const ai = gameMode.op?.ai;
  if (!ai || ai === "survival") return null;
  const label = planStrategy(ai.strategy).label;
  return {
    bot: seatMarshal(side, aiSeed(BOT_SALT[side]), ai.difficulty, ai.strategy, ai.tweak),
    label,
    versus: `vs Marshal · ${label} (${DIFFICULTY[ai.difficulty].label})`,
    opener: "blitz", // (unused: an op sets up its own start)
    seat: botSeat("marshal", ai.difficulty),
    ladder: true
  };
}

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
