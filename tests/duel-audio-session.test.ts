// iOS's audio session across pages (SOUND-DUEL.md "Rig", "Rematch"). Safari
// keeps the type a page set for the next page in the tab: WebKit holds it as
// the web process's audio category override, which a new document doesn't
// reset, while the new page's navigator.audioSession.type reads "auto". So a
// duel's page that goes while its rig holds play-and-record hands the next
// page a voice-chat session (and, by src/link/rig.ts "The rate", contexts
// made under it can take a 16 kHz snapshot). Every way out puts it back
// (ui/fullscreen.ts's reload, the lobby's pagehide), and so does every boot
// (main.ts). Tests against a fake tab that keeps the override as WebKit does.
import { describe, expect, it, vi } from "vitest";

// (the lobby builds the VersusFeed only once a match starts: its game code stays out of these tests)
vi.mock("../src/versus/feed", () => ({ VersusFeed: class {} }));

import { openRig, type RigEnv } from "../src/link/rig";
import { Fullscreen, resetAudioSession, type AudioSessionLike, type FullscreenEnv } from "../src/ui/fullscreen";
import { closeRigOnPageGone } from "../src/versus/lobby";

/** Every module under src/, as text (main.ts's boot, which no test can import). */
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * A Safari tab, as WebKit has it: each page's navigator.audioSession.type is
 * its document's own and starts "auto", but setting it also sets the web
 * process's category override (DOMAudioSession::setType), which outlives the
 * page. The audio a page makes follows the override.
 */
class Tab {
  override = "auto";
  /** A new page in the tab: its navigator.audioSession. */
  page(): AudioSessionLike {
    let type = "auto";
    const tab = this;
    return {
      get type() {
        return type;
      },
      set type(t: string) {
        type = t;
        tab.override = t;
      }
    };
  }
}

/** A window that dispatches page transition events. */
function fakeWindow() {
  const fns = new Map<string, Set<(e: Event) => void>>();
  const win = {
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      if (!fns.has(type)) fns.set(type, new Set());
      fns.get(type)!.add(fn as (e: Event) => void);
    },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void fns.get(type)?.delete(fn as (e: Event) => void)
  } as Pick<Window, "addEventListener" | "removeEventListener">;
  const fire = (type: string, persisted: boolean) => {
    for (const fn of [...(fns.get(type) ?? [])]) fn({ type, persisted } as unknown as Event);
  };
  return { win, fire, count: () => [...fns.values()].reduce((n, s) => n + s.size, 0) };
}

