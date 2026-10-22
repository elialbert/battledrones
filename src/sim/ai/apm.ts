/**
 * An actions-per-minute cap for any bot (APM-BOTS.md), the way a human is
 * limited: a token bucket that refills at `apm` actions a minute and holds
 * at most `burst`. Each tick it lets through the first commands it can pay
 * for and drops the rest, so a bot should list its most important commands
 * first. Every command costs one action, even one the sim then refuses.
 *
 * It's deterministic: integer arithmetic on ticks, no clocks. Tokens are
 * counted in 1/(60 × TICK_RATE) of an action, so a tick adds exactly `apm`.
 */
import { TICK_RATE } from "../balance";
import type { Command, World } from "../types";
import type { Bot } from "./bots";

/** The default burst: how many actions a capped bot can bank. */
export const APM_BURST = 10;

const PER_ACTION = 60 * TICK_RATE;

export function capApm(bot: Bot, apm: number, burst = APM_BURST): Bot {
  const cap = burst * PER_ACTION;
  let tokens = cap;
  let last: number | null = null;
  return {
    opener: bot.opener,
    plan: bot.plan,
    tick(w: World): Command[] {
      if (last !== null) tokens = Math.min(cap, tokens + (w.tick - last) * apm);
      last = w.tick;
      const want = bot.tick(w);
      if (!want.length) return want;
      const n = Math.min(want.length, Math.floor(tokens / PER_ACTION));
      tokens -= n * PER_ACTION;
      const sent = n === want.length ? want : want.slice(0, n);
      bot.sent?.(sent);
      return sent;
    }
  };
}
