# Sound Duel — 1v1 between two phones, over sound

Two phones on a table play a 1v1 skirmish against each other. They have no
network connection: the only link is each phone's speaker and microphone. Each
phone runs the full deterministic simulation (deterministic lockstep, as
MULTIPLAYER.md plans for internet play). Only the players' orders cross the
air, carried by an acoustic modem in an AudioWorklet.

This document is the specification the implementation follows. Background:
`reports/Audio modem for lockstep multiplayer.md` (research),
`radio-probe.html` (the measurement page) and MULTIPLAYER.md (internet
lockstep, most of whose sim-side decisions carry over).

## What the measurements say

The probe measured an iPhone receiving another phone 10 cm and 30 cm away
(October 2026):

- Power SNR was 40–70 dB in every 1 kHz band from 1 to 21 kHz. Noise is not
  the limit.
- Echo that outlasts the OFDM cyclic prefix is the limit. With 21.3 ms symbols
  and a 5.3 ms prefix, the effective SNR (from measured phase errors) was
  17–31 dB at 10 cm and 9–19 dB at 30 cm. A cluster of reflections arrived
  8–15 ms after the direct sound at 30 cm. Longer symbols with a longer prefix
  fix most of it.
- The sending speaker's harmonics were 40–60 dB down above 4 kHz, but only
  about 20 dB down below 3 kHz.
- Round trip, speaker to its own microphone: 75 ms, identical for eight chirps.
- iOS leaves a 0.1–1.4 s hole in the recording just after the microphone opens.

So the link can carry a few kbit/s each way. That is far more than lockstep
needs, so orders can land about 0.4 s after the tap, as in MULTIPLAYER.md's
internet design.

## Decisions

| Decision | Choice |
|---|---|
| Network model | Deterministic lockstep, one turn per 100 ms tick, input delay D ticks (3–8, chosen at pairing from the measured round trip) |
| Duplex | Both phones transmit all the time, each in its own band (frequency-division duplex) |
| Band plan "high" (default) | Host transmits 9.5–12.5 kHz, guest transmits 16.0–19.0 kHz. Harmonics of the low band land at ≥19 kHz; third-order intermodulation of each band stays clear of the other band |
| Band plan "low" (fallback, audible) | Host 5.0–6.5 kHz, guest 8.0–9.5 kHz, with 200 ms packets. Use it only if a phone can't play 16–19 kHz |
| Modulation | OFDM with 25 Hz tone spacing (40 ms symbols + 10 ms cyclic prefix), differential BPSK ("robust") or differential QPSK ("fast") |
| Coding | Convolutional K=7 rate ½ (133/171), soft Viterbi, interleaved, CRC-16 per packet |
| Packet | High plan: 2 symbols (100 ms), 83 payload bits robust or 188 fast. Low plan: 4 symbols (200 ms), 82 or 186 |
| Transport model | Latest state: each packet carries the newest frame the upper layer handed over, repeated until replaced. No ARQ: lockstep frames repeat every unacknowledged turn |
| Sides | Host plays blue, guest plays red; a rematch swaps them |
| Colours, camera | Fixed side colours (blue is blue on both phones), north up on both, as MULTIPLAYER.md recommends |
| Career | No XP, medals or stars. A separate local sound-duel win/loss record |
| Pause | Local and allowed: the other phone stalls within D ticks and shows "Friend paused" |
| Game speed | Fixed at 1× (a small automatic trim keeps the phones in step) |
| Desync | A world-hash trail exchanged every 5 s. A mismatch ends the match as "no contest" with copyable debug info |
| Rematch | Reloads the page and reopens the lobby with sides swapped; each phone taps once (audio needs a fresh gesture) |
| Gating | No build flag. The code is a lazily loaded chunk behind a menu button, shown only where AudioWorklet, getUserMedia and a secure context exist |

## Architecture