/** Just enough browser for a rig that opens and waits on the microphone (the request never answers). */
function rigEnv(session: AudioSessionLike): RigEnv {
  const ctx = {
    state: "suspended",
    sampleRate: 48000,
    audioWorklet: {},
    destination: {},
    resume() {
      return Promise.resolve();
    },
    close() {
      ctx.state = "closed";
      return Promise.resolve();
    },
    createBuffer: () => ({}),
    createBufferSource: () => ({ buffer: null, connect: () => undefined, start: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  return {
    navigator: {
      mediaDevices: { getUserMedia: () => new Promise<MediaStream>(() => undefined), addEventListener: () => undefined, removeEventListener: () => undefined },
      audioSession: session
    },
    document: null,
    createContext: () => ctx as unknown as AudioContext,
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    loadWorklet: () => Promise.resolve(),
    createTransport: () => {
      throw new Error("no link in these tests");
    }
  };
}

/** A page's Fullscreen browser surface, with its audio session; `reload` records the tab's override as the page goes. */
function fullscreenEnv(tab: Tab, session: AudioSessionLike | null | undefined) {
  const atReload: string[] = [];
  const env: FullscreenEnv = {
    ...(session === undefined ? {} : { audioSession: session }),
    reload: () => void atReload.push(tab.override)
  };
  return { env, atReload };
}

describe("iOS's audio session, from one page to the next in the tab", () => {
  it("the next page reads auto while the override stands, and only a write clears it (main.ts's boot)", () => {
    const tab = new Tab();
    tab.page().type = "play-and-record"; // a duel's rig, on a page that went without closing it
    const next = tab.page();
    expect(next.type).toBe("auto"); // (a check of the type sees nothing wrong)
    expect(tab.override).toBe("play-and-record");
    resetAudioSession(next);
    expect(tab.override).toBe("auto");
    expect(next.type).toBe("auto");
  });

  it("a reload (Menu, Rematch, the lobby's Reload, the update sheet's) puts it back before the page goes", () => {
    const tab = new Tab();
    const page = tab.page();
    page.type = "play-and-record"; // the lobby still holds the rig: a version error's Reload
    const { env, atReload } = fullscreenEnv(tab, page);
    new Fullscreen(() => env).reload();
    expect(atReload).toEqual(["auto"]);
    expect(tab.page().type).toBe("auto");
    expect(tab.override).toBe("auto");
  });

  it("a page without the API, or whose setter throws, reloads all the same", () => {
    const tab = new Tab();
    for (const session of [undefined, null, { get type() { return "auto"; }, set type(_: string) { throw new Error("no"); } }]) {
      const { env, atReload } = fullscreenEnv(tab, session);
      expect(() => new Fullscreen(() => env).reload()).not.toThrow();
      expect(atReload).toHaveLength(1);
    }
    expect(() => resetAudioSession(null)).not.toThrow();
  });

  it("the lobby's pagehide closes the rig, which puts the session back, until the match takes the rig over", () => {
    const tab = new Tab();
    const rig = openRig({ micMode: "raw", env: rigEnv(tab.page()) });
    expect(tab.override).toBe("play-and-record");
    const { win, fire, count } = fakeWindow();
    const off = closeRigOnPageGone(win, rig);
    expect(count()).toBe(1);
    // into the back-forward cache: the page may come back, lobby and all
    fire("pagehide", true);
    expect(rig.state).toBe("opening");
    expect(tab.override).toBe("play-and-record");
    // a reload, the player's or the version error's Reload, or a navigation
    fire("pagehide", false);
    expect(rig.state).toBe("closed");
    expect(tab.override).toBe("auto");
    off();
    expect(count()).toBe(0);

    // once the match has the rig (VersusFeed's own pagehide) or the lobby has let it go, the lobby's is gone
    const tab2 = new Tab();
    const rig2 = openRig({ micMode: "raw", env: rigEnv(tab2.page()) });
    const w2 = fakeWindow();
    closeRigOnPageGone(w2.win, rig2)();
    w2.fire("pagehide", false);
    expect(rig2.state).toBe("opening");
    expect(tab2.override).toBe("play-and-record");
    rig2.close();
    expect(tab2.override).toBe("auto");
  });
});

describe("main.ts, which no test can boot", () => {
  const main = sources["../src/main.ts"]!;

  it("puts the session back at every boot, before the menu or a replay can make a context", () => {
    expect(main).toBeDefined();
    // (at the top level: not behind a rematch or any other condition)
    const boot = main.search(/^resetAudioSession\(\);$/m);
    expect(boot).toBeGreaterThan(0);
    for (const start of [/^ {2}showMenu\(linkedMap\);$/m, /^if \(replayLink\) void watchLinked\(/m]) {
      const at = main.search(start);
      expect(at).toBeGreaterThan(boot);
    }
  });

  it("makes the game's context before the rig sets play-and-record, in the Duel tap and the rematch's", () => {
    const tap = main.slice(main.indexOf("const duelTap = "), main.indexOf("const duelUpdate = "));
    expect(tap.indexOf("sfx.unlock();")).toBeGreaterThan(0);
    expect(tap.indexOf("sfx.unlock();")).toBeLessThan(tap.indexOf("d.openRig("));
  });
});

describe("the game's sound under play-and-record", () => {
  it("is cut by the guard's full GUARD_CUT_DB wherever the duel turns it on: an iPhone plays it from the loudspeaker, raw mode or not", () => {
    // WebKit sets DefaultToSpeaker on every play-and-record session (AudioSessionIOS.mm, Safari 17 on; later versions
    // leave it off only for a page that picked the receiver through setSinkId), so no phone gets an earpiece's cut of 0
    const calls = Object.entries(sources).flatMap(([file, src]) => [...src.matchAll(/\bsfx\.setLinkGuard\(([^)]*)\)/g)].map((m) => ({ file, args: m[1]! })));
    expect(calls.map((c) => c.file)).toEqual(expect.arrayContaining(["../src/main.ts", "../src/versus/lobby.ts"]));
    for (const c of calls) expect(c.args, `${c.file}: sfx.setLinkGuard(${c.args})`).not.toMatch(/,/);
    expect(Object.values(sources).some((s) => /\.setSinkId\(/.test(s))).toBe(false);
  });
});
