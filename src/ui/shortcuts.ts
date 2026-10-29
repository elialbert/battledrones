/**
 * The keyboard shortcuts overlay: Shift+? brings it up and puts it away, on
 * the menu and in battle alike (one window listener, installed once by
 * main.ts). Esc or a click also closes it. The battle keys themselves live
 * in src/game/GameScene.ts keydown and src/ui/build-keys.ts; keep this list
 * in step with them (and with HELP_HTML's Keyboard section, src/ui/hud.ts).
 */

type Row = [keys: string, what: string];

export const SHORTCUT_GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Army",
    rows: [
      ["Q", "Unassigned army units: every combat unit not in a squad"],
      ["E", "Idle units"],
      ["1 – 3", "Select a squad (twice: fly there)"],
      ["Ctrl + 1 – 3", "Save the selection as a squad (or Shift + 1 – 3)"],
      ["X", "Stop"],
      ["F", "Next order is Move only"],
      ["U", "Unload a Condor"],
      ["G", "Anchor or pack up a Goliath"],
      ["V", "4+ selected Harvesters deploy a Depot (past your base)"],
      ["Delete", "Sell"],
      ["Esc", "Cancel and deselect"]
    ]
  },
  {
    title: "Build",
    rows: [
      ["B", "Build mode (B or Esc closes)"],
      ["1 – 4", "Build tabs, in build mode"],
      ["Q W E | A S D | Z X C", "The build buttons, in build mode (laid out like them)"],
      ["Enter", "Place the ghost where it stands"]
    ]
  },
  {
    title: "Calldowns",
    rows: [["4 – 7", "Barrage, EMP, Drop Pod, Sky Hammer, then click the map"]]
  },
  {
    title: "Camera and game",
    rows: [
      ["WASD", "Pan (or the arrow keys)"],
      ["+ / −", "Zoom"],
      ["H", "Back to your HQ"],
      ["J", "Jump to a fight"],
      ["C", "Cinematic camera"],
      ["P / Space", "Pause"],
      [".", "Game speed"],
      ["Shift + ?", "This list"]
    ]
  }
];

/** Is this the key that toggles the overlay? (Shift+/ on most layouts types "?") */
export function isShortcutsKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** "Ctrl + 1 – 3" as key caps (the "/", "–" and a joining "+" stay plain); " | " in a row's keys breaks the line. */
function keyCaps(keys: string): string {
  return keys
    .split(" ")
    .map((p, i) => (p === "/" || p === "–" || (p === "+" && i > 0) ? p : `<kbd>${p}</kbd>`))
    .join(" ");
}

let installed = false;

export function installShortcutsOverlay(): void {
  if (installed) return;
  installed = true;
  let wrap: HTMLElement | null = null;

  function open(): void {
    wrap = document.createElement("div");
    wrap.className = "keysheet";
    const groups = SHORTCUT_GROUPS.map(
      (g) =>
        `<section><h3>${g.title}</h3><dl>${g.rows
          .map(([k, w]) => `<dt>${k.split(" | ").map(keyCaps).join("<br>")}</dt><dd>${w}</dd>`)
          .join("")}</dl></section>`
    ).join("");
    wrap.innerHTML = `<div class="ks-card" role="dialog" aria-label="Keyboard shortcuts"><div class="ks-head"><h2>Keyboard shortcuts</h2><span class="ks-hint"><kbd>Shift</kbd> + <kbd>?</kbd> or <kbd>Esc</kbd> to close</span></div><div class="ks-grid">${groups}</div></div>`;
    wrap.addEventListener("click", close);
    document.body.appendChild(wrap);
  }

  function close(): void {
    wrap?.remove();
    wrap = null;
  }

  window.addEventListener(
    "keydown",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (isShortcutsKey(e)) {
        if (e.repeat) return;
        e.preventDefault();
        if (wrap) close();
        else open();
      } else if (wrap && e.key === "Escape") {
        // (closing the list doesn't also deselect or cancel what's behind it)
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true
  );
}