```
            phone A (host, blue)                       phone B (guest, red)
  GameScene ── VersusFeed (MatchFeed) ──┐     ┌── VersusFeed ── GameScene
                  │ Lockstep (codec)    │     │    Lockstep
                  │ Pairing (lobby)     │     │    Pairing
                  └── Session ──────────┘     └── Session
                         │ LinkTransport            │ LinkTransport
                  WorkletTransport               WorkletTransport
                         │ MessagePort              │
                  AudioWorklet: ModemCore     AudioWorklet: ModemCore
                   TX 9.5–12.5 kHz ──────)))  RX 9.5–12.5 kHz
                   RX 16–19 kHz    (((──────  TX 16–19 kHz
```

Everything below the GameScene is pure TypeScript with no DOM, no timers and
no `Math.random` in its logic. Clocks and randomness are injected, so the same
code runs in the browser, in the AudioWorklet and in Node tests.

## Modules and ownership

| Path | Contents |
|---|---|
| `src/sim/setup.ts`, `src/sim/checksum.ts` | `setupWorld(MatchSetup)` and `worldHash(w)` (done) |
| `src/sim/*` | `{ type: "resign"; faction }` command, `world.resigned`, `resign` FxEvent (done) |
| `src/game/controller.ts` | `PLAYER`/`ENEMY` live bindings and `setLocalSide(f)` |
| `src/link/transport.ts` | `LinkTransport` interface and shared link types |
| `src/link/packet-air.ts` | `PacketAir`: a frame-level simulated link (latency, loss, slots) implementing `LinkTransport` for both ends |
| `src/link/modem/*.ts` | The modem DSP: parameters, FEC, CRC, interleaver, scrambler, OFDM transmitter and receiver, `ModemCore` |
| `src/link/sim/room.ts` | A sample-level simulated room for two `ModemCore`s |
| `src/link/room-transport.ts` | `RoomLink`: two `ModemCore`s in a simulated room, exposing two `LinkTransport`s (Node full-stack tests) |
| `src/link/worklet.ts` | The AudioWorkletProcessor wrapping `ModemCore` |
| `src/link/rig.ts` | Opening and closing the audio: session type, context, microphone, wake lock, diagnostics |
| `src/link/worklet-transport.ts` | `WorkletTransport`: the real `LinkTransport` |
| `src/versus/codec.ts` | Bit reader/writer, the command codec |
| `src/versus/lockstep.ts` | `Lockstep`: turns, sealing, frames, acks, stalls, hash trail |
| `src/versus/pairing.ts` | `Pairing`: the lobby protocol state machine |
| `src/versus/session.ts` | Glue: a transport plus pairing, then lockstep; drives both from a clock |
| `src/versus/feed.ts` | `VersusFeed implements MatchFeed`: connects the session to GameScene |
| `src/versus/lobby.ts`, `src/versus/hud.ts` | The lobby sheet; in-match overlays |
| `src/versus/loop-peer.ts` | A headless sim + AI peer in the same page, for `?duel=loop` |
| `src/versus/relay-transport.ts` | A `LinkTransport` through page functions, for `?duel=relay` (Playwright) |
| `src/versus/records.ts` | The sound-duel win/loss record; the battle record to save |

Nothing outside `src/versus/**` and `src/link/**` statically imports them;
`main.ts` loads the lobby with a dynamic `import()`. `src/game/audio.ts` gets
a band guard (`setLinkGuard`), which is plain game code.

## Lockstep

### Turns

A turn is one tick (100 ms). The input delay is `D` ticks, fixed for the match.

- Turns `0 … D-1` are empty for both sides.
- When a phone is about to step tick `t`, it first **seals** its own turn
  `t + D`: it drains the controller's commands, canonicalizes them (below),
  appends them to a local pending queue, and moves as many commands from the
  front of the queue into turn `t + D` as fit in the per-turn budget. The rest
  wait for later turns. Sealing happens once per tick, before the stall check,
  so the peer gets the turn as early as possible.
