import { modeProgress } from "../sim/goliath";
import type { GoliathWeapon, Unit } from "../sim/types";

/** A Goliath's weapon systems in the order damage takes them, with short labels for the selection panel. */
export const GOLIATH_STRIP: { k: GoliathWeapon; short: string }[] = [
  { k: "mortars", short: "Mortars" },
  { k: "laser", short: "Laser" },
  { k: "cannons", short: "Cannons" },
  { k: "mg", short: "MG" }
];

/** A Goliath's state for the selection panel: walking, anchoring (with progress), anchored, packing up, or on a lift. */
export function goliathMode(u: Unit): string {
  const g = u.goliath!;
  if (g.lift) return g.lift.phase === "hooking" ? "Condors hooking on…" : "⇡ On a lift";
  const pct = `${Math.floor(modeProgress(u) * 20) * 5}%`;
  if (g.mode === "anchoring") return `⚓ Anchoring ${pct}`;
  if (g.mode === "packing") return `⇡ Packing up ${pct}`;
  return g.mode === "anchored" ? "⚓ Anchored" : "Walking";
}
