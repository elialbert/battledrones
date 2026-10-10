/**
 * The home screen's "New version ready" pill (src/ui/update.ts): the
 * engine-free watcher, against a fake service worker container.
 */
import { describe, expect, it } from "vitest";
import { AppUpdate, type UpdateEnv } from "../src/ui/update";

function fakeEnv(opts: { controlled?: boolean; sw?: boolean; failUpdate?: boolean } = {}) {
  const swListeners: (() => void)[] = [];
  const docListeners: (() => void)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let updates = 0;
  let t = 0;
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_type: "visibilitychange", fn: () => void) => void docListeners.push(fn)
  };
  const env: UpdateEnv = {
    sw:
      opts.sw === false
        ? null
        : {
            controller: opts.controlled === false ? null : {},
            addEventListener: (_type: "controllerchange", fn: () => void) => void swListeners.push(fn),
            getRegistration: () =>
              Promise.resolve({
                update: () => {
                  updates++;
                  return opts.failUpdate ? Promise.reject(new TypeError("offline")) : Promise.resolve();
                }
              })
          },
    doc,
    every: (fn, ms) => void timers.push({ fn, ms }),
    now: () => t
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    env,
    /** A new worker activates and claims the page. */
    takeover: () => swListeners.forEach((fn) => fn()),
    /** The app goes to the background or comes back. */
    show: (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      docListeners.forEach((fn) => fn());
    },
    timers,
    advance: (ms: number) => void (t += ms),
    updates: async () => (await settle(), updates)
  };
}

describe("the home screen offers a new build", () => {
  it("a page the worker served is told once when a newer worker takes it over", () => {
    const f = fakeEnv();
    const up = new AppUpdate(() => f.env);
    up.watch();
    let told = 0;
    up.onReady(() => told++);
    expect(up.ready).toBe(false);
    f.takeover();
    expect(up.ready).toBe(true);
    f.takeover(); // a second deploy while the pill is up
    expect(told).toBe(1);
    // the menu mounted after the update landed (a match ended) shows it straight away
    let late = 0;
    up.onReady(() => late++);
    expect(late).toBe(1);
  });

  it("a page from the network (first visit, hard reload) is current: only a later takeover is an update", () => {
    const f = fakeEnv({ controlled: false });
    const up = new AppUpdate(() => f.env);
    up.watch();
    f.takeover(); // the worker installing and claiming the page
    expect(up.ready).toBe(false);
    f.takeover(); // the next deploy
    expect(up.ready).toBe(true);
  });

  it("an unmounted menu is not called", () => {
    const f = fakeEnv();
    const up = new AppUpdate(() => f.env);
    up.watch();
    let told = 0;
    const off = up.onReady(() => told++);
    off(); // the match started
    f.takeover();
    expect(told).toBe(0);
    expect(up.ready).toBe(true);
  });

  it("asks for a new build on launch, on coming back to the app (at most once a minute) and every half hour", async () => {
    const f = fakeEnv();
    const up = new AppUpdate(() => f.env);
    up.watch();
    expect(await f.updates()).toBe(1); // launch
    f.show("hidden");
    f.advance(10_000);
    f.show("visible");
    expect(await f.updates()).toBe(1); // back within the minute: no second ask
    f.show("hidden");
    f.advance(5 * 60_000);
    expect(await f.updates()).toBe(1); // nothing while hidden
    f.show("visible");
    expect(await f.updates()).toBe(2); // resumed from the background
    expect(f.timers.map((x) => x.ms)).toEqual([30 * 60_000]);
    f.advance(30 * 60_000);
    f.timers[0]!.fn();
    expect(await f.updates()).toBe(3);
  });

  it("an offline check fails quietly, and no service worker means nothing to watch", async () => {
    const offline = fakeEnv({ failUpdate: true });
    new AppUpdate(() => offline.env).watch();
    expect(await offline.updates()).toBe(1);
    const none = fakeEnv({ sw: false });
    const up = new AppUpdate(() => none.env);
    up.watch();
    up.check();
    expect(none.timers).toHaveLength(0);
    expect(up.ready).toBe(false);
  });
});