- The phone may step tick `t` only when it holds the peer's turn `t`. It then
  steps with `[...blue turn t, ...red turn t]`. That order is canonical on both
  phones, whichever side is local. Otherwise it **stalls**: it does not step,
  and tries again next frame.
- Both phones run the **decoded** form of every command, their own included:
  `decode(encode(canonicalize(c)))`. Coordinates are quantized, so this keeps
  the two worlds identical.
- The receiving phone stamps each of the peer's decoded commands with the
  peer's faction. The faction is never on the wire.

The per-turn budget is `min(capacityBits − 40, 600)` bits of encoded commands,
where `capacityBits` is the transport's current payload size.

### Frames

Each phone keeps the newest frame it would send. The transport repeats it in
every packet until a newer one replaces it. A frame describes every turn from
the first one the peer has not acknowledged up to the newest sealed turn, as
many as fit. A lost packet costs nothing as long as a later one arrives before
the turn is needed.

Game frame (all fields MSB-first; `UE` is unsigned Exp-Golomb, `SE` signed
Exp-Golomb, see the codec):

```
kind        1   0 = game frame
paused      1   this phone is paused
rxq         3   this phone's receive quality of the peer, 0-7 (effective SNR / 3 dB, clamped)
to          16  newest turn described (mod 65536)
span        UE  to − from (turns from..to are all described; turns without commands are empty)
tickLag     SE  to − this phone's current tick
ack         SE  ackThrough − to, where ackThrough is the newest peer turn this phone holds with no gaps
nonEmpty    UE  how many turns in from..to have commands
  per non-empty turn, ascending:
    gap     UE  turn − (previous non-empty turn + 1), or turn − from for the first
    count   UE  commands − 1
    command × count            (codec)
hash        1   a checkpoint follows
  hashTick  16  tick of the checkpoint (mod 65536)
  trail     24  the low 24 bits of this phone's hash trail at hashTick
```

Mod-65536 fields are unwrapped to the value nearest the receiver's
expectation. The receiver ignores turns it already holds, and accepts the rest
only if `from ≤ ackThrough + 1`. Frames longer than the transport capacity are
never built: the builder stops adding turns when the next one would not fit,
and lowers `to` accordingly.

### Hash trail

After stepping each tick, the phone folds the world hash into a trail:
`trail = Math.imul(trail ^ worldHash32, 0x01000193) >>> 0`, where
`worldHash32 = parseInt(worldHash(w), 16)`. Every 50 ticks it saves
`(tick, trail)` as a checkpoint and puts the newest checkpoint in its frames
until the peer's ack covers that tick. A receiver compares a checkpoint with
its own trail at that tick, if it has stepped that far, or stores it to
compare later. A mismatch fires `onDesync`. Because it is a trail, a lost
checkpoint cannot hide a divergence.

### Pacing

The phones need no shared clock: the one that is ahead stalls. To avoid
stutter, the feed trims the game speed between 0.9× and 1.1×. Let
`peerTickEstimate = peer's reported tick + (time since that frame arrived) /
100 ms + latencyTicks`, where `latencyTicks` is half the paired round trip in
ticks. Speed = `clamp(1 + 0.04 × (peerTickEstimate − myTick), 0.9, 1.1)`.

### Pause, leaving, resigning

- Pause is local: the paused phone keeps sending frames with `paused = 1` but
  seals nothing new. The other phone stalls within D ticks and shows "Friend
  paused".
- Resign is a sim command (`{ type: "resign", faction }`) that rides the
  stream like any order, so both phones end on the same tick with the normal
  finale.
- Leaving or losing the link is not a sim event. After 5 s of stall with no
  packets, the HUD shows "Signal lost: bring the phones closer". After 60 s it
  offers "Leave match" (recorded as abandoned, no result).

## Command codec (`src/versus/codec.ts`)

Lossless for canonical commands, and stateless across turns.

**Canonicalize** (sender side, before encoding):

- `x`, `y` (map coordinates): `k = clamp(floor(v × 16), 0, size × 16 − 1)`,
  `v' = (k + 0.5) / 16`, where `size` is the map width (x) or height (y). This
  keeps the tile and centres the point in its 1/16-tile cell.
