/**
 * Put a world back to a saved copy (a replay's seek, GameScene.seek), in
 * place: the scene and its presenters keep the same World object. Exactly
 * the copy: a field the sim added since it was saved goes too. Object.assign
 * alone would keep one, such as a free-for-all's knockouts (World.out, made
 * at the first one), and then a side knocked out later is out from the copy
 * on, and the replay drifts from the battle. Engine-free.
 */
import type { World } from "../sim/types";

export function restoreWorld(w: World, saved: World): void {
  const copy = structuredClone(saved);
  const fields = w as unknown as Record<string, unknown>;
  for (const k of Object.keys(fields)) if (!(k in copy)) delete fields[k];
  Object.assign(w, copy);
}
