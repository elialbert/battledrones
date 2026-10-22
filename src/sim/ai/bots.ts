/**
 * Bots: every AI that can take a seat, by id. The arena seats them as
 * `bot:<id>` or `bot:<id>:<difficulty>` (AGENT-BATTLES.md "Bot seats"), to
 * play a model or each other (tools/arena.ts league). `@apm=<n>` after either
 * caps its actions per minute (ai/apm.ts, APM-BOTS.md).
 *
 * Every bot plays by the same rules and fog of war as a player: it reads the
 * world as its side could see it and returns ordinary commands. None gets an
 * income handicap. A difficulty changes only how a bot plays.
 *
 * A new bot is a module under src/sim/ai/ and an entry in BOTS: BOTS.md
 * says how. It must be deterministic: no Math.random or clocks (a seeded RNG
 * from `seed`), and src/sim's fmath instead of Math.hypot and friends
 * (tests/fmath.test.ts). Records keep the commands, not the bot, so replays
 * never re-run it.
 */
import { createAiState, tickAi, STRATEGIES, type Difficulty, type StrategyName } from "./commander";
import { PROFILES, scriptedPlayer, type ProfileName } from "./player";
import { pickAiOpener, type OpenerId } from "../openers";
import type { Command, Faction, World } from "../types";

/** A bot playing one side of one match. */
export interface Bot {
  /** This tick's commands (called every tick; most ticks it has none). */
  tick(w: World): Command[];
  /**
   * Under an APM cap (ai/apm.ts capApm), the commands of this tick's that got
   * through: the first ones, the rest dropped. Uncapped, everything it returns
   * is sent and this isn't called.
   */
  sent?(cmds: Command[]): void;
}

export interface BotDef {
  id: string;
  /** Short name for menus and logs. */
  label: string;
  /** One line on how it plays (the menu picker's tooltip, `tools/arena.ts bots`). */
  about: string;
  /** The heading it's listed under in the menu's picker ("Commander", "Scripted player"…). */
  group: string;
  /** Does `difficulty` change how it plays? (Scripted players have one speed.) */
  difficulties: boolean;
  /** Its quick-start opener for a match with this seed. */
  opener(seed: number, side: Faction): OpenerId;
  /** `seed` feeds its tie-break RNG. */
  create(side: Faction, seed: number, difficulty: Difficulty): Bot;
}

const ABOUT: Record<StrategyName, string> = {
  balanced: "The built-in commander's steady macro: factory, airpad, tech, an Assembly Bay, standard waves",
  rush: "The commander's early ground pressure: Stinger raids, early Troopers, two factories, small waves",
  airswarm: "The commander's Airpad first: relentless Wasp raids, bombers later",
  boom: "The commander's greedy economy: a forward depot and a huge late push",
  skyforce: "The commander's air force: Wasps, Raptors and Hornets, the Fab Plant only guards home",
  ironclad: "The commander's armoured column: an early Tech Lab, Mastodons with Rocket Squad escorts"
};

function commanderBot(name: StrategyName): BotDef {
  return {
    id: name,
    label: STRATEGIES[name].label,
    about: ABOUT[name],
    group: "Commander",
    difficulties: true,
    opener: (seed, side) => pickAiOpener(name, seed, side),
    create(side, seed, difficulty) {
      const s = createAiState(name, difficulty, seed);
      s.fair = true;
      return { tick: (w) => tickAi(w, side, s) };
    }
  };
}

const PLAYER_ABOUT: Record<ProfileName, string> = {
  novice: "A first-week phone player: looks every 4 s, never techs, attacks at 8:00",
  beginner: "A patient beginner: steady macro, turrets, one big push from 7:00",
  decent: "A decent player: the beginner's macro, a look every second, attacks with 8+ units"
};

function playerBot(name: ProfileName): BotDef {
  return {
    id: name,
    label: `${name[0]!.toUpperCase()}${name.slice(1)} player`,
    about: PLAYER_ABOUT[name],
    group: "Scripted player",
    difficulties: false,
    // any of the three, seeded (as the Balanced commander picks)
    opener: (seed, side) => pickAiOpener("balanced", seed, side),
    create(side) {
      return { tick: scriptedPlayer(PROFILES[name], side) };
    }
  };
}

/** Every bot, in the order the menu's picker and `tools/arena.ts bots` list them. */
const ALL: BotDef[] = [
  ...(Object.keys(STRATEGIES) as StrategyName[]).map(commanderBot),
  ...(Object.keys(PROFILES) as ProfileName[]).map(playerBot)
];

export const BOTS: Record<string, BotDef> = Object.fromEntries(ALL.map((b) => [b.id, b]));

export const BOT_IDS: string[] = Object.keys(BOTS);

export const isBotId = (s: string): boolean => Object.hasOwn(BOTS, s);

/** A bot's seat in a battle record: "bot:rush:hard", "bot:novice" for one with no difficulties, "bot:rush:hard@apm=100" capped. */
export const botSeat = (id: string, difficulty: Difficulty, apm?: number): string =>
  `${BOTS[id]!.difficulties ? `bot:${id}:${difficulty}` : `bot:${id}`}${apm ? `@apm=${apm}` : ""}`;
