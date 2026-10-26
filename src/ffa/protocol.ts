/**
 * The four-player online battle's wire format (FFA.md "Protocol"). Engine-free.
 *
 * The relay (relay/README.md) pairs two sockets per room, so a battle is a
 * star of rooms: the host holds the "host" seat of <code>1, <code>2 and
 * <code>3, and the friend invited to player k's seat joins <code>k as its
 * "guest". Every message is one JSON text, kept under the relay's 1 KB limit.
 *
 * Guest → host: hello (who, which build, what it already holds), its opener
 * pick in the lobby, its orders (numbered, resent until acknowledged), how far
 * it has played, a world hash disagreeing with the host's, ping, bye.
 *
 * Host → guest: the lobby as it stands, the match setup when it starts (again
 * on a rejoin), the turn log in order (its orders, the commanders taking over
 * or handing back a seat, a world hash now and then), pong, and the end.
 *
 * The turn log is the match: a sequence of events, each an order (stamped
 * with its side by the host, whatever the guest sent), a control change
 * (a commander takes a seat over, or gives it back), a world hash, or the end
 * of a tick. Every page plays tick n once it holds tick n's end, with the same
 * orders and the same commanders, so every world stays the same.
 */
import { MUTATOR_IDS, type MutatorId } from "../sim/rules";
import { OPENER_IDS, type OpenerId } from "../sim/openers";
import { STRATEGIES, DIFFICULTY, type Difficulty, type StrategyName } from "../sim/ai/commander";
import { FACTIONS, isFaction } from "../sim/sides";
import type { BuildingKind, Command, Faction, PowerKind, UnitKind } from "../sim/types";
import { isKnownMapId } from "../sim/maps";

/** Bump when the messages or the turn log change meaning. */
export const FFA_PROTO = 1;

/** Seats: 0 is the host (blue), 1–3 the friends' (red, green, purple: canonical side order, sim/sides.ts). */
export const SEATS = 4;
export const SEAT_SIDE: readonly Faction[] = FACTIONS;

/** The relay's limit is 1024 bytes a message: stay well under it (JSON is ASCII here, names aside). */
export const MAX_MESSAGE = 900;
/** A unit list longer than this is split over several orders, so one order always fits a message. */
export const MAX_UNITS = 90;
/** A seat alone in its relay room is closed after 10 minutes (4010): it reconnects this many times, then gives up (30 minutes in all). */
export const LONELY_RETRIES = 2;

// ------------------------------------------------------------ rooms ---

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** The relay room of friend seat `seat` (1–3): the battle's code and the seat's digit. */
export const seatRoom = (code: string, seat: number): string => `${code}${seat}`;

/** Player `seat + 1`'s invite: this page (its version path included) with `#ffa=<code>-<seat>`. */
export function ffaInviteUrl(loc: Pick<Location, "origin" | "pathname">, code: string, seat: number): string {
  return `${loc.origin}${loc.pathname}#ffa=${code}-${seat}`;
}

/** The battle code and friend seat in an invite link's fragment (`#ffa=K7QM2XP4-2`), or null. Lower case is read as upper. */
export function parseFfaInvite(hash: string): { code: string; seat: number } | null {
  const m = /^#ffa=([0-9a-z]{8})-([1-3])$/i.exec(hash.trim());
  if (!m) return null;
  const code = m[1]!.toUpperCase();
  return CODE_RE.test(code) ? { code, seat: Number(m[2]) } : null;
}

// ------------------------------------------------------------ setup ---

/** Who plays a seat: a person, or a commander (its personality, difficulty and seed, so every page runs the same one). */
export type SeatPlan =
  | { side: Faction; kind: "human"; name: string }
  | { side: Faction; kind: "ai"; strategy: StrategyName; difficulty: Difficulty; seed: number };

/** Everything every page needs to set the same match up (sim/setup.ts setupWorld, and the commanders). */
export interface FfaSetup {
  /** A match id: a rejoining page knows it was in this one. */
  id: string;
  map: string;
  seed: number;
  mutators: MutatorId[];
  openers: Partial<Record<Faction, OpenerId>>;
  seats: SeatPlan[];
  /** A commander's seed for a seat a person leaves (it takes over: the same on every page). */
  standIn: { strategy: StrategyName; difficulty: Difficulty; seed: number };
}

// ------------------------------------------------------------ the turn log ---

/**
 * One event of the turn log: an order (stamped with its side), a seat changing
 * hands ({ ai: side, on }: a commander takes it over, or gives it back to its
 * person), the host's world hash after tick `h[0]`, or the end of tick n (a number).
 */
