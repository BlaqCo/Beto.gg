/**
 * arena/tape.js — storage for recorded BTC Up/Down windows ("the tape").
 *
 * One record per finished window:
 *   {
 *     v: 1, family: "btc15" | "btc60", slug, start, end,   // ms epoch
 *     strike,                                              // priceToBeat, USD (null if unknown)
 *     outcome: 1 | 0 | null,                               // 1 = Up won, 0 = Down won
 *     ticks: [[t, bid, ask, listYes, spot], ...]           // YES-side quotes; any field may be null
 *   }
 *
 * Primary store: Upstash Redis (one RPUSH per finished window, so the write
 * count stays around ~120/day). Fallback: an append-only JSONL file, which
 * is fine locally but is wiped on every Railway redeploy.
 */

import fs from "fs";
import path from "path";

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL   || null;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || null;
const KEY = fam => `arena:tape:${fam}`;
// About 31 days of each family (96 fifteen-minute and 24 hourly windows a day),
// roughly 25 MB per family in Redis. Raise with ARENA_KEEP_BTC15 / ARENA_KEEP_BTC60.
const KEEP = { btc15: Number(process.env.ARENA_KEEP_BTC15 || 3000), btc60: Number(process.env.ARENA_KEEP_BTC60 || 750) };
const FILE_DIR = process.env.ARENA_TAPE_DIR || path.join(process.cwd(), "data", "tape");

export const FAMILIES = ["btc15", "btc60"];

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return undefined;
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json())?.result ?? null;
}

export function hasRedis() { return !!(REDIS_URL && REDIS_TOKEN); }

/** Append one finished window. Never throws. */
export async function appendWindow(rec) {
  const line = JSON.stringify(rec);
  try {
    if (hasRedis()) {
      await redis(["RPUSH", KEY(rec.family), line]);
      await redis(["LTRIM", KEY(rec.family), String(-(KEEP[rec.family] || 1000)), "-1"]);
      return "redis";
    }
  } catch (err) {
    console.log(`  ⚠️ [arena] tape write to Redis failed (${err.message}) — writing to file instead`);
  }
  try {
    fs.mkdirSync(FILE_DIR, { recursive: true });
    fs.appendFileSync(path.join(FILE_DIR, `${rec.family}.jsonl`), line + "\n");
    return "file";
  } catch (err) {
    console.log(`  ⚠️ [arena] tape write to file failed: ${err.message}`);
    return null;
  }
}

/** Load windows for a family from Redis (in chunks), else from the JSONL file. */
export async function loadWindows(family, { limit = KEEP[family] || 1000 } = {}) {
  try {
    if (hasRedis()) {
      const len = Number(await redis(["LLEN", KEY(family)])) || 0;
      const from = Math.max(0, len - limit), out = [];
      for (let i = from; i < len; i += 300) {
        const rows = await redis(["LRANGE", KEY(family), String(i), String(Math.min(len - 1, i + 299))]);
        if (Array.isArray(rows)) out.push(...rows.map(safeParse).filter(Boolean));
      }
      return out;
    }
  } catch (err) {
    console.log(`  ⚠️ [arena] tape read from Redis failed: ${err.message}`);
  }
  return loadFile(path.join(FILE_DIR, `${family}.jsonl`)).slice(-limit);
}

/** Read a JSONL tape file (one window per line). */
export function loadFile(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(safeParse).filter(Boolean);
  } catch { return []; }
}

function safeParse(s) {
  try { const r = typeof s === "string" ? JSON.parse(s) : s; return r && r.family && Array.isArray(r.ticks) ? r : null; }
  catch { return null; }
}