- `unitIds`: sorted ascending, duplicates removed.
- An `unload` without a point stays without one (`x`, `y` absent, never NaN
  or 0).
- `faction` is set to the local side.

**Bit layout of one command** (no faction):

```
type        5   index into COMMAND_TYPES (an explicit fixed table, never Object.keys order)
then by type:
  move, attackMove, harvest:     units, x, y
  attack:                        units, id(targetId)
  stop, anchor, packUp:          units
  produce, cancelProduce:        id(buildingId), unitKind 5
  startBuilding:                 buildingKind 4
  cancelBuilding, callWave:      –
  placeBuilding:                 tx, ty      (ceil(log2(size)) bits each)
  sell:                          id(buildingId)
  rally:                         id(buildingId), x, y
  calldown:                      power 2, x, y
  board:                         units, id(carrierId)
  unload:                        units, hasPoint 1, [x, y]
  lift:                          units, id(goliathId)
  resign:                        –
units  = sameAsPrevious 1 (same list as the previous command in this turn that had units)
         or: count UE, first UE, then (gap − 1) UE for each next id
id     = UE
x, y   = ceil(log2(size × 16)) bits each, the quantized cell index k
```

The enum tables (`COMMAND_TYPES`, `UNIT_KINDS`, `BUILDING_KINDS`,
`POWER_KINDS`) are explicit arrays in the codec, versioned by
`CODEC_VERSION`. A test checks that they cover every kind in the sim's
balance tables. Exp-Golomb: `UE(v)` writes `v + 1` in binary with
`floor(log2(v + 1))` leading zeros; `SE(v)` maps 0, 1, −1, 2, −2… to 0, 1, 2,
3, 4….

## Pairing (`src/versus/pairing.ts`)

The phone that taps **Host** transmits in the host band and listens in the
guest band; **Join** does the reverse. Lobby frames ride the same transport
(`kind = 1`). Each phone sends its current state in rotation, one message per
packet:

```
kind 1 (=1), msg 2:
HELLO  0: role 1 (0 host, 1 guest), proto 4, build 16, nonce 16, heard 16 (the peer nonce I hear, 0 = none),
          rxq 3, ping 8 (my clock in 10 ms units, mod 256), echo 8 (the newest peer ping I heard),
          hold 5 (10 ms units since I heard it, max 31)
CONFIG 1 (host only): nonce 16, map 4 (0-5: built-in MAPS index; 8 + biome 0-4: random map), mutators 12
          (mask in MUTATOR_IDS order), delay 3 (D − 3), hostSide 1 (0 blue), plan 1 (0 high, 1 low), fast 1
PICK   2: nonce 16, confHash 16, opener 2 (OPENER_IDS index), picked 1
GO     3: nonce 16, confHash 16, mine 2, theirs 2
```

- `build` is the first 16 bits of `__SIM_HASH__` XORed with `CODEC_VERSION`
  and the protocol version. A mismatch stops pairing with "These phones run
  different versions: reload both".
- The match seed is `hash32(hostNonce, guestNonce, 1)`, and a random map's
  seed is `hash32(hostNonce, guestNonce, 2)` (`src/sim/rand.ts` hash32), so
  neither needs sending.
- `confHash` is a 16-bit hash of the decoded config plus both nonces. Both
  phones must agree on it before GO.
- The round trip comes from HELLO's ping, echo and hold:
  `rtt = now − ping_sent − hold`. The host picks `D = clamp(ceil((rtt / 2 +
  150 ms) / 100 ms), 3, 8)`.
- `fast` is set when both phones report `rxq ≥ 5` (about 15 dB).
- Stages: hearing each other (nonces echoed both ways) → config agreed (the
  guest's PICK carries the host's confHash) → both picked → GO. A phone starts
  its match once it has sent GO and heard the peer's GO or a game frame.
  Turns `0 … D-1` are empty, so the phone that loads faster simply stalls at
  tick D until the other starts.

