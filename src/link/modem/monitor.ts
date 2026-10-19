/**
 * The self-monitor (SOUND-DUEL.md "The modem" > Receiver > Self-monitor): a
 * second, pilots-only receiver on this phone's own transmission as its own
 * microphone hears it. It finds each sync it sent (it knows when and with
 * which pattern) in the half second after it went out, which gives the
 * speaker-to-microphone delay, then follows that superframe's pilots at the
 * known symbol times: their phase errors are the own signal's effective SNR,
 * which the lobby's route check reads (a phone whose sound went to the
 * earpiece or to Bluetooth barely hears itself).
 *
 * Speaker and microphone share one clock, so there is no ε to track.
 *
 * Once the loopback is known, each sync is looked for only within ±40 ms of
 * it (the correlator works in blocks of about 60 ms, so this costs no more
 * than a tighter window). The delay can move: a new microphone route, or the
 * same node re-fed after "Tap to reconnect", has its own latency. A move
 * within the window is simply followed at the next sync. Two syncs in a row
 * missing from it mean the loopback is stale, and the next sync gets the
 * full half-second search again (the pilots meanwhile are followed where
 * the sync should have been, so the SNR reads low).
 */
import type { Timing } from "./params";
import type { InputRing } from "./ring";
import { RHO_DETECT, RHO_KEEP, type CorrBand, type Recorr, type SyncSearch } from "./sync";
import { Tracker } from "./tracker";
import type { SyncMark, Transmitter } from "./tx";
import type { ModemMode } from "../transport";

/** How long after sending a sync the monitor looks for it (no loopback known yet). */
const SEARCH_S = 0.5;
/** How far either side of the known loopback it looks once it has one. */
const NEAR_S = 0.04;
/** Symbols the SNR is averaged over. */
const SNR_SYMBOLS = 8;
/** Syncs in a row not found near the known loopback before it is searched for afresh. */
const STALE_AFTER = 2;

export class SelfMonitor {
  private readonly t: Timing;
  private readonly tracker: Tracker;
  private corr: CorrBand | null = null;
  /** Speaker-to-microphone delay (samples), once heard. */
  loop: number | null = null;
  ownSnrDb: number | null = null;
  /** Syncs sent that still await their search: when each went out, its pattern, and the window it is looked for in. */
  private readonly pendE = new Float64Array(8);
  private readonly pendMode: ModemMode[] = ["robust", "robust", "robust", "robust", "robust", "robust", "robust", "robust"];
  private readonly pendFrom = new Float64Array(8);
  private readonly pendTo = new Float64Array(8);
  /** The search had no loopback to go by (the full half second, and the detection threshold). */
  private readonly pendWide = new Uint8Array(8);
  private pendHead = 0;
  private pendCount = 0;
  private lastMark = -Infinity;
  /** Syncs in a row not found near the known loopback. */
  private misses = 0;
  private readonly rc: Recorr = { rho: 0, t: 0, mode: null };
  private readonly e2 = new Float64Array(SNR_SYMBOLS);
  private readonly cnt = new Float64Array(SNR_SYMBOLS);
  private slot = 0;
  private seen = 0;
  private wFrom = 0;
  private wTo = 0;

  constructor(t: Timing) {
    this.t = t;
    this.tracker = new Tracker(t);
  }

  /** Follow this band (the one this phone transmits in). */
  configure(corr: CorrBand): void {
    this.corr = corr;
    this.tracker.stop();
    this.pendCount = 0;
    this.ownSnrDb = null;
    this.e2.fill(0);
    this.cnt.fill(0);
    this.seen = 0;
    this.misses = 0;
  }

  /** The frame counter went back: forget the syncs pending on the old timeline (the loopback, a property of the phone, stays). */
  reset(): void {
    this.tracker.stop();
    this.pendCount = 0;
    this.lastMark = -Infinity;
    this.misses = 0;
  }

  step(tx: Transmitter, search: SyncSearch, ring: InputRing, budget: number): void {
    const corr = this.corr;
    if (!corr) return;
    // new syncs on air
    const marks = tx.syncs;
    for (let i = 0; i < marks.length; i++) {
      const m: SyncMark = marks[(tx.syncHead + i) % marks.length]!;
      if (m.useful <= this.lastMark || m.useful === -Infinity) continue;
      this.lastMark = m.useful;
      if (this.pendCount === this.pendE.length) {
        this.pendHead = (this.pendHead + 1) % this.pendE.length;
        this.pendCount--;
      }
      const at = (this.pendHead + this.pendCount) % this.pendE.length;
      this.searchWindow(m.useful);
      this.pendE[at] = m.useful;
      this.pendMode[at] = m.mode;
      this.pendFrom[at] = this.wFrom;
      this.pendTo[at] = this.wTo;
      this.pendWide[at] = this.loop === null ? 1 : 0;
      this.pendCount++;
      search.wantMonitor(this.wFrom, this.wTo);
    }
    // the oldest search whose ρ is in (over the window asked for when it was sent)
    while (this.pendCount > 0) {
      const E = this.pendE[this.pendHead]!;
      const mode = this.pendMode[this.pendHead]!;
      const from = this.pendFrom[this.pendHead]!;
      const to = this.pendTo[this.pendHead]!;
      const wide = this.pendWide[this.pendHead] === 1;
      if (to < ring.oldest()) {
        this.pop();
        continue;
      }
      if (!search.findIn(corr, mode, from, to, this.rc)) break;
      this.pop();
      if (this.rc.rho >= (wide ? RHO_DETECT : RHO_KEEP)) {
        this.loop = this.rc.t - E;
        this.misses = 0;
        this.follow(corr, this.rc.t);
      } else if (this.loop !== null) {
        // not heard where it should be: keep listening there (the SNR will say how badly), and after
        // STALE_AFTER such syncs search the whole half second again
        this.follow(corr, E + this.loop);
        if (!wide && ++this.misses >= STALE_AFTER) {
          this.loop = null;
          this.misses = 0;
        }
      } else if (wide) {
        this.ownSnrDb = 0;
      }
    }
    // the pilots
    const tr = this.tracker;
    let used = 0;
    while (tr.active && used < budget) {
      used += tr.work(ring, budget - used);
      if (!tr.finalized) break;
      const j = tr.lastJ;
      if (j === 0 || tr.erased[j]) continue;
      this.e2[this.slot] = tr.perr[j]!;
      this.cnt[this.slot] = tr.pcnt[j]!;
      this.slot = (this.slot + 1) % SNR_SYMBOLS;
      if (++this.seen >= 4) {
        let e = 0;
        let n = 0;
        for (let i = 0; i < SNR_SYMBOLS; i++) {
          e += this.e2[i]!;
          n += this.cnt[i]!;
        }
        this.ownSnrDb = n > 0 ? 10 * Math.log10(n / Math.max(e, 1e-9)) : 0;
      }
    }
  }

  get loopbackMs(): number | null {
    return this.loop === null ? null : (this.loop / this.t.sr) * 1000;
  }

  /** Where to look for the sync sent at E (input frames): wFrom … wTo. */
  private searchWindow(E: number): void {
    const r = Math.round(NEAR_S * this.t.sr);
    this.wFrom = this.loop === null ? E : E + this.loop - r;
    this.wTo = this.loop === null ? E + SEARCH_S * this.t.sr : E + this.loop + r;
  }

  private pop(): void {
    this.pendHead = (this.pendHead + 1) % this.pendE.length;
    this.pendCount--;
  }

  private follow(corr: CorrBand, t0: number): void {
    this.tracker.begin(corr.tables, t0, 0, true, false, 41);
  }
}
