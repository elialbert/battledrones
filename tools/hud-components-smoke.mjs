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
      await import("/src/game/controller.ts"), await import("/src/ui/selection-panel.ts")
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

  await test("HUD components raise no browser exceptions", () => assert.deepEqual(errors, []));
} finally {
  await browser?.close();
  await server.close();
}
