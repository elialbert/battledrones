/**
 * How each side is named and drawn, for the HUD and the presenters. Engine-
 * free. Team colours follow the side (blue is blue on every screen, MULTIPLAYER.md
 * "Colours"); green and purple join blue and red on a four-player map (sim/sides.ts).
 */
import type { Faction } from "../sim/types";

/** A side's name in a sentence ("Green takes an Uplink"). */
export const SIDE_NAME: Readonly<Record<Faction, string>> = { blue: "Blue", red: "Red", green: "Green", purple: "Purple" };

/** A side's text colour on the HUD's dark panels. */
export const SIDE_CSS: Readonly<Record<Faction, string>> = { blue: "#7ec1ff", red: "#ff8a7a", green: "#86eea0", purple: "#c9a2ff" };

/** A side's portrait of a unit or building (ICONS.md): blue's in assets/icons, the others' in a folder each. */
export const iconUrl = (kind: string, f: Faction): string => `assets/icons/${f === "blue" ? "" : `${f}/`}${kind}.webp`;
