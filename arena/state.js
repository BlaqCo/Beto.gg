/**
 * arena/state.js — keeps the recorders' in-progress work in Redis so a restart
 * or deploy doesn't throw away windows and games that are still being recorded.
 */
import { redis, hasRedis } from "./redis.js";

export async function saveJSON(key, obj) {
  try { await redis(["SET", key, JSON.stringify(obj)]); return true; } catch { return false; }
}
export async function loadJSON(key) {
  try { const raw = await redis(["GET", key]); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export async function pushLine(key, obj, keep) {
  try { await redis(["RPUSH", key, JSON.stringify(obj)]); if (keep) await redis(["LTRIM", key, String(-keep), "-1"]); return true; } catch { return false; }
}
export async function loadLines(key) {
  try { const rows = await redis(["LRANGE", key, "0", "-1"]); return Array.isArray(rows) ? rows.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean) : []; } catch { return []; }
}

/**
 * Claim a key once across every running copy of the server (Redis SET NX with an expiry).
 * true = this copy got it; false = another copy already did. Without Redis there is only
 * one copy, so it's always true. A Redis error throws, so callers can refuse instead of
 * risking a duplicate.
 */
export async function claimOnce(key, ttlSec = 3600) {
  if (!hasRedis()) return true;
  return (await redis(["SET", key, `${process.pid}:${Date.now()}`, "NX", "EX", String(ttlSec)])) === "OK";
}