## The modem (`src/link/modem/`)

### Numerology

- Sample rate `sr`: whatever the AudioContext runs at. Supported when
  `0.04 × sr` and `0.01 × sr` are integers (44.1, 48, 96 kHz…).
- Tone spacing 25 Hz, useful symbol `TU = 40 ms` (`N = 0.04 × sr` samples),
  cyclic prefix `TCP = 10 ms`, symbol `TS = 50 ms`. Tone `k` has frequency
  `25k` Hz: an exact DFT bin at every supported rate, so a 44.1 kHz phone and
  a 48 kHz phone share one grid.
- Band tones: plan high, host `k = 381…500` (9.525–12.5 kHz), guest
  `k = 641…760` (16.025–19.0 kHz), 120 tones each. Plan low, host
  `k = 201…260` (5.025–6.5 kHz), guest `k = 321…380` (8.025–9.5 kHz), 60
  tones each. A band has pilots at the tones with index `i % 8 == 0` and data
  on the rest: 15 pilots and 105 data tones (high), 8 and 52 (low).
- Packet length `P`: 2 symbols (high) or 4 (low).
- Superframe: 1 sync symbol, then 40 data symbols (20 packets for high, 10
  for low): 41 symbols, 2.05 s.

### Transmitter

- Each tone's phase advances from one symbol to the next (differential). The
  sync symbol sets a known phase for every tone, so it is also the reference
  for the first data symbol. Pilot tones never change phase after the sync
  symbol.
- Two sync patterns, A and B: fixed pseudo-random phase sets, published as
  constants. A means the next 20 packets are robust, B means fast. The
  transmitter changes mode only at a superframe boundary.
- Packet bits: payload (exactly `capacity` bits, zero-padded), then CRC-16
  (CCITT, poly 0x1021, init 0xFFFF, MSB-first, over the payload bits), then 6
  zero tail bits. These are convolutionally encoded (K=7, generators 133 and
  171 octal, rate ½), block-interleaved (write row by row into a matrix with
  `dataTones` columns, read column by column), and XORed with a PN sequence
  (LFSR x⁹ + x⁵ + 1, seed 0x1FF + packet index within the superframe).
  `capacity = P × dataTones × bitsPerTone / 2 − 16 − 6`.
  - Robust: each data tone's phase change is 0 or π (1 bit). High: 2 × 105 =
    210 coded bits, capacity 83. Low: 4 × 52 = 208, capacity 82.
  - Fast: each data tone's phase change is Gray-coded from 2 bits: 00→0,
    01→π/2, 11→π, 10→3π/2. High: capacity 188. Low: capacity 186.
  - The interleaver is a fixed permutation in which any 12 consecutive coded
    bits land on different tones, at least 5 tones apart, and spread over the
    packet's symbols.
- Symbol synthesis: the sum of the band's tones at equal amplitude, the
  previous symbol's phases plus this symbol's changes, over `TCP + TU`. Each
  symbol fades in and out with a 1.25 ms raised cosine overlapping the next
  symbol's prefix. Per-tone amplitude puts the band's RMS at −18 dBFS × gain,
  with a hard limit at ±0.9.
- The payload is the newest one `setPayload` delivered before the packet's
  first symbol starts. Without one, a packet carries all zeros. Upper layers
  treat a frame of all zeros as nothing.

### Receiver

- **Acquisition**: correlate the input with both sync symbols (band-limited,
  FFT overlap-save). A normalized correlation above 0.3 that is the
  strongest within ±25 ms marks a superframe start, and its pattern gives the
  mode.
- **Symbols**: the DFT window for symbol `m` starts `TCP − 2 ms` after the
  symbol's start (2 ms of back-off inside the prefix tolerates timing error
  and pre-echo). The phone computes the band's tones only (Goertzel or direct
  DFT).
