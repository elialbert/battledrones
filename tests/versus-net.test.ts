import { describe, expect, it } from "vitest";
import type { OutFrame } from "../src/link/transport";
import {
  FINAL_CLOSE, NetError, NetTransport, OPEN_TIMEOUT_MS, RETRY_MS, STALE_MS, inviteUrl, isRoomCode, parseInvite, roomCode,
  type NetTimers, type SocketLike
} from "../src/versus/net-transport";

/** Fake timers and clock: advance(ms) runs what falls due, in order. */
function fakeTime() {
  let t = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const timers: NetTimers = {
    setTimeout: (fn, ms) => (due.set(++seq, { at: t + ms, fn, every: null }), seq),
    clearTimeout: (h) => void due.delete(h as number),
    setInterval: (fn, ms) => (due.set(++seq, { at: t + ms, fn, every: ms }), seq),
    clearInterval: (h) => void due.delete(h as number)
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const e of due) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, d] = next;
      t = d.at;
      if (d.every === null) due.delete(id);
      else d.at += d.every;
      d.fn();
    }
    t = end;
  };
  return { now: () => t, timers, advance };
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** The relay (or the network) closed it. */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  hear(data: string) {
    this.onmessage?.({ data });
  }
}

function setup(role: "host" | "guest" = "host") {
  const time = fakeTime();
  const sockets: FakeSocket[] = [];
  const t = new NetTransport({
    code: "K7QM2XP4",
    role,
    url: "wss://relay.test",
    now: time.now,
    timers: time.timers,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    }
  });
  return { t, time, sockets, last: () => sockets[sockets.length - 1]! };
}

const frame = (type: 1 | 2, key = 0): OutFrame => {
  const bits = new Uint8Array(15).fill(0x33);
  bits[0] = (bits[0]! & 0x3f) | (type << 6);
  return { bits, nbits: 120, key };
};

describe("room codes and invite links", () => {
  it("makes 8-character Crockford base32 codes the relay accepts", () => {
    expect(roomCode(new Uint8Array([0, 1, 31, 32, 18, 21, 24, 255]))).toBe("01Z0JNRZ");
    for (let i = 0; i < 200; i++) {
      const c = roomCode();
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(isRoomCode(c)).toBe(true);
    }
    expect(isRoomCode("ILOU0000")).toBe(false);
    expect(isRoomCode("K7QM2")).toBe(false);
  });

  it("puts the code in the fragment of this page's own path, and reads it back", () => {
    const url = inviteUrl({ origin: "https://simonw.github.io", pathname: "/battledrones/v12/" }, "K7QM2XP4");
    expect(url).toBe("https://simonw.github.io/battledrones/v12/#vs=K7QM2XP4");
    expect(parseInvite(new URL(url).hash)).toBe("K7QM2XP4");
    expect(parseInvite("#vs=k7qm2xp4")).toBe("K7QM2XP4");
    expect(parseInvite("#vs=")).toBeNull();
    expect(parseInvite("#vs=K7QM2XP4&x")).toBeNull();
    expect(parseInvite("#replay=1")).toBeNull();
    expect(parseInvite("")).toBeNull();
  });

  it("refuses a code the relay wouldn't take", () => {
    expect(() => new NetTransport({ code: "bad", role: "host", socket: () => new FakeSocket("x") })).toThrow(NetError);
  });
});

