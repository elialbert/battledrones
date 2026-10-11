// The loopback seat server behind `tools/arena.ts serve` (AGENT-BATTLES.md
// "The bridge to the game"): each seat is a URL with a secret token, and the
// token is the seat — it can only see and command its own side.
//
//   POST /seat/<token>/{briefing,observe,look,orders,end_round,wait}   the six tools (JSON in, text out)
//   POST /seat/<token>/status                                          JSON: round, tick, is my turn open…
//   POST /seat/<token>/sync                                            block until my turn opens (or it's over)
//   POST /mcp/<token>                                                  the same tools over MCP (JSON-RPC, Streamable HTTP)
//   GET  /control/<token>/state | /record                              for the LLM driver and spectators
//   POST /control/<token>/{seat_info,usage,abort}
//
// It listens on 127.0.0.1 only. The round resolves once every seat has
// ended its turn (built-in AI seats never hold one up); scripted seats play
// in-process.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Arena } from "../../src/arena/match";
import { SIDES } from "../../src/arena/match";
import { playScripted, type Script } from "../../src/arena/scripted";
import type { Faction } from "../../src/sim/types";

export interface ServeOptions {
  port: number;
  /** Seats played in-process by a script. */
  scripted?: Partial<Record<Faction, Script>>;
  /** End any turn still open after this many seconds (0: never). */
  turnTimeout?: number;
  /** Called after every resolved round (write the record). */
  onRound?: () => void;
  log?: (line: string) => void;
}

export interface ArenaServer {
  server: Server;
  urls: { blue: string; red: string; control: string; mcp: { blue: string; red: string } };
  /** Resolves when the battle is over. */
  done: Promise<void>;
  close(): Promise<void>;
}

/** The six tools, as MCP (and the plugin) describe them. */
export const TOOL_DEFS = [
  {
    name: "briefing",
    description: "Rules, the order reference, the unit and building tables, the map and the three opener cards. Call this once, first.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "observe",
    description: "What your side can see now: scrap, buildings, units, enemies in sight, enemy buildings as last seen, Uplinks, calldowns, what happened since your last turn and your notes.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "look",
    description: "A close-up text map around x, y (in your own coordinates) with the units you can see on it.",
    inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, r: { type: "integer", default: 6 } }, required: ["x", "y"] }
  },
  {
    name: "orders",
    description: 'Give orders, for example [{"attack": [97, 83], "target": 23}, {"build": "sam-site"}]. Returns ok, or the reason, for each one.',
    inputSchema: { type: "object", properties: { orders: { type: "array", items: { type: "object" } } }, required: ["orders"] }
  },
  {
    name: "end_round",
    description: "End your turn. notes (up to 2000 characters) come back to you next round. radio (up to 120 characters) is heard by spectators only. Returns your next observation once the round has played.",
    inputSchema: { type: "object", properties: { notes: { type: "string" }, radio: { type: "string" } }, required: ["notes"] }
  },
  {
    name: "wait",
    description: "End your turn and skip the next rounds - 1, unless something urgent happens first. Returns your next observation.",
    inputSchema: { type: "object", properties: { rounds: { type: "integer" } }, required: ["rounds"] }
  }
];

const token = () => randomBytes(12).toString("hex");

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      s += c;
      if (s.length > 1e6) req.destroy();
    });
    req.on("end", () => ok(s));
    req.on("error", fail);
  });
}