- **Tracking**: per symbol, take the differential product on the pilots,
  `d_k = X_k(m) · conj(X_k(m−1))`, and fit a phase slope through the origin,
  `s = Σ |d_k| f_k arg(d_k) / Σ |d_k| f_k²`. Remove `e^{−j s f_k}` from every
  tone's differential product. Accumulate the implied timing drift `s / 2π`,
  and when it passes half a sample, move the window one sample and correct
  that symbol's phase. Clock offsets up to ±300 ppm must track.
- **Soft bits**: robust uses `Re(d̃)`; fast rotates by −π/4 and uses `Re` and
  `Im`. Both are normalized by the mean amplitude of the packet's data tones.
  Then descramble, deinterleave, soft Viterbi, and check the CRC.
- **Quality**: the effective SNR per packet is `1 / mean(phase error²)` over
  the pilots (dB). Packets with a good CRC are delivered with that SNR.
- **Superframes**: at each expected sync position, re-correlate ±5 ms to
  refine timing and read the mode. After 3 superframes without a good packet,
  drop lock and search again.

### `ModemCore` API

```ts
export type ModemMode = "robust" | "fast";
export type BandPlan = "high" | "low";
export type BandRole = "host" | "guest";
export interface ModemConfig {
  sampleRate: number;
  plan: BandPlan;
  /** Which band this phone transmits in; it receives the other (or the same, for self-test). */
  tx: BandRole;
  rx: BandRole;
  /** Linear output gain (1 = band RMS at −18 dBFS). */
  gain?: number;
}
export interface RxPacket { bits: Uint8Array; nbits: number; mode: ModemMode; snrDb: number; frame: number }
export interface ModemStats {
  frame: number; locked: boolean; rxMode: ModemMode | null; txMode: ModemMode;
  snrDb: number | null; rxOk: number; rxBad: number; syncs: number; clockPpm: number | null; txPackets: number;
}
export class ModemCore {
  constructor(cfg: ModemConfig);
  /** One audio block: read `input` (microphone), fill `output` (speaker); the same length (128 in the worklet). */
  process(input: Float32Array, output: Float32Array): void;
  /** The payload every packet repeats from now on (MSB-first bits, nbits ≤ capacity(txMode)). */
  setPayload(bits: Uint8Array, nbits: number): void;
  /** The mode from the next superframe on. */
  setTxMode(mode: ModemMode): void;
  capacity(mode?: ModemMode): number;
  /** Packets decoded since the last call. */
  take(): RxPacket[];
  stats(): ModemStats;
}
```

Bits are packed MSB-first into bytes: bit `i` is `(bits[i >> 3] >> (7 - (i & 7))) & 1`.

## Link layer (`src/link/`)

```ts
export interface LinkPacket { bits: Uint8Array; nbits: number; snrDb: number | null; at: number }
export interface LinkStats {
  locked: boolean; snrDb: number | null; rxOk: number; rxBad: number; txMode: ModemMode; rxMode: ModemMode | null;
  /** Milliseconds since the last good packet (Infinity: none yet). */
  sinceRx: number;
}
export interface LinkTransport {
  /** Payload bits per packet in the current TX mode. */
  capacity(): number;
  /** The frame every packet repeats until replaced. */
  send(bits: Uint8Array, nbits: number): void;
  /** Packets received since the last call. */
  poll(): LinkPacket[];
  /** Milliseconds on this link's clock (the audio clock for real links). */
  now(): number;
  setMode(mode: ModemMode): void;
  stats(): LinkStats;
  close(): void;
}
```

- `PacketAir` gives two connected ends. Packets go out every 100 ms per end
  (independent phases). Each packet is delivered after `latencyMs` (default
  250) with a seeded Bernoulli or Gilbert–Elliott loss. It is driven by
  `advance(ms)` in tests, or a real timer in `?duel=loop`. Capacity follows
  the mode (83 or 188), and both can be overridden for tests.
- `WorkletTransport` posts `send` to the worklet, receives packets and stats
  over its MessagePort, and keeps `now()` from the worklet's frame counter.
