import { sfx } from "../game/audio";

export interface ActionChip {
  id: string;
  label: string;
  cls?: string;
  on(): void;
  active?: boolean;
}

/** Keep buttons through label updates and route taps to the most recent action. */
export function createActionChips(chipsEl: HTMLElement) {
  /** The key that does what each chip does (src/game/GameScene.ts keydown), for its tooltip. */
  const CHIP_KEYS: Record<string, string> = {
    stop: "X", move: "F", clear: "Esc", sell: "Delete", unload: "U", anchor: "G", found: "V", idle: "E",
    place: "Enter", cancel: "Esc", untarget: "Esc"
  };
  let lastChipKey = "";
  let lastChipShape = "";
  /** The class each chip was last given (so a refused tap's "nope" shake survives a label tick). */
  let chipCls: string[] = [];
  const chipClass = (c: ActionChip) => `chip ${c.cls ?? ""} ${c.active ? "active" : ""}`;
  /** The chips as last rendered: a tap runs the current chip's action (one updated in place may now do something else). */
  let chipList: ActionChip[] = [];
  function renderChips(list: ActionChip[]): void {
    chipList = list;
    const key = list.map((c) => c.id + (c.active ? "*" : "") + (c.cls ?? "") + c.label).join("|");
    if (key === lastChipKey) return;
    lastChipKey = key;
    // same chips, only a label or style ticked (the call-wave bonus, ✓ Place
    // turning ⚠ Blocked): update in place so a tap in progress isn't lost to a rebuilt button
    const shape = list.map((c) => c.id + (c.active ? "*" : "")).join("|");
    if (shape === lastChipShape && chipsEl.children.length === list.length) {
      list.forEach((c, i) => {
        const el = chipsEl.children[i] as HTMLElement;
        if (el.textContent !== c.label) el.textContent = c.label;
        const cls = chipClass(c);
        if (chipCls[i] !== cls) el.className = chipCls[i] = cls;
      });
      return;
    }
    lastChipShape = shape;
    chipCls = list.map(chipClass);
    chipsEl.innerHTML = "";
    list.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = chipClass(c);
      b.dataset.id = c.id;
      b.textContent = c.label;
      if (CHIP_KEYS[c.id]) b.title = `Key: ${CHIP_KEYS[c.id]}`;
      b.addEventListener("click", () => {
        sfx.play("click", 0.5);
        chipList[i]?.on();
      });
      chipsEl.appendChild(b);
    });
  }

  /** Shake chip `id` with a buzz: that tap was refused. */
  function nope(id: string): void {
    sfx.play("deny", 0.6);
    const el = chipsEl.querySelector<HTMLElement>(`.chip[data-id="${id}"]`);
    if (!el) return;
    el.classList.remove("nope");
    void el.offsetWidth;
    el.classList.add("nope");
  }

  return { render: renderChips, nope };
}