export type LogEvent = Command | { ai: Faction; on: boolean } | { h: [number, string] } | number;

export const isTickEnd = (e: LogEvent): e is number => typeof e === "number";
export const isControl = (e: LogEvent): e is { ai: Faction; on: boolean } => typeof e === "object" && "ai" in e;
export const isHash = (e: LogEvent): e is { h: [number, string] } => typeof e === "object" && "h" in e;

// ------------------------------------------------------------ messages ---

/** A seat as the lobby shows it. */
export interface SeatView {
  seat: number;
  side: Faction;
  /** host: the host's own; friend: a person has joined; open: waiting for one (an AI if nobody comes). */
  kind: "host" | "friend" | "open";
  name: string;
  /** The opener they picked (null: not yet). */
  pick: OpenerId | null;
  /** Connected right now. */
  online: boolean;
}

export type HostMsg =
  | { t: "lobby"; proto: number; seat: number; seats: SeatView[]; map: string; mutators: MutatorId[]; difficulty: Difficulty }
  | { t: "start"; setup: FfaSetup }
  /** Turn-log events from index `from` on, and the last order seq of this guest's the host holds. */
  | { t: "ev"; from: number; e: LogEvent[]; ack: number }
  | { t: "pong"; at: number }
  /** The host's battle is decided and its page still shows the result: a new page waits for the host's Rematch (its next lobby). */
  | { t: "over" }
  /** The battle is over for this page: the host left, the worlds drifted apart, the build differs, or the seat isn't free. */
  | { t: "end"; why: "left" | "desync" | "version" | "started" };

export type GuestMsg =
  /** `have`: turn-log events this page holds of `match` (−1: none, a fresh page). */
  | { t: "hello"; proto: number; build: string; name: string; match: string | null; have: number }
  | { t: "pick"; opener: OpenerId }
  /** Orders numbered from `seq`, in the order given. */
  | { t: "cmd"; seq: number; c: Command[] }
  /** Events held and the tick played to. */
  | { t: "at"; have: number; tick: number }
  /** This page's world after tick `tick` isn't the host's. */
  | { t: "desync"; tick: number }
  | { t: "ping"; at: number }
  | { t: "bye" };

// ------------------------------------------------------------ validation ---

const COMMAND_TYPES = new Set<Command["type"]>([
  "move", "attackMove", "attack", "harvest", "stop", "produce", "cancelProduce", "startBuilding", "cancelBuilding",
  "placeBuilding", "sell", "rally", "calldown", "board", "unload", "anchor", "packUp", "lift", "resign"
]);
const UNIT_KINDS = new Set<string>([
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet", "mender",
  "trooper", "rocket-squad", "sniper", "condor", "goliath"
]);
const BUILDING_KINDS = new Set<string>(["hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry"]);
const POWERS = new Set<string>(["barrage", "emp", "droppod", "hammer"]);

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e6;
/** An integer as the wire carries them: ids, ticks, seqs and 32-bit seeds. */
const int = (x: unknown): x is number => Number.isInteger(x) && Math.abs(x as number) <= 0x7fffffff;
const ids = (x: unknown, max = 200): x is number[] => Array.isArray(x) && x.length <= max && x.every(int);

/**
 * A guest's order as the sim may take it: a known type with fields of the
 * right shapes, stamped with `side` (whatever it claimed), or null. The sim
 * checks what it means (whose units, what can be built where) itself.
 */