- `RoomLink` runs two `ModemCore`s through `Room` in 128-frame blocks, for
  Node full-stack tests.

### Worklet message protocol

- Main → worklet: `{ t: "payload", bits: ArrayBuffer, nbits }`,
  `{ t: "mode", mode }`, `{ t: "config", ... }`, `{ t: "close" }`.
- Worklet → main: `{ t: "rx", bits, nbits, mode, snrDb, frame }`, a
  `{ t: "stats", ...ModemStats }` about four times a second, and
  `{ t: "gap", frames }` when `currentFrame` jumps or the input goes missing.
  The receiver resets its timing after a gap.

The worklet is built by Vite from `src/link/worklet.ts` (`?worker&url`, so
it is bundled into a single file and precached by the PWA) and loaded with
`audioWorklet.addModule(url)`.

### Rig (`src/link/rig.ts`)

This ports the probe's `Rig`:

- `open({ micMode })` runs synchronously inside the tap: set
  `navigator.audioSession.type = "play-and-record"`, create an AudioContext
  (`latencyHint: "interactive"`, default rate), resume it, and play a
  1-sample silent buffer. Then it asks for the microphone with
  `echoCancellation`, `noiseSuppression` and `autoGainControl` false ("raw",
  the default) or with echo cancellation on ("voice"). Capture uses 2
  discrete channels, summed.
- It holds a screen wake lock.
- `info()` and `health()` give diagnostics.
- `close()` stops the tracks, closes the context and sets the session back to
  "auto".
- The link context is separate from the game's (`sfx`) context. The mic stays
  open from the lobby until the player leaves the duel. Lockstep starts only
  after 1.5 s of capture with no gaps.

### Game audio guard

The game's own sound would jam the modem. `sfx.setLinkGuard(true)` does three
things:

- Inserts a high-pass (~300 Hz, to cut the sub-bass that makes speakers
  distort) before the compressor.
- Inserts a linear-phase FIR low-pass after it (ConvolverNode, designed at the
  context rate; flat to 8 kHz, at least 70 dB down from 9.5 kHz; for plan low,
  flat to 4 kHz, at least 60 dB down from 5 kHz).
- Lowers the master gain by 10 dB.

It also turns spoken announcer lines off: speechSynthesis can't be filtered.
`setLinkGuard(false)` restores everything.

## Game integration

- `controller.ts`: `export let PLAYER`, `export let ENEMY`,
  `setLocalSide(f)`, called once before `new GameScene`. In single player the
  AI plays `ENEMY` and openers apply blue then red. The dev-only `?side=red`
  plays red against a blue AI.
- `GameScene` with a feed that has `local` set (an interactive feed):
  - no AI commanders;
  - `ctrl.drainCommands()` is left to the feed (not drained and dropped);
  - a stall holds the interpolation (`acc` kept just under one tick);
  - game speed comes from `feed.speed()`, the speed chip is hidden and holding
    the clock does nothing;
  - the debug fog toggle is gone from the pause menu;
  - the pause menu gains Resign (with confirmation) and Leave;
  - labels read "vs <friend>";
  - `settleCareer` is skipped;
  - the end report shows the duel result, the sound-duel record, link stats
    and "In sync ✓";
  - `abort(reason)` ends the match without a sim winner (desync "no contest",
    or leaving).
- The menu's Skirmish tab gains "🔊 Duel a friend (sound)". Its tap runs
  `rig.open` and `sfx.unlock` synchronously, then lazily imports the lobby.
- Lobby sheet:
  1. **Placement**: "two phones, 10–30 cm apart, speakers facing, volume about
     75%, silent switch off".
  2. **Host / Join**, with Advanced settings: band plan, mic mode, and
     "Self-test (one phone)". Self-test transmits and receives in the same
     band and shows packets decoding, to check the modem on one device.
  3. **Live link meter**: packets heard, SNR, round trip.
  4. **Paired**: opener cards, then "Waiting for your friend to pick…".
  5. **GO**, then loading and the match.
  6. **Errors**: version mismatch, microphone refused, nothing heard after
     30 s (with tips).