export async function serveArena(arena: Arena, opts: ServeOptions): Promise<ArenaServer> {
  const log = opts.log ?? (() => {});
  const seatTokens: Record<Faction, string> = { blue: token(), red: token() };
  const controlToken = token();
  const bySeatToken = new Map<string, Faction>(SIDES.map((s) => [seatTokens[s], s]));
  let waiters: (() => void)[] = [];
  let finish!: () => void;
  const done = new Promise<void>((ok) => (finish = ok));
  let timer: NodeJS.Timeout | null = null;

  const notify = () => {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  };
  /** Wait until `cond` holds (re-checked after every change). */
  const until = (cond: () => boolean) =>
    new Promise<void>((ok) => {
      const check = () => (cond() ? ok() : waiters.push(check));
      check();
    });

  /** Resolve rounds while nobody has a turn open; let scripted seats play theirs. */
  const pump = () => {
    let moved = false;
    for (;;) {
      for (const side of SIDES) {
        const script = opts.scripted?.[side];
        if (script && arena.turnOpen(side)) playScripted(arena, side, script);
      }
      if (arena.over || !arena.allEnded()) break;
      arena.resolve();
      moved = true;
      log(`round ${arena.round} at ${arena.status("blue").time}${arena.over ? `: over (${arena.record.end!.winner ?? "draw"}, ${arena.record.end!.reason})` : ""}`);
      opts.onRound?.();
    }
    if (moved) armTimer();
    if (arena.over) finish();
    notify();
  };

  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!opts.turnTimeout || arena.over) return;
    const round = arena.round;
    timer = setTimeout(() => {
      if (arena.round !== round || arena.over) return;
      log(`round ${round}: turn timeout, ending open turns`);
      for (const s of SIDES) if (arena.turnOpen(s)) arena.endRound(s, undefined, undefined, "timeout");
      pump();
    }, opts.turnTimeout * 1000);
  };

  /** A seat's tool call → its text answer. */
  const tool = async (side: Faction, name: string, a: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "briefing":
        return arena.briefing(side);
      case "observe":
        return arena.over ? `${arena.result(side)}\n\n${arena.observe(side)}` : arena.observe(side);
      case "look":
        return arena.look(side, Number(a.x), Number(a.y), a.r === undefined ? undefined : Number(a.r));
      case "orders":
        return arena.orders(side, a.orders ?? []);
      case "end_round":
      case "wait": {
        const msg =
          name === "wait"
            ? arena.wait(side, Number(a.rounds ?? 1), typeof a.notes === "string" ? a.notes : undefined)
            : arena.endRound(side, typeof a.notes === "string" ? a.notes : undefined, typeof a.radio === "string" ? a.radio : undefined, typeof a.how === "string" ? a.how : "end_round");
        pump();
        if (a.wait === false) return msg;
        // play on: block until this seat's next turn opens, and hand it the new observation
        await until(() => arena.over || arena.turnOpen(side));
        return arena.over ? arena.result(side) : `${msg}\n\n${arena.observe(side)}`;
      }
    }
    throw new HttpError(404, `no tool "${name}"`);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      const body = req.method === "POST" ? await readBody(req) : "";
      const json = () => {
        try {
          return (body.trim() ? JSON.parse(body) : {}) as Record<string, unknown>;
        } catch {
          throw new HttpError(400, "body must be JSON");
        }
      };
      if (parts[0] === "seat" && parts.length === 3) {
        const side = bySeatToken.get(parts[1]!);
        if (!side) throw new HttpError(403, "unknown seat");
        const name = parts[2]!;
        if (name === "status") return send(res, 200, arena.status(side));
        if (name === "sync") {
          await until(() => arena.over || arena.turnOpen(side));
          return send(res, 200, arena.status(side));
        }
        return sendText(res, 200, await tool(side, name, json()));
      }
      if (parts[0] === "mcp" && parts.length === 2) {
        const side = bySeatToken.get(parts[1]!);
        if (!side) throw new HttpError(403, "unknown seat");
        if (req.method === "GET") return send(res, 405, { error: "no server-initiated stream: POST JSON-RPC" });
        if (req.method === "DELETE") return send(res, 200, {});
        return mcp(res, json(), side);
      }
      if (parts[0] === "control" && parts[1] === controlToken) {
        const name = parts[2];
        if (name === "state") return send(res, 200, { round: arena.round, over: arena.over, end: arena.record.end, blue: arena.status("blue"), red: arena.status("red") });
        if (name === "record") return send(res, 200, arena.record);
        const a = json();
        const side = a.side === "red" ? "red" : "blue";
        if (name === "seat_info") {
          arena.setSeatInfo(side, { ...(typeof a.player === "string" ? { player: a.player } : {}), ...(a.settings && typeof a.settings === "object" ? { settings: a.settings as Record<string, unknown> } : {}) });
          opts.onRound?.();
          return send(res, 200, { ok: true });
        }
        if (name === "usage") {
          arena.addUsage(side, a as Record<string, number>, typeof a.round === "number" ? a.round : undefined);
          opts.onRound?.();
          return send(res, 200, { ok: true });
        }
        if (name === "abort") {
          arena.abort();
          finish();
          notify();
          return send(res, 200, { ok: true });
        }
        throw new HttpError(404, "no such control call");
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return sendText(res, e.status, e.message);
      log(`error: ${(e as Error).stack ?? e}`);
      return sendText(res, 500, `arena error: ${(e as Error).message}`);
    }
  });

  /** MCP over Streamable HTTP, the small part a tools-only client needs: initialize, tools/list, tools/call, ping. */
  const mcp = async (res: ServerResponse, msg: Record<string, unknown> | Record<string, unknown>[], side: Faction) => {
    const one = async (m: Record<string, unknown>) => {
      const id = m.id;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (id === undefined) return null; // a notification (notifications/initialized…): no answer
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      switch (m.method) {
        case "initialize":
          return ok({
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "battledrones-arena", version: "0.1" },
            instructions: `You command the ${side} side of a Battle Drones battle. Call briefing first, then play rounds (observe, look, orders, end_round) until the battle is over.`
          });
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: TOOL_DEFS });
        case "tools/call": {
          const name = String(params.name);
          try {
            const text = await tool(side, name, (params.arguments ?? {}) as Record<string, unknown>);
            return ok({ content: [{ type: "text", text }] });
          } catch (e) {
            return ok({ content: [{ type: "text", text: (e as Error).message }], isError: true });
          }
        }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } };
      }
    };
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(one))).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202, null);
    }
    const out = await one(msg);
    if (!out) return send(res, 202, null);
    res.setHeader("Mcp-Session-Id", `${side}-${seatTokens[side].slice(0, 8)}`);
    return send(res, 200, out);
  };

  // long waits are normal here (the other seat may think for minutes)
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, "127.0.0.1", () => ok());
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  pump(); // (AI-only and scripted seats may already be able to play)
  armTimer();
  return {
    server,
    urls: {
      blue: `${base}/seat/${seatTokens.blue}`,
      red: `${base}/seat/${seatTokens.red}`,
      control: `${base}/control/${controlToken}`,
      mcp: { blue: `${base}/mcp/${seatTokens.blue}`, red: `${base}/mcp/${seatTokens.red}` }
    },
    done,
    close: () =>
      new Promise<void>((ok) => {
        if (timer) clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => ok());
      })
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === null ? "" : JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
