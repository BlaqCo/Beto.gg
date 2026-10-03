/**
 * arena/votes.js — the Council's ballot box.
 * A vote picks which strategy gets the next forward-test slot. It never
 * decides what is profitable and never turns on real money.
 * Record: { at, round, voter, strategy, family, reason }
 */
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL   || null;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || null;
const KEY = "arena:votes";
const memory = [];

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return undefined;
  const res = await fetch(REDIS_URL, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json())?.result ?? null;
}

export async function addVote({ round, voter, strategy, family, reason = "" }) {
  if (!voter || !strategy) throw new Error("voter and strategy are required");
  const rec = { at: Date.now(), round: String(round || new Date().toISOString().slice(0, 13)), voter: String(voter).slice(0, 32),
                strategy: String(strategy).slice(0, 64), family: String(family || "").slice(0, 8), reason: String(reason).slice(0, 280) };
  try { if ((await redis(["LPUSH", KEY, JSON.stringify(rec)])) !== undefined) { await redis(["LTRIM", KEY, "0", "499"]); return rec; } } catch {}
  memory.unshift(rec); memory.length = Math.min(memory.length, 500);
  return rec;
}

export async function recentVotes(n = 20) {
  try {
    const rows = await redis(["LRANGE", KEY, "0", String(n - 1)]);
    if (Array.isArray(rows)) return rows.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch {}
  return memory.slice(0, n);
}
