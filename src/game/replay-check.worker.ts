/**
 * The battle viewer's check ahead (game/replay.ts): plays a battle record
 * through on this build's sim, off the main thread, and answers with the
 * first tick whose hash doesn't match the record's (null: none).
 */
import { replay, type BattleRecord } from "../arena/record";

self.onmessage = (e: MessageEvent<BattleRecord>) => self.postMessage(replay(e.data).divergedAt);
