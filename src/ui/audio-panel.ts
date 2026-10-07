/**
 * Sound settings: a row of four toggles (All / Music / Effects / Voice)
 * bound to the shared audio engine's persisted settings. Used in the pause
 * menu; the top-left speaker button stays a one-tap master mute.
 */
import { sfx, type AudioChannel } from "../game/audio";

const TOGGLES: { id: "muted" | AudioChannel; icon: string; label: string }[] = [
  { id: "muted", icon: "🔊", label: "Sound" },
  { id: "music", icon: "🎵", label: "Music" },
  { id: "sfx", icon: "💥", label: "Effects" },
  { id: "voice", icon: "🗣", label: "Voice" }
];

/** Render the toggles into `host`; returns a cleanup function. */
export function mountAudioToggles(host: HTMLElement): () => void {
  host.classList.add("sound-row");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "Sound settings");
  host.innerHTML = TOGGLES.map(
    (t) =>
      `<button class="snd" data-k="${t.id}" aria-pressed="false"><span class="si">${t.icon}</span><span class="sl">${t.label}</span></button>`
  ).join("");
  const sync = () => {
    const s = sfx.settings;
    host.querySelectorAll<HTMLButtonElement>(".snd").forEach((b) => {
      const k = b.dataset.k as (typeof TOGGLES)[number]["id"];
      const on = k === "muted" ? !s.muted : s[k];
      b.classList.toggle("on", on);
      // a bus switched on under a master mute is still silent: show it greyed
      b.classList.toggle("held", k !== "muted" && on && s.muted);
      b.setAttribute("aria-pressed", String(on));
      if (k === "muted") b.querySelector(".si")!.textContent = on ? "🔊" : "🔇";
    });
  };
  host.querySelectorAll<HTMLButtonElement>(".snd").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.k as (typeof TOGGLES)[number]["id"];
      sfx.unlock();
      if (k === "muted") sfx.setMuted(!sfx.muted);
      else sfx.setChannel(k, !sfx.settings[k]);
      sfx.play("click", 0.5);
    })
  );
  sync();
  return sfx.onChange(sync);
}
