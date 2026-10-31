// Real DOM checks for the extracted HUD components. No match loop or WebGL required.
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "hud-component-fixture",
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== "/__hud_test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>');
      });
    }
  }]
});
let browser;
try {
  await server.listen();
  const executablePath = process.env.CHROME_BIN ?? [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/google-chrome"
  ].find((p) => existsSync(p));
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${server.resolvedUrls.local[0]}__hud_test`);
  await page.evaluate(async () => {
    const m = Object.assign({},
      await import("/src/sim/world.ts"), await import("/src/sim/balance.ts"),
      await import("/src/game/controller.ts"), await import("/src/ui/selection-panel.ts"),
      await import("/src/ui/build-card.ts"), await import("/src/ui/action-chips.ts")
    );
    window.hudModules = m;
    window.selectionFixture = (side = "blue") => {
      m.setLocalSide(side);
      const world = m.createWorld(64, 64);
      const ctrl = new m.Controller(world);
      const el = document.createElement("div");
      el.hidden = true;
      document.body.replaceChildren(el);
      const panel = m.createSelectionPanel(el, { world, ctrl });
      return { ...m, world, ctrl, el, update: panel.update };
    };
  });

  await test("selection keeps queue buttons alive while HP and progress change, and cancels once", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, update, spawnBuilding, UNITS, TICK_RATE } = window.selectionFixture("red");
      const b = spawnBuilding(world, "fab-plant", "red", 4, 4);
      b.queue.push({ kind: "stinger", remaining: UNITS.stinger.buildTime * TICK_RATE, cost: UNITS.stinger.cost });
      ctrl.selectedBuilding = b.id;
      update();
      const button = el.querySelector(".qi");
      b.hp = 123;
      b.queue[0].remaining /= 2;
      update(); update();
      button.click();
      return {
        same: button === el.querySelector(".qi"), hp: el.querySelector(".hp").textContent,
        progress: el.querySelector(".qp").style.height, icon: button.querySelector("img").getAttribute("src"),
        commands: ctrl.drainCommands(), id: b.id
      };
    });
    assert.equal(result.same, true);
    assert.match(result.hp, /^123 \/ /);
    assert.equal(result.progress, "50%");
    assert.equal(result.icon, "assets/icons/red/stinger.webp");
    assert.deepEqual(result.commands, [{ type: "cancelProduce", faction: "red", buildingId: result.id, unit: "stinger" }]);
  });

  await test("Goliath progress updates in place while mode and weapon changes rebuild its panel", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, update, spawnUnit, GOLIATH, TICK_RATE } = window.selectionFixture();
      const u = spawnUnit(world, "goliath", "blue", 20, 20);
      ctrl.selectUnits([u.id]);
      u.goliath.mode = "anchoring";
      u.goliath.modeTicks = GOLIATH.anchorTime * TICK_RATE;
      update();
      const hp = el.querySelector(".hp");
      const before = el.querySelector(".gmode").textContent;
      u.goliath.modeTicks /= 2;
      update();
      const same = hp === el.querySelector(".hp");
      const after = el.querySelector(".gmode").textContent;
      u.goliath.mode = "anchored";
      u.goliath.weapons.mortars.online = false;
      u.goliath.weapons.mortars.reboot = -1;
      update();
      return { same, before, after, rebuilt: hp !== el.querySelector(".hp"),
        mode: el.querySelector(".gmode").textContent, weapon: el.querySelector(".gw").className };
    });
    assert.equal(result.same, true);
    assert.notEqual(result.before, result.after);
    assert.match(result.after, /50%/);
    assert.equal(result.rebuilt, true);
    assert.equal(result.mode, "⚓ Anchored");
    assert.equal(result.weapon, "gw off");
  });

  await test("spectators cannot cancel queues and see enemy Goliaths as information only", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, update, spawnBuilding, spawnUnit } = window.selectionFixture();
      ctrl.spectator = true;
      const b = spawnBuilding(world, "fab-plant", "red", 4, 4);
      b.queue.push({ kind: "stinger", remaining: 10, cost: 100 });
      ctrl.selectedBuilding = b.id;
      update(); el.querySelector(".qi").click();
      const commands = ctrl.drainCommands();
      const u = spawnUnit(world, "goliath", "red", 20, 20);
      u.goliath.mode = "anchored";
      u.goliath.queue.push({ kind: "trooper", remaining: 10, cost: 100 });
      ctrl.selectedBuilding = null;
      ctrl.selectedUnits = new Set([u.id]);
      update();
      return { commands, queue: !!el.querySelector(".queue"), icon: el.querySelector(".pi").getAttribute("src") };
    });
    assert.deepEqual(result.commands, []);
    assert.equal(result.queue, false);
    assert.equal(result.icon, "assets/icons/red/goliath.webp");
  });

  await test("Condors display occupied and empty seats, and groups count squads aboard", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, update, spawnUnit } = window.selectionFixture("purple");
      const c = spawnUnit(world, "condor", "purple", 10, 10);
      const p = spawnUnit(world, "trooper", "purple", 10, 10);
      c.passengers = [p]; world.units.delete(p.id);
      ctrl.selectUnits([c.id]); update();
      const seats = el.querySelectorAll(".seat").length;
      const empty = el.querySelectorAll(".seat.empty").length;
      const icon = el.querySelector(".seat img").getAttribute("src");
      const other = spawnUnit(world, "condor", "purple", 12, 12);
      ctrl.selectUnits([c.id, other.id]); update();
      const group = el.querySelector(".group").textContent;
      const aboard = el.querySelector(".aboard").textContent;
      ctrl.clearSelection(); update();
      return { seats, empty, icon, group, aboard, hidden: el.hidden };
    });
    assert.equal(result.seats, 2);
    assert.equal(result.empty, 1);
    assert.equal(result.icon, "assets/icons/purple/trooper.webp");
    assert.equal(result.group, "21");
    assert.equal(result.aboard, "1");
    assert.equal(result.hidden, true);
  });

  await test("build cards show current Goliath pricing, weapon order, prerequisites and side paint", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, spawnBuilding, spawnUnit, createBuildCard, UNITS, GOLIATH } = window.selectionFixture("red");
      const ui = { refresh() {}, toast() {} };
      const card = createBuildCard(el, { world, ctrl, cardNote: () => "Watch for air raids" }, ui);
      spawnUnit(world, "goliath", "red", 30, 30);
      card.show("goliath");
      const price = el.querySelector("tr td:nth-child(2)").textContent;
      const expectedPrice = Math.round(UNITS.goliath.cost * (1 + GOLIATH.costStep));
      const weapons = [...el.querySelectorAll(".gwt tr:not(.gw-head) td:first-child")].map((e) => e.textContent);
      const note = el.querySelector(".ctr").textContent;
      const icon = el.querySelector(".ch img").getAttribute("src");
      spawnBuilding(world, "fab-plant", "red", 2, 2);
      spawnBuilding(world, "airpad", "red", 10, 2);
      card.show("gantry");
      const needs = el.querySelectorAll(".needs > span").length;
      const have = el.querySelectorAll(".needs > .have").length;
      el.querySelector("#card-x").click();
      return { price, expectedPrice, weapons, note, icon, needs, have, hidden: el.hidden };
    });
    assert.equal(result.price, String(result.expectedPrice));
    assert.equal(result.weapons.length, 4);
    assert.match(result.weapons[0], /mortar/i);
    assert.match(result.weapons.at(-1), /machine gun/i);
    assert.equal(result.note, "⚔ Watch for air raids");
    assert.equal(result.icon, "assets/icons/red/goliath.webp");
    assert.equal(result.needs, 4);
    assert.equal(result.have, 2);
    assert.equal(result.hidden, true);
  });

  await test("autobuild explains missing prerequisites, refreshes after toggles, and respects input locks", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, spawnBuilding, createBuildCard } = window.selectionFixture();
      const notices = [];
      let refreshes = 0;
      const card = createBuildCard(el, { world, ctrl }, { refresh: () => refreshes++, toast: (s) => notices.push(s) });
      card.show("stinger");
      el.querySelector("#card-auto").click();
      const refused = !ctrl.isAutoBuilding("stinger");
      const fab = spawnBuilding(world, "fab-plant", "blue", 4, 4);
      el.querySelector("#card-auto").click();
      const pressed = el.querySelector("#card-auto").getAttribute("aria-pressed");
      ctrl.locked = true;
      el.querySelector("#card-auto").click();
      const locked = ctrl.isAutoBuilding("stinger");
      ctrl.locked = false;
      world.buildings.delete(fab.id);
      el.querySelector("#card-auto").click();
      return { notices, refused, pressed, locked, stopped: !ctrl.isAutoBuilding("stinger"), refreshes };
    });
    assert.match(result.notices[0], /Fab Plant/);
    assert.equal(result.refused, true);
    assert.equal(result.pressed, "true");
    assert.equal(result.locked, true);
    assert.equal(result.stopped, true);
    assert.equal(result.refreshes, 3);
  });

  await test("build cards count and cancel production still in flight from the red seat", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, spawnBuilding, createBuildCard } = window.selectionFixture("red");
      const fab = spawnBuilding(world, "fab-plant", "red", 4, 4);
      world.factions.red.scrap = 10_000;
      ctrl.trackInFlight();
      ctrl.enqueue({ type: "produce", faction: "red", buildingId: fab.id, unit: "stinger" });
      ctrl.drainCommands();
      const card = createBuildCard(el, { world, ctrl }, { refresh() {}, toast() {} });
      card.show("stinger");
      const label = el.querySelector("#card-cancel").textContent;
      el.querySelector("#card-cancel").click();
      const commands = ctrl.drainCommands();
      ctrl.spectator = true;
      card.show("stinger");
      return { label, commands, id: fab.id, auto: !!el.querySelector("#card-auto") };
    });
    assert.equal(result.label, "Cancel one (1 queued)");
    assert.deepEqual(result.commands, [{ type: "cancelProduce", faction: "red", buildingId: result.id, unit: "stinger" }]);
    assert.equal(result.auto, false);
  });

  await test("cancelling a pending building also clears placement and closes the card", async () => {
    const result = await page.evaluate(() => {
      const { world, ctrl, el, createBuildCard } = window.selectionFixture("red");
      world.factions.red.pending = { kind: "turret", remaining: 10, ready: false };
      ctrl.placing = "turret";
      const card = createBuildCard(el, { world, ctrl }, { refresh() {}, toast() {} });
      card.show("turret");
      el.querySelector("#card-cancel-b").click();
      return { hidden: el.hidden, placing: ctrl.placing, commands: ctrl.drainCommands() };
    });
    assert.equal(result.hidden, true);
    assert.equal(result.placing, null);
    assert.deepEqual(result.commands, [{ type: "cancelBuilding", faction: "red" }]);
  });

  await test("chip label ticks keep buttons and route clicks to the latest action, even with identical labels", async () => {
    const result = await page.evaluate(() => {
      const el = document.createElement("div");
      document.body.replaceChildren(el);
      const { render } = window.hudModules.createActionChips(el);
      const calls = [];
      render([{ id: "place", label: "Place", on: () => calls.push("old") }]);
      const button = el.firstChild;
      render([{ id: "place", label: "Place here", on: () => calls.push("new") }]);
      const sameAfterLabel = button === el.firstChild;
      button.click();
      render([{ id: "place", label: "Place here", on: () => calls.push("newest") }]);
      button.click();
      return { sameAfterLabel, sameAfterAction: button === el.firstChild, calls, title: button.title };
    });
    assert.equal(result.sameAfterLabel, true);
    assert.equal(result.sameAfterAction, true);
    assert.deepEqual(result.calls, ["new", "newest"]);
    assert.equal(result.title, "Key: Enter");
  });

  await test("a refused chip keeps its shake through label ticks, and style changes update it in place", async () => {
    const result = await page.evaluate(() => {
      const el = document.createElement("div");
      document.body.replaceChildren(el);
      const { render, nope } = window.hudModules.createActionChips(el);
      render([{ id: "anchor", label: "Blocked", cls: "anchor bad", on() {} }]);
      const button = el.firstChild;
      nope("anchor");
      render([{ id: "anchor", label: "Still blocked", cls: "anchor bad", on() {} }]);
      const shook = button.classList.contains("nope");
      render([{ id: "anchor", label: "Anchor", cls: "anchor go", on() {} }]);
      const same = button === el.firstChild;
      nope("absent");
      return { shook, same, good: button.classList.contains("go"), bad: button.classList.contains("bad") };
    });
    assert.deepEqual(result, { shook: true, same: true, good: true, bad: false });
  });

  await test("chip insertion, removal and active-state changes rebuild with the right actions", async () => {
    const result = await page.evaluate(() => {
      const el = document.createElement("div");
      document.body.replaceChildren(el);
      const { render } = window.hudModules.createActionChips(el);
      const calls = [];
      render([{ id: "move", label: "Move", on() {} }]);
      const first = el.firstChild;
      render([
        { id: "stop", label: "Stop", on: () => calls.push("stop") },
        { id: "move", label: "Move", active: true, on: () => calls.push("move") }
      ]);
      const rebuilt = first !== el.firstChild;
      const active = el.children[1].classList.contains("active");
      el.children[0].click(); el.children[1].click();
      render([]);
      return { rebuilt, active, calls, remaining: el.children.length };
    });
    assert.deepEqual(result, { rebuilt: true, active: true, calls: ["stop", "move"], remaining: 0 });
  });

  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  await page.evaluate(async () => {
    const { createMessages } = await import("/src/ui/messages.ts");
    const { announce } = await import("/src/game/announce.ts");
    window.messageFixture = () => {
      const toasts = document.createElement("div");
      const banner = document.createElement("div");
      banner.hidden = true;
      document.body.replaceChildren(toasts, banner);
      const jumps = [];
      let refreshes = 0;
      const messages = createMessages(toasts, banner, { centerCamera: (x, y) => jumps.push([x, y]), refresh: () => refreshes++ });
      return window.messages = { toasts, banner, messages, jumps, announce, refreshes: () => refreshes };
    };
  });

  await test("toasts use safe text, preserve waiting hints and expire in two phases", async () => {
    const initial = await page.evaluate(() => {
      const f = window.messageFixture();
      f.messages.toast("<img src=x>", undefined, "hint");
      f.messages.toast("old alert");
      f.messages.toast("new alert", () => f.jumps.push("toast"));
      f.toasts.lastChild.click();
      return { texts: [...f.toasts.children].map((e) => e.textContent), image: !!f.toasts.querySelector("img"),
        passive: f.toasts.firstChild.classList.contains("passive"), jumps: f.jumps };
    });
    assert.deepEqual(initial, { texts: ["<img src=x>", "new alert"], image: false, passive: true, jumps: ["toast"] });
    await page.clock.runFor(2199);
    assert.equal(await page.evaluate(() => window.messages.toasts.querySelectorAll(".out").length), 0);
    await page.clock.runFor(1);
    assert.equal(await page.evaluate(() => window.messages.toasts.querySelectorAll(".out").length), 2);
    await page.clock.runFor(499);
    assert.equal(await page.evaluate(() => window.messages.toasts.children.length), 2);
    await page.clock.runFor(1);
    assert.equal(await page.evaluate(() => window.messages.toasts.children.length), 0);
    await page.evaluate(() => window.messages.messages.destroy());
  });

  await test("toast eviction removes exiting hints first and otherwise the oldest hint", async () => {
    const result = await page.evaluate(() => {
      const f = window.messageFixture();
      f.messages.toast("exiting", undefined, "hint out");
      f.messages.toast("alert"); f.messages.toast("new");
      const exitingFirst = [...f.toasts.children].map((e) => e.textContent);
      f.toasts.replaceChildren();
      f.messages.toast("hint 1", undefined, "hint"); f.messages.toast("hint 2", undefined, "hint"); f.messages.toast("hint 3", undefined, "hint");
      const hints = [...f.toasts.children].map((e) => e.textContent);
      f.messages.destroy();
      return { exitingFirst, hints };
    });
    assert.deepEqual(result, { exitingFirst: ["alert", "new"], hints: ["hint 2", "hint 3"] });
  });

  await test("banners deduplicate without restarting, queue three by priority, and safely jump", async () => {
    const result = await page.evaluate(() => {
      const f = window.messageFixture();
      f.announce({ key: "current", text: "<img>", sub: "<script>", tone: "good", x: 2, y: 9 });
      f.announce({ key: "late", text: "late", priority: 3 });
      f.announce({ key: "first", text: "first" });
      f.announce({ key: "second", text: "second", priority: 2 });
      f.announce({ key: "third", text: "third", priority: 2 });
      f.announce({ key: "first", text: "duplicate", priority: 0 });
      f.banner.click();
      return { text: f.banner.textContent, image: !!f.banner.querySelector("img"), tone: f.banner.className,
        late: f.messages.bannerUp("late"), queued: f.messages.bannerUp("fir"), busy: f.messages.busy, jumps: f.jumps, refreshes: f.refreshes() };
    });
    assert.deepEqual(result, { text: "<img><script>", image: false, tone: "banner good in", late: false, queued: true,
      busy: true, jumps: [[2, 9]], refreshes: 2 });
    await page.clock.runFor(1000);
    await page.evaluate(() => window.messages.announce({ key: "current", text: "duplicate", priority: 0 }));
    await page.clock.runFor(1200);
    assert.equal(await page.evaluate(() => window.messages.banner.classList.contains("out")), true);
    await page.clock.runFor(260);
    assert.equal(await page.evaluate(() => window.messages.banner.textContent), "first");
    await page.clock.runFor(2460);
    assert.equal(await page.evaluate(() => window.messages.banner.textContent), "second");
    await page.clock.runFor(2460);
    assert.equal(await page.evaluate(() => window.messages.banner.textContent), "third");
    await page.clock.runFor(2460);
    assert.deepEqual(await page.evaluate(() => ({ hidden: window.messages.banner.hidden, busy: window.messages.messages.busy,
      refreshes: window.messages.refreshes() })), { hidden: true, busy: false, refreshes: 9 });
    await page.evaluate(() => window.messages.messages.destroy());
  });

  await test("a critical banner pre-empts a showing banner and cancels its old timeout", async () => {
    await page.evaluate(() => {
      const f = window.messageFixture();
      f.announce({ key: "ordinary", text: "ordinary" });
      f.announce({ key: "waiting", text: "waiting" });
    });
    await page.clock.runFor(1000);
    assert.deepEqual(await page.evaluate(() => {
      const f = window.messages;
      f.announce({ key: "critical", text: "critical", priority: 0, x: 5, y: 6 });
      f.banner.click();
      return { old: f.messages.bannerUp("ordinary"), queued: f.messages.bannerUp("waiting"), jumps: f.jumps };
    }), { old: false, queued: true, jumps: [[5, 6]] });
    await page.clock.runFor(2999);
    assert.equal(await page.evaluate(() => window.messages.banner.className), "banner info in");
    await page.clock.runFor(1);
    assert.equal(await page.evaluate(() => window.messages.banner.className), "banner info out");
    await page.clock.runFor(260);
    assert.equal(await page.evaluate(() => window.messages.banner.textContent), "waiting");
    await page.evaluate(() => window.messages.messages.destroy());
  });

  await test("pre-emption during exit cancels hiding; teardown stops callbacks and unsubscribes", async () => {
    await page.evaluate(() => {
      const f = window.messageFixture();
      f.announce({ key: "ordinary", text: "ordinary" });
    });
    await page.clock.runFor(2200);
    await page.evaluate(() => window.messages.announce({ key: "urgent", text: "urgent", priority: 1 }));
    await page.clock.runFor(260);
    assert.deepEqual(await page.evaluate(() => {
      const f = window.messages;
      const state = { hidden: f.banner.hidden, text: f.banner.textContent, cls: f.banner.className };
      f.announce({ key: "waiting", text: "waiting" });
      f.messages.destroy();
      f.banner.click();
      f.announce({ key: "after", text: "after", priority: 0 });
      return { ...state, jumps: f.jumps, refreshes: f.refreshes() };
    }), { hidden: false, text: "urgent", cls: "banner info in", jumps: [], refreshes: 4 });
    await page.clock.runFor(10000);
    assert.deepEqual(await page.evaluate(() => ({ text: window.messages.banner.textContent, refreshes: window.messages.refreshes() })),
      { text: "urgent", refreshes: 4 });
    // Also destroy during the exit timeout, while a queued banner is waiting.
    await page.evaluate(() => {
      const f = window.messageFixture();
      f.announce({ key: "exiting", text: "exiting" });
      f.announce({ key: "waiting", text: "waiting" });
    });
    await page.clock.runFor(2200);
    await page.evaluate(() => window.messages.messages.destroy());
    await page.clock.runFor(10000);
    assert.deepEqual(await page.evaluate(() => ({ text: window.messages.banner.textContent, refreshes: window.messages.refreshes() })),
      { text: "exiting", refreshes: 2 });
  });

  await test("HUD components raise no browser exceptions", () => assert.deepEqual(errors, []));
} finally {
  await browser?.close();
  await server.close();
}
