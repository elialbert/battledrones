// Bundled separately from each checkout. Never resolve baseline imports in the candidate graph.
import { marshal, MARSHAL } from "../../src/sim/ai/marshal";
export function create(side: any, seed: number, plan: any, secureEconomy: boolean, onEconomyDiagnostic?: (snapshot: unknown) => void) {
  return marshal(side, seed, "brutal", { ...MARSHAL.brutal, strategy: plan, secureEconomy, onEconomyDiagnostic } as any);
}
/** Brutal Marshal with option overrides, for scripted opponents built on the frozen baseline. */
export function createWith(side: any, seed: number, overrides: (brutal: typeof MARSHAL.brutal) => any) {
  return marshal(side, seed, "brutal", { ...MARSHAL.brutal, ...overrides(MARSHAL.brutal) } as any);
}
