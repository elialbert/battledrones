import { onAnnounce, type Announcement } from "../game/announce";

/** The HUD ticker and announcement subscription; layout remains owned by the HUD. */
export function createMessages(toastsEl: HTMLElement, bannerEl: HTMLElement, hooks: {
  centerCamera(x: number, y: number): void;
  refresh(): void;
}) {
  // ------------------------------------------------------------- toasts ---
  function toast(msg: string, onTap?: () => void, cls = "", ms = 2200): void {
    const t = document.createElement("div");
    t.className = `toast ${cls}`;
    const tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = msg;
    t.appendChild(tx);
    if (onTap) t.addEventListener("click", onTap);
    // nothing to tap: let touches fall through to the battlefield underneath
    else t.classList.add("passive");
    toastsEl.appendChild(t);
    // the ticker keeps two lines at most: the newest pushes the oldest out (a
    // waiting reader's 💡 hint outlives a burst of alerts)
    while (toastsEl.children.length > 2) {
      const kids = [...toastsEl.children].filter((c) => c !== t);
      const old = kids.find((c) => c.classList.contains("out")) ?? kids.find((c) => !c.classList.contains("hint")) ?? kids[0];
      old?.remove();
    }
    setTimeout(() => t.classList.add("out"), ms);
    setTimeout(() => t.remove(), ms + 500);
  }

  // ------------------------------------------------------------ banners ---
  // Big centre-top callouts for announce(): one at a time, the more
  // important line pre-empts, others wait in a short queue.
  let bannerCur: Announcement | null = null;
  let bannerTimer = 0;
  const bannerQueue: Announcement[] = [];
  const prio = (a: Announcement) => a.priority ?? 2;
  function showBanner(a: Announcement): void {
    bannerCur = a;
    bannerEl.className = `banner ${a.tone ?? "info"}`;
    bannerEl.innerHTML = `<b></b>${a.sub ? "<span></span>" : ""}`;
    bannerEl.querySelector("b")!.textContent = a.text;
    if (a.sub) bannerEl.querySelector("span")!.textContent = a.sub;
    bannerEl.hidden = false;
    hooks.refresh(); // centre it under the band at its real width
    // restart the entrance animation
    void bannerEl.offsetWidth;
    bannerEl.classList.add("in");
    hooks.refresh(); // (landscape: the ticker steps under it)
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => {
      bannerEl.classList.remove("in");
      bannerEl.classList.add("out");
      bannerTimer = window.setTimeout(() => {
        bannerEl.hidden = true;
        bannerCur = null;
        const next = bannerQueue.shift();
        if (next) showBanner(next);
        else hooks.refresh();
      }, 260);
    }, prio(a) <= 1 ? 3000 : 2200);
  }
  const jump = () => {
    if (bannerCur?.x !== undefined && bannerCur.y !== undefined) hooks.centerCamera(bannerCur.x, bannerCur.y);
  };
  bannerEl.addEventListener("click", jump);
  const offAnnounce = onAnnounce((a) => {
    if (bannerCur?.key === a.key || bannerQueue.some((q) => q.key === a.key)) return; // no stutter
    if (!bannerCur) return showBanner(a);
    if (prio(a) < prio(bannerCur)) return showBanner(a);
    bannerQueue.push(a);
    bannerQueue.sort((p, q) => prio(p) - prio(q));
    if (bannerQueue.length > 3) bannerQueue.pop();
  });

  return {
    toast,
    get busy(): boolean { return bannerCur !== null || bannerQueue.length > 0; },
    bannerUp(prefix: string): boolean {
      return !!bannerCur?.key.startsWith(prefix) || bannerQueue.some((a) => a.key.startsWith(prefix));
    },
    destroy(): void {
      offAnnounce();
      window.clearTimeout(bannerTimer);
      bannerEl.removeEventListener("click", jump);
      // Toast expiry callbacks only touch their own nodes, as before; the HUD removes those nodes.
    }
  };
}
