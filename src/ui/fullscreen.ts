/**
 * Page reloads for Rematch, Retry and Menu.
 * Every reload puts iOS's audio session back to "auto"
 * (resetAudioSession): a sound duel's page sets it to play-and-record, and
 * Safari carries that over to the next page in the tab.
 */

export interface FullscreenEnv {
  /** navigator.audioSession (Safari 16.4 on), or null where there is none. */
  audioSession?: AudioSessionLike | null;
  reload(): void;
}

/** iOS's audio session, as navigator.audioSession has it. */
export interface AudioSessionLike {
  type: string;
}

function browserAudioSession(): AudioSessionLike | null {
  try {
    return (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession ?? null;
  } catch {
    return null; // (no navigator)
  }
}

/**
 * Put iOS's audio session back to "auto", on every way out of a page and at
 * every boot (main.ts). Safari keeps the type a page set across a reload or a
 * navigation in the same tab: WebKit holds it as an override of the whole web
 * process's audio category, and a new document resets only the type it reads
 * back. So after a sound duel's page left play-and-record (src/link/rig.ts),
 * the next page reads "auto" while its audio still runs as a call, and its
 * contexts may take the low rate rig.ts "The rate" describes; only a write
 * clears it. Writing "auto" where nothing else was set changes nothing.
 */
export function resetAudioSession(session: AudioSessionLike | null = browserAudioSession()): void {
  try {
    if (session) session.type = "auto";
  } catch {
    /* ignore */
  }
}

function browserEnv(): FullscreenEnv {
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    /* storage blocked */
  }
  const rematch = () => {
    try {
      return storage?.getItem("battledrones.rematch") ?? null;
    } catch {
      return null;
    }
  };
  return { audioSession: browserAudioSession(), reload: () => reloadWithoutLink(window.location, rematch()) };
}

/** What a replay's link (main.ts watchLinked) and a practice duel's (?duel=loop|relay, SOUND-DUEL.md "Dev and test modes") put in the URL. */
const LINK_PARAMS = ["replay", "follow", "duel", "seat", "delay", "loss", "latency", "side"];

/**
 * Reload, leaving a replay's `?replay=` link and a practice duel's `?duel=`
 * parameters behind: their Menu buttons mean the menu. Only such a page
 * loses `side` too: a single-player `?side=red` reloads as it is (its
 * Rematch and Menu stay red). A duel's Rematch (`rematch`, the token just
 * stored, is "duel") keeps the duel's parameters, so a practice rematch is
 * one again.
 */
export function reloadWithoutLink(loc: Pick<Location, "href" | "reload" | "assign">, rematch: string | null = null): void {
  const url = new URL(loc.href);
  const q = url.searchParams;
  if (!q.has("replay") && (!q.has("duel") || rematch === "duel")) return loc.reload();
  for (const k of LINK_PARAMS) q.delete(k);
  loc.assign(url.href);
}

export class Fullscreen {
  constructor(private env: () => FullscreenEnv = browserEnv) {}

  /** Reload the page (a rematch or the menu), with iOS's audio session back to "auto". */
  reload(): void {
    const env = this.env();
    // (a duel's lobby may still hold the rig here, as at its Reload after a version error; its pagehide closes the rig too)
    resetAudioSession(env.audioSession ?? null);
    env.reload();
  }
}

/** The app's reload helper. */
export const fullscreen = new Fullscreen();