export function sanitizeCommand(raw: unknown, side: Faction): Command | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const type = c.type as Command["type"];
  if (!COMMAND_TYPES.has(type)) return null;
  const base = { faction: side };
  switch (type) {
    case "move":
    case "attackMove":
    case "harvest":
      return ids(c.unitIds) && num(c.x) && num(c.y) ? { type, ...base, unitIds: c.unitIds.slice(), x: c.x, y: c.y } : null;
    case "attack":
      return ids(c.unitIds) && int(c.targetId) ? { type, ...base, unitIds: c.unitIds.slice(), targetId: c.targetId } : null;
    case "stop":
    case "anchor":
    case "packUp":
      return ids(c.unitIds) ? { type, ...base, unitIds: c.unitIds.slice() } : null;
    case "produce":
    case "cancelProduce":
      return int(c.buildingId) && UNIT_KINDS.has(c.unit as string) ? { type, ...base, buildingId: c.buildingId, unit: c.unit as UnitKind } : null;
    case "startBuilding":
      return BUILDING_KINDS.has(c.building as string) ? { type, ...base, building: c.building as BuildingKind } : null;
    case "cancelBuilding":
    case "resign":
      return { type, ...base };
    case "placeBuilding":
      return int(c.tx) && int(c.ty) ? { type, ...base, tx: c.tx, ty: c.ty } : null;
    case "sell":
      return int(c.buildingId) ? { type, ...base, buildingId: c.buildingId } : null;
    case "rally":
      return int(c.buildingId) && num(c.x) && num(c.y) ? { type, ...base, buildingId: c.buildingId, x: c.x, y: c.y } : null;
    case "calldown":
      return POWERS.has(c.power as string) && num(c.x) && num(c.y) ? { type, ...base, power: c.power as PowerKind, x: c.x, y: c.y } : null;
    case "board":
      return ids(c.unitIds) && int(c.carrierId) ? { type, ...base, unitIds: c.unitIds.slice(), carrierId: c.carrierId } : null;
    case "unload":
      if (!ids(c.unitIds)) return null;
      if (c.x === undefined && c.y === undefined) return { type, ...base, unitIds: c.unitIds.slice() };
      return num(c.x) && num(c.y) ? { type, ...base, unitIds: c.unitIds.slice(), x: c.x, y: c.y } : null;
    case "lift":
      return ids(c.unitIds, 8) && int(c.goliathId) ? { type, ...base, unitIds: c.unitIds.slice(), goliathId: c.goliathId } : null;
    default:
      return null;
  }
}

/**
 * Split an order naming more than MAX_UNITS units into several naming at
 * most that many each, the same order (the sim applies a move unit by unit).
 * `first`: ids to keep in the first piece, in front (a lifted Goliath and its
 * Condors must be named together: sim/lift.ts routeLiftCommand).
 */
export function splitOrder(c: Command, first: ReadonlySet<number> = new Set()): Command[] {
  if (!("unitIds" in c) || c.unitIds.length <= MAX_UNITS) return [c];
  const all = [...c.unitIds.filter((id) => first.has(id)), ...c.unitIds.filter((id) => !first.has(id))];
  const out: Command[] = [];
  for (let i = 0; i < all.length; i += MAX_UNITS) out.push({ ...c, unitIds: all.slice(i, i + MAX_UNITS) } as Command);
  return out;
}

/**
 * Split items into runs that each fit one message of at most MAX_MESSAGE
 * bytes, given `overhead` bytes of message around them (the items' JSON joined
 * by commas). Every run holds at least one item (one over the limit goes
 * alone: splitOrder keeps orders small enough not to be).
 */
export function chunk<T>(items: readonly T[], overhead: number): T[][] {
  const out: T[][] = [];
  let part: T[] = [];
  let size = overhead;
  for (const it of items) {
    const n = JSON.stringify(it).length + 1;
    if (part.length > 0 && size + n > MAX_MESSAGE) {
      out.push(part);
      part = [];
      size = overhead;
    }
    part.push(it);
    size += n;
  }
  if (part.length > 0) out.push(part);
  return out;
}

