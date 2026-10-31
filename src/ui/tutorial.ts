import { PLAYER, isArmyUnit } from "../game/controller";
import { HINTS, type HintQueue } from "../game/hints";
import type { World } from "../sim/types";

/** First-run curriculum. The HUD owns the shared queue and decides when hints can show. */
export function createTutorial(api: { world: World; spectator: boolean; matchSeconds(): number }, hints: HintQueue) {
  const TUTORIAL_KEY = "battledrones.tutorial";
  let hintStage = 99;
  try {
    hintStage = localStorage.getItem(TUTORIAL_KEY) === "done" ? 99 : 0;
  } catch {
    /* storage blocked: skip the hints */
  }
  if (api.spectator || api.world.ops) hintStage = 99; // ops brief the player themselves
  const mine = (k: string) => [...api.world.buildings.values()].some((b) => b.faction === PLAYER && b.kind === k);
  const hasFactory = () => mine("fab-plant") || mine("airpad");
  const armySize = () => [...api.world.units.values()].filter(isArmyUnit).length;
  /** Move the tutorial on to stage `next`; at 99 it's done for good. */
  function advance(next: number): void {
    hintStage = next;
    if (next < 99) return;
    try {
      localStorage.setItem(TUTORIAL_KEY, "done");
    } catch {
      /* ignore */
    }
  }
  /** The tutorial's next stage, offered to the queue once its moment comes; the stage moves on when it is shown. */
  function tutorial(): void {
    if (hintStage >= 99 || hints.has(`tut-${hintStage}`)) return;
    const stage = hintStage;
    const secs = api.matchSeconds();
    let msg: string | null = null;
    let next = stage;
    let still = () => true;
    if (stage === 0 && secs > 4) {
      // quick-start openers hand out a factory (and maybe an army) up front
      const factory = hasFactory();
      const army = armySize() > 0;
      still = () => hasFactory() === factory && armySize() > 0 === army;
      if (factory) {
        msg = army
          ? "Your harvesters mine on their own. Tap a unit (or ⚔ Select army), then tap the map to send it."
          : "Your harvesters mine on their own. Train tanks in Vehicles, then tap a unit and tap the map to send it.";
        next = 2;
      } else {
        msg = "Your harvester mines scrap by itself. Open Base and tap Fab to build a factory.";
        next = 1;
      }
    } else if (stage === 1 && mine("fab-plant")) {
      msg = "Train tanks in Vehicles. Tap a unit, then tap the map to send it.";
      next = 2;
    } else if (stage === 2 && armySize() >= 3 && secs > 30) {
      msg = "Long-press any build button to see what it counters. ⚔ Select army grabs everyone.";
      next = 3;
    } else if (stage === 3 && secs > 150) {
      // (one already stands: nothing left to teach)
      if (mine("tech-lab")) return advance(99);
      msg = "Build a Tech Lab to unlock Mastodons, Lancers, Mortars, Hornets and Snipers.";
      still = () => !mine("tech-lab");
      next = 99;
    }
    if (!msg) return;
    hints.offer({
      id: `tut-${stage}`,
      msg,
      priority: HINTS.priority.tutorial,
      ttlS: 600,
      valid: () => hintStage === stage && still(),
      onShow: () => advance(next)
    });
  }

  return { update: tutorial };
}