- In the match, the HUD shows:
  - a link chip (signal bars and the delay);
  - a stall overlay after 0.5 s: "Waiting for your friend…";
  - "Friend paused" while the friend is paused;
  - "Signal lost" after 5 s of silence, and a Leave button after 60 s.
- The report's actions are Rematch (swap sides), Save battle (a BattleRecord
  that plays in 🎬 Watch a replay) and Menu.

### Dev and test modes

- `?side=red` (dev only): single player as red against a blue AI.
- `?duel=loop[&delay=4][&loss=0.1][&latency=250]` (every build): a duel
  against an in-page AI peer through `PacketAir`, with no audio. Use it to
  playtest the delay and lockstep without two phones.
- `?duel=relay&seat=host|guest` (every build, for Playwright): the transport
  calls `window.__duelOut(bitsBase64, nbits)` and receives through
  `window.__duelIn(bitsBase64, nbits)`. `tools/duel-smoke.mjs` connects two
  pages through Node with a seeded delay and loss, plays both sides, and
  checks equal world hashes and the same result.

## Tests

| Test | Checks |
|---|---|
| `tests/resign.test.ts` | resign, draw on mutual resign, setup and hash shared with records (done) |
| `tests/local-side.test.ts` | `setupWorld` identical whoever is local; a red local controller issues red commands; single player as red vs a blue AI plays |
| `tests/versus-codec.test.ts` | Bit I/O and Exp-Golomb; canonicalize is idempotent; decode(encode(c)) equals c (compared with `Object.is` per field) for every command in a corpus from AI-vs-AI arena matches on several maps and mutators, plus hand-written cases for every type; the enum tables are complete |
| `tests/versus-lockstep.test.ts` | Two worlds and two `Lockstep`s through `PacketAir`, AIs on both sides (normal difficulty) for 3+ game minutes: identical hash trails at every tick; with 0%, 10% and 30% loss and 3 s dropouts; bursts that spill across turns; pause; resign ends both on the same tick; a desync injected into one world is detected |
| `tests/versus-pairing.test.ts` | Two `Pairing`s over `PacketAir` agree on config, seed, D and openers; a build mismatch is refused; duplicate or out-of-order lobby frames are harmless |
| `tests/link-fec.test.ts` | CRC-16 known vectors; convolutional code plus Viterbi corrects scattered errors; interleaver and scrambler round trip |
| `tests/link-modem.test.ts` | Two `ModemCore`s through `Room`, both transmitting at once at 48/48 and 48/44.1 kHz, ±150 ppm, measured-like echo and noise: robust packets at least 99% good in a "20 cm" room and at least 95% in a "40 cm" room; fast at least 98% at "20 cm"; acquisition from a random start; recovery after a 1 s capture gap; mode switch at a superframe; packet latency (send → delivery) under 250 ms plus the room delay |
| `tests/link-guard.test.ts` | The FIR guard's response: flat in the pass band, at least 70 dB down in the modem band |
| `tests/duel-fullstack.test.ts` | Pairing then a 60 s duel through `RoomLink` (real DSP in a simulated room) with AIs on both phones: identical hash trails, at least 90% of ticks without a stall after the first second |
| `tools/duel-smoke.mjs` | Two Chromium pages through a relay: pairing UI, openers, orders, pause, resign, same hashes and result |

## Risks to check on real phones

- iOS output routing with the microphone open (earpiece versus loudspeaker),
  and what voice processing does to the modem bands. The probe's iPhone send
  runs will show it.
- Each phone's own transmission at its own microphone (full-duplex isolation),
  especially intermodulation into its receive band.
- 16–19 kHz output from phone speakers, and resamplers that cut near 20 kHz.
- Game audio and speaker distortion jamming the 9.5–12.5 kHz band.
- The iOS capture gap when the microphone opens, and when the app comes back
  from the background.