const parse = (text: string): Record<string, unknown> | null => {
  if (text.length > 4096) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const opener = (x: unknown): x is OpenerId => typeof x === "string" && (OPENER_IDS as readonly string[]).includes(x);
const shortText = (x: unknown, max = 24): string => (typeof x === "string" ? x.replace(/[\u0000-\u001f<>&"]/g, "").slice(0, max) : "");

/** A guest's message as the host may act on it (orders still to sanitize per side), or null. */
export function readGuestMsg(text: string): GuestMsg | null {
  const m = parse(text);
  if (!m) return null;
  switch (m.t) {
    case "hello":
      return int(m.proto) && typeof m.build === "string" && int(m.have) && (m.match === null || typeof m.match === "string")
        ? { t: "hello", proto: m.proto, build: m.build.slice(0, 40), name: shortText(m.name), match: (m.match as string | null)?.slice(0, 40) ?? null, have: m.have }
        : null;
    case "pick":
      return opener(m.opener) ? { t: "pick", opener: m.opener } : null;
    case "cmd":
      return int(m.seq) && m.seq >= 0 && Array.isArray(m.c) && m.c.length <= 64 ? { t: "cmd", seq: m.seq, c: m.c as Command[] } : null;
    case "at":
      return int(m.have) && int(m.tick) ? { t: "at", have: m.have, tick: m.tick } : null;
    case "desync":
      return int(m.tick) ? { t: "desync", tick: m.tick } : null;
    case "ping":
      return num(m.at) ? { t: "ping", at: m.at } : null;
    case "bye":
      return { t: "bye" };
    default:
      return null;
  }
}

const seatPlan = (x: unknown): SeatPlan | null => {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  if (!isFaction(s.side)) return null;
  if (s.kind === "human") return { side: s.side, kind: "human", name: shortText(s.name) };
  if (s.kind === "ai" && typeof s.strategy === "string" && s.strategy in STRATEGIES && typeof s.difficulty === "string" && s.difficulty in DIFFICULTY && int(s.seed))
    return { side: s.side, kind: "ai", strategy: s.strategy as StrategyName, difficulty: s.difficulty as Difficulty, seed: s.seed };
  return null;
};

function readSetup(x: unknown): FfaSetup | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.map !== "string" || !isKnownMapId(s.map) || !int(s.seed)) return null;
  if (!Array.isArray(s.mutators) || !s.mutators.every((id) => (MUTATOR_IDS as readonly string[]).includes(id as string))) return null;
  const openers: Partial<Record<Faction, OpenerId>> = {};
  if (!s.openers || typeof s.openers !== "object") return null;
  for (const [f, o] of Object.entries(s.openers as Record<string, unknown>)) if (isFaction(f) && opener(o)) openers[f] = o;
  if (!Array.isArray(s.seats) || s.seats.length !== SEATS) return null;
  const seats = s.seats.map(seatPlan);
  if (seats.some((p) => !p)) return null;
  const st = s.standIn as Record<string, unknown> | undefined;
  if (!st || typeof st.strategy !== "string" || !(st.strategy in STRATEGIES) || typeof st.difficulty !== "string" || !(st.difficulty in DIFFICULTY) || !int(st.seed))
    return null;
  return {
    id: s.id.slice(0, 40), map: s.map, seed: s.seed, mutators: s.mutators as MutatorId[], openers, seats: seats as SeatPlan[],
    standIn: { strategy: st.strategy as StrategyName, difficulty: st.difficulty as Difficulty, seed: st.seed }
  };
}

const logEvent = (x: unknown): LogEvent | null => {
  if (int(x)) return x;
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if ("ai" in o) return isFaction(o.ai) && typeof o.on === "boolean" ? { ai: o.ai, on: o.on } : null;
  if ("h" in o) return Array.isArray(o.h) && int(o.h[0]) && typeof o.h[1] === "string" ? { h: [o.h[0], o.h[1].slice(0, 16)] } : null;
  // an order: the host stamped and checked it; check it again here (a page acts only on well-formed ones)
  return isFaction(o.faction) ? sanitizeCommand(o, o.faction) : null;
};

/** A host's message as a guest may act on it, or null. */
export function readHostMsg(text: string): HostMsg | null {
  const m = parse(text);
  if (!m) return null;
  switch (m.t) {
    case "lobby": {
      if (!int(m.proto) || !int(m.seat) || typeof m.map !== "string" || !Array.isArray(m.seats) || !Array.isArray(m.mutators)) return null;
      const seats: SeatView[] = [];
      for (const v of m.seats as unknown[]) {
        const s = v as Record<string, unknown>;
        if (!s || !int(s.seat) || !isFaction(s.side) || !["host", "friend", "open"].includes(s.kind as string)) return null;
        seats.push({ seat: s.seat, side: s.side, kind: s.kind as SeatView["kind"], name: shortText(s.name), pick: opener(s.pick) ? s.pick : null, online: s.online === true });
      }
      const difficulty = typeof m.difficulty === "string" && m.difficulty in DIFFICULTY ? (m.difficulty as Difficulty) : "normal";
      const mutators = (m.mutators as unknown[]).filter((id): id is MutatorId => (MUTATOR_IDS as readonly string[]).includes(id as string));
      return { t: "lobby", proto: m.proto, seat: m.seat, seats, map: m.map, mutators, difficulty };
    }
    case "start": {
      const setup = readSetup(m.setup);
      return setup ? { t: "start", setup } : null;
    }
    case "ev": {
      if (!int(m.from) || m.from < 0 || !Array.isArray(m.e) || !int(m.ack)) return null;
      const e = (m.e as unknown[]).map(logEvent);
      return e.every((x) => x !== null) ? { t: "ev", from: m.from, e: e as LogEvent[], ack: m.ack } : null;
    }
    case "pong":
      return num(m.at) ? { t: "pong", at: m.at } : null;
    case "over":
      return { t: "over" };
    case "end":
      return ["left", "desync", "version", "started"].includes(m.why as string) ? { t: "end", why: m.why as "left" | "desync" | "version" | "started" } : null;
    default:
      return null;
  }
}
