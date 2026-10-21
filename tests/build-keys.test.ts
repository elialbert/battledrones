import { describe, expect, it } from "vitest";
import { buildKeyAction, buildKeys, keyLabel } from "../src/ui/build-keys";

const press = (code: string, more: Partial<KeyboardEvent> = {}) => ({
  code, key: code.replace(/^(Key|Digit)/, "").toLowerCase(), repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...more
});
const labels = (keys: (string | null)[]) => keys.map((k) => (k ? keyLabel(k) : "·")).join("");

describe("build keys follow the buttons", () => {
  it("the desk sidebar's three columns are the left hand's block, row for row", () => {
    expect(labels(buildKeys(9, 3))).toBe("QWEASDZXC"); // Base
    expect(labels(buildKeys(7, 3))).toBe("QWEASDZ"); // Vehicles
    expect(labels(buildKeys(3, 3))).toBe("QWE"); // Infantry
  });
  it("one row (portrait) runs along the top letter row", () => {
    expect(labels(buildKeys(9, 0))).toBe("QWERTYUIO");
  });
  it("two columns turn sideways: the left column is QWERT, the right ASDFG", () => {
    // row-major: Fab Airpad / Bay Tech / Depot Turret / SAM Radar / Gantry
    expect(labels(buildKeys(9, 2))).toBe("QAWSEDRFT");
    // a short tab keeps the same shape (Air: Q A W S E D), not a different one
    expect(labels(buildKeys(6, 2))).toBe("QAWSED");
  });
  it("never hands out B (it closes build mode), and every key is used once", () => {
    for (const cols of [0, 2, 3, 4, 5]) {
      const keys = buildKeys(12, cols).filter(Boolean);
      expect(keys).not.toContain("KeyB");
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  it("labels name the keyboard's own letters when the browser says (AZERTY)", () => {
    expect(keyLabel("KeyQ", new Map([["KeyQ", "a"]]))).toBe("A");
    expect(keyLabel("Digit2")).toBe("2");
  });
});

describe("build mode: what a key does", () => {
  const keys = buildKeys(9, 3);
  it("closed: only B, and only a fresh press, without modifiers", () => {
    expect(buildKeyAction(false, press("KeyB"), keys)).toEqual({ type: "open" });
    expect(buildKeyAction(false, press("KeyB", { repeat: true }), keys)).toBeNull();
    expect(buildKeyAction(false, press("KeyB", { ctrlKey: true }), keys)).toBeNull();
    // the game keeps its keys: Q selects the army, 1 a squad
    expect(buildKeyAction(false, press("KeyQ"), keys)).toBeNull();
    expect(buildKeyAction(false, press("Digit1"), keys)).toBeNull();
  });
  it("open: 1–4 pick a tab, letters press buttons, B and Escape close", () => {
    expect(buildKeyAction(true, press("Digit2"), keys)).toEqual({ type: "tab", index: 1 });
    expect(buildKeyAction(true, press("KeyW"), keys)).toEqual({ type: "press", index: 1 });
    expect(buildKeyAction(true, press("KeyC"), keys)).toEqual({ type: "press", index: 8 });
    expect(buildKeyAction(true, press("KeyB"), keys)).toEqual({ type: "close" });
    expect(buildKeyAction(true, { ...press("Escape"), key: "Escape" }, keys)).toEqual({ type: "close" });
  });
  it("open: a held key presses once; keys with no button still reach the game", () => {
    expect(buildKeyAction(true, press("KeyW", { repeat: true }), keys)).toEqual({ type: "swallow" });
    // Infantry's three buttons: A has none, so it pans the camera as usual
    expect(buildKeyAction(true, press("KeyA"), buildKeys(3, 3))).toBeNull();
    expect(buildKeyAction(true, { ...press("ArrowLeft"), key: "ArrowLeft" }, keys)).toBeNull();
    expect(buildKeyAction(true, press("Digit5"), keys)).toBeNull();
  });
});
