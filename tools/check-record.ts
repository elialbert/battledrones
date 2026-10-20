// Replay a battle record on this build's sim and check its world hashes: the
// end screen's Copy replay JSON (src/game/recorder.ts), a saved duel, or an
// arena battle. Prints "RECORD OK" with what it checked, or where it drifted.
// Usage: npx vite-node tools/check-record.ts <record.json>
import { readFileSync } from "node:fs";
import { replay, type BattleRecord } from "../src/arena/record";
import { worldHash } from "../src/sim/checksum";

const file = process.argv[2];
if (!file) throw new Error("usage: npx vite-node tools/check-record.ts <record.json>");
const r = JSON.parse(readFileSync(file, "utf8")) as BattleRecord;
const res = replay(r);
const mode = r.op ? `op ${r.op}` : r.survival ? `Last Stand (${r.survival.difficulty ?? "normal"})` : "skirmish";
const what = `${r.map}, ${mode}, ${r.turns.length} turns, ${res.checked} hashes through tick ${res.world.tick}, final ${worldHash(res.world)}`;
if (res.divergedAt !== null) {
  console.error(`RECORD DRIFTED at tick ${res.divergedAt} (${what})`);
  process.exitCode = 1;
} else console.log(`RECORD OK (${what})`);
