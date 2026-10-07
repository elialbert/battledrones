/**
 * Game-wide announcements: the big moments ("Supply drop inbound", "Wave 5",
 * "First blood", "Sky Hammer ready"…). Any system calls announce(); every
 * presentation layer that cares subscribes with onAnnounce(): the HUD shows
 * a banner, and audio layers (announcer voice, music stingers) can react to
 * the same stream without the gameplay code knowing they exist.
 */

export type AnnounceTone = "info" | "good" | "bad" | "epic";

export interface Announcement {
  /** Stable id for this kind of line, e.g. "supply-drop", "hq-attack" (voice/dedupe key). */
  key: string;
  /** Short, shouty banner text. */
  text: string;
  /** Optional smaller second line. */
  sub?: string;
  tone?: AnnounceTone;
  /** World position (tiles), if there is somewhere to look: tapping the banner jumps there. */
  x?: number;
  y?: number;
  /** 0 = critical … 3 = flavour; a more important line pre-empts a showing one. Default 2. */
  priority?: number;
  /** What the radio announcer says, if not the banner text itself. */
  say?: string;
}

type Listener = (a: Announcement) => void;

const listeners = new Set<Listener>();

/** Subscribe to announcements; returns an unsubscribe function. */
export function onAnnounce(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function announce(a: Announcement): void {
  for (const l of [...listeners]) l(a);
}
