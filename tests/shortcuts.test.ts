import { describe, expect, it } from "vitest";
import { SHORTCUT_GROUPS, isShortcutsKey } from "../src/ui/shortcuts";

describe("keyboard shortcuts overlay", () => {
  it("Shift+? toggles it; Ctrl/Cmd/Alt+? and a bare / don't", () => {
    const k = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
      isShortcutsKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(k("?")).toBe(true);
    expect(k("/")).toBe(false);
    expect(k("?", { ctrlKey: true })).toBe(false);
    expect(k("?", { metaKey: true })).toBe(false);
    expect(k("?", { altKey: true })).toBe(false);
  });

  it("calls Q the unassigned army units key", () => {
    const q = SHORTCUT_GROUPS.flatMap((g) => g.rows).find(([k]) => k === "Q");
    expect(q?.[1]).toMatch(/^Unassigned army units/);
  });
});
