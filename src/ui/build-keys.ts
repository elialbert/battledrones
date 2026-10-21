/**
 * Build mode from the keyboard: B opens it, 1–4 pick the build-bar tab, and
 * letters press the buttons, laid out the way the buttons are on screen.
 *
 * - **Desk sidebar** (3 columns, src/ui/style.css `#hud.desk`): the left
 *   hand's block, Q W E / A S D / Z X C, row for row.
 * - **One row** (portrait, the bar along the bottom): Q W E R T Y U I O.
 * - **Two columns** (the touch sidebar, with a keyboard attached): five rows
 *   won't fit three keyboard rows, so the grid turns sideways: the left
 *   column is Q W E R T, the right one A S D F G.
 *
 * Keys are physical (`KeyboardEvent.code`), like the camera's WASD, so the
 * block keeps its shape on AZERTY; the labels name the layout's own letters
 * when the browser can say (`navigator.keyboard.getLayoutMap`).
 * Pure: the HUD (src/ui/hud.ts) measures and acts (tested in tests/build-keys.test.ts).
 */

/** The tabs: Base, Vehicles, Infantry, Air. */
export const TAB_CODES = ["Digit1", "Digit2", "Digit3", "Digit4"] as const;
/** Opens build mode, and closes it again. */
export const OPEN_CODE = "KeyB";

/** The left hand's block; no B (it closes the mode). */
const BLOCK = [
  ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG"],
  ["KeyZ", "KeyX", "KeyC", "KeyV"]
];
const ROW = ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"];

/**
 * The key (a `code`) of each of `count` buttons laid out in `columns`
 * columns, row by row (0: one row, the flex bar); null where none fits.
 */
export function buildKeys(count: number, columns: number): (string | null)[] {
  const out: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    if (columns <= 0) out.push(ROW[i] ?? null);
    else {
      const r = Math.floor(i / columns);
      const c = i % columns;
      // three columns or more: the block as it stands; fewer: turned sideways
      out.push((columns >= 3 ? BLOCK[r]?.[c] : BLOCK[c]?.[r]) ?? null);
    }
  }
  return out;
}

/** A key's label: its letter or digit (`layout`: the keyboard's own, where known). */
export function keyLabel(code: string, layout?: ReadonlyMap<string, string>): string {
  const own = layout?.get(code);
  if (own) return own.toUpperCase();
  return code.replace(/^(Key|Digit)/, "");
}

export type BuildKeyAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "tab"; index: number }
  | { type: "press"; index: number }
  /** Eaten without doing anything (a held key's repeats). */
  | { type: "swallow" };

/**
 * What a key press does to build mode (`open`: is it open; `keys`: the
 * shown buttons' keys, buildKeys). null: not ours, the game handles it
 * (closed: everything but B; open: keys with no button, arrows, Space…).
 */
export function buildKeyAction(
  open: boolean,
  e: Pick<KeyboardEvent, "code" | "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey">,
  keys: readonly (string | null)[]
): BuildKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (!open) return e.code === OPEN_CODE && !e.repeat ? { type: "open" } : null;
  if (e.key === "Escape" || e.code === OPEN_CODE) return e.repeat ? { type: "swallow" } : { type: "close" };
  const tab = (TAB_CODES as readonly string[]).indexOf(e.code);
  const index = tab >= 0 ? -1 : keys.indexOf(e.code);
  if (tab < 0 && index < 0) return null;
  // a held key queues one, not twenty
  if (e.repeat) return { type: "swallow" };
  return tab >= 0 ? { type: "tab", index: tab } : { type: "press", index };
}