describe("NetTransport", () => {
  it("connects to /<code>/<seat> and carries RelayTransport's packets both ways", async () => {
    const host = setup("host");
    const guest = setup("guest");
    expect(host.last().url).toBe("wss://relay.test/K7QM2XP4/host");
    expect(guest.last().url).toBe("wss://relay.test/K7QM2XP4/guest");
    expect(host.t.state).toBe("connecting");
    host.last().open();
    guest.last().open();
    await host.t.opened;
    expect(host.t.state).toBe("open");

    host.t.send([frame(2)]);
    // (one packet per 200 ms period, robust: the first goes at once)
    host.time.advance(150);
    const wire = host.last().sent;
    expect(wire.length).toBe(1);
    expect(wire[0]).toMatch(/^120 [A-Za-z0-9+/=]+$/);
    // (the relay hands it over as it is)
    guest.last().hear(wire[0]!);
    const got = guest.t.poll();
    expect(got.length).toBe(1);
    expect(got[0]!.session).toBe(false);
    expect(Array.from(got[0]!.bits.slice(0, 15))).toEqual(Array.from(frame(2).bits));
    expect(guest.t.stats().rxOk).toBe(1);
  });

  it("drops what isn't a packet", () => {
    const g = setup("guest");
    g.last().open();
    for (const junk of ["", "hello", "x AAAA", "120", " 120 AAAA"]) g.last().hear(junk);
    g.last().onmessage?.({ data: new ArrayBuffer(4) });
    expect(g.t.poll()).toEqual([]);
  });

  it("sends nothing while no socket is open, and reconnects with backoff after an unplanned close", () => {
    const h = setup();
    h.t.send([frame(2)]);
    h.time.advance(1000);
    expect(h.last().sent).toEqual([]);
    h.last().open();
    h.time.advance(200);
    expect(h.last().sent.length).toBe(1);

    h.last().drop(1006);
    expect(h.t.state).toBe("retrying");
    expect(h.sockets.length).toBe(1);
    h.time.advance(RETRY_MS[0] - 1);
    expect(h.sockets.length).toBe(1);
    h.time.advance(1);
    expect(h.sockets.length).toBe(2);
    // (it fails again: the next wait is longer)
    h.last().drop(1006);
    h.time.advance(RETRY_MS[1]);
    expect(h.sockets.length).toBe(3);
    h.last().open();
    expect(h.t.state).toBe("open");
    expect(h.t.connections).toBe(2);
    expect(h.t.stopped).toBe(false);
    // (the backoff starts over once one opens)
    h.last().drop(1001);
    h.time.advance(RETRY_MS[0]);
    expect(h.sockets.length).toBe(4);
  });

  for (const code of Object.keys(FINAL_CLOSE).map(Number))
    it(`ends for good on the relay's close ${code}`, () => {
      const h = setup();
      h.last().open();
      const errors: string[] = [];
      h.t.onError = (m) => errors.push(m);
      h.last().drop(code);
      expect(h.t.stopped).toBe(true);
      expect(h.t.state).toBe("ended");
      expect(errors).toEqual([FINAL_CLOSE[code]]);
      h.time.advance(60_000);
      expect(h.sockets.length).toBe(1);
    });

  it("rejects `opened` on a final close before the first open", async () => {
    const h = setup();
    h.last().drop(4003);
    await expect(h.t.opened).rejects.toThrow(FINAL_CLOSE[4003]);
  });

  it("keeps trying to make the first connection until OPEN_TIMEOUT_MS, then gives up", async () => {
    const h = setup();
    const errors: string[] = [];
    h.t.onError = (m) => errors.push(m);
    for (let i = 0; i < 6; i++) {
      h.last().drop(1006);
      h.time.advance(RETRY_MS[Math.min(i, RETRY_MS.length - 1)]!);
    }
    expect(h.sockets.length).toBe(7);
    expect(h.t.state).toBe("connecting");
    h.time.advance(OPEN_TIMEOUT_MS);
    await expect(h.t.opened).rejects.toThrow(/Couldn't reach the relay/);
    expect(h.t.stopped).toBe(true);
    expect(errors.length).toBe(1);
  });

  it("reconnects a connection that went quiet after delivering packets, once per silence", () => {
    const h = setup();
    h.last().open();
    // (silence before anything arrived is a friend not there yet: no reconnect)
    h.time.advance(STALE_MS * 3);
    expect(h.sockets.length).toBe(1);
    h.last().hear("120 AAAA");
    h.time.advance(STALE_MS + 1000);
    expect(h.sockets[0]!.closedWith).toBe(4500);
    h.time.advance(RETRY_MS[0]);
    expect(h.sockets.length).toBe(2);
    h.last().open();
    h.time.advance(STALE_MS * 3);
    expect(h.sockets.length).toBe(2);
    // (something arrives: the next silence may reconnect again)
    h.last().hear("120 AAAA");
    h.time.advance(STALE_MS + 1000 + RETRY_MS[0]);
    expect(h.sockets.length).toBe(3);
  });

  it("close() lets the socket go and stops for good, without an error", () => {
    const h = setup();
    h.last().open();
    const errors: string[] = [];
    h.t.onError = (m) => errors.push(m);
    h.t.close();
    expect(h.last().closedWith).toBe(1000);
    expect(h.t.stopped).toBe(false);
    h.time.advance(60_000);
    expect(h.sockets.length).toBe(1);
    expect(errors).toEqual([]);
  });
});
