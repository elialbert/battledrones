/**
 * A tiny tween + timer clock for the 3D view (what Phaser's tweens and
 * delayedCall did). Everything runs on render time: the scene advances it
 * with the frame delta scaled by the finale's slow motion, so a cinematic
 * slows every pop, fade and fall together.
 */

export type Ease = (k: number) => number;

export const Ease = {
  linear: (k: number) => k,
  quadIn: (k: number) => k * k,
  quadOut: (k: number) => k * (2 - k),
  cubicOut: (k: number) => 1 - Math.pow(1 - k, 3),
  sineOut: (k: number) => Math.sin((k * Math.PI) / 2),
  sineInOut: (k: number) => -(Math.cos(Math.PI * k) - 1) / 2,
  backOut: (k: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  }
} satisfies Record<string, Ease>;

export interface TweenSpec {
  /** Duration, ms. */
  dur: number;
  delay?: number;
  ease?: Ease;
  /** Play forward then back (k goes 0 → 1 → 0). */
  yoyo?: boolean;
  /** Grouping key for kill(owner). */
  owner?: unknown;
  /** Called every frame with the eased progress. */
  update?(k: number): void;
  done?(): void;
}

interface Running extends TweenSpec {
  t: number;
  dead: boolean;
}

export class Tweens {
  private list: Running[] = [];

  add(spec: TweenSpec): void {
    this.list.push({ ...spec, t: 0, dead: false });
  }

  /** Run `fn` after `ms` of render time. */
  after(ms: number, fn: () => void, owner?: unknown): void {
    this.add({ dur: 0, delay: ms, owner, done: fn });
  }

  /** Stop (without finishing) every tween registered with this owner. */
  kill(owner: unknown): void {
    for (const t of this.list) if (t.owner === owner) t.dead = true;
  }

  update(dtMs: number): void {
    if (this.list.length === 0) return;
    const live: Running[] = [];
    // (callbacks may add tweens: iterate a snapshot, keep the new ones)
    const list = this.list;
    this.list = [];
    for (const tw of list) {
      if (tw.dead) continue;
      tw.t += dtMs;
      const delay = tw.delay ?? 0;
      if (tw.t < delay) {
        live.push(tw);
        continue;
      }
      const raw = tw.dur <= 0 ? 1 : Math.min(1, (tw.t - delay) / tw.dur);
      const k = tw.yoyo ? 1 - Math.abs(raw * 2 - 1) : raw;
      tw.update?.((tw.ease ?? Ease.linear)(k));
      if (raw >= 1) {
        tw.dead = true;
        tw.done?.();
      } else live.push(tw);
    }
    this.list = live.concat(this.list);
  }

  get size(): number {
    return this.list.length;
  }

  clear(): void {
    this.list = [];
  }
}
