/**
 * config.js — BETO.GG live configuration store
 *
 * Every tunable lives here instead of being hard-coded in bot-sports.js.
 * Values persist in Upstash Redis (REST, no dependency) and are re-read by
 * the bot on every scan, so changing a setting from the dashboard takes
 * effect within one cycle — no commit, no redeploy, no lost calibration data.
 *
 * If Redis is unavailable the store falls back to memory: the bot keeps
 * running on defaults and the dashboard still works for the session.
 */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL   || null;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || null;
const KEY = "beto:config:sports";

// ── Defaults ─────────────────────────────────────────────────────
// Each entry: value, label, group, and the input hint the dashboard uses.
export const SCHEMA = {
  BET_SIZE:      { v: 1,     label: "Bet size",            group: "Stake",   unit: "$",  step: 0.5,  min: 0.5, max: 100 },
  MAX_CONC:      { v: 9999,  label: "Max open positions",  group: "Stake",   unit: "",   step: 1,    min: 1,   max: 9999 },
  ENTRIES_SCAN:  { v: 9999,  label: "Max entries per scan",group: "Stake",   unit: "",   step: 1,    min: 1,   max: 9999 },

  FAV_MIN:       { v: 0.57,  label: "Price floor",         group: "Edge",    unit: "¢",  step: 0.01, min: 0.30, max: 0.95, pct: true },
  FAV_MAX:       { v: 0.68,  label: "Price cap",           group: "Edge",    unit: "¢",  step: 0.01, min: 0.30, max: 0.95, pct: true },
  PRIORITY_PX:   { v: 0.61,  label: "Priority below",      group: "Edge",    unit: "¢",  step: 0.01, min: 0.30, max: 0.95, pct: true },
  EDGE_MARGIN:   { v: 0.01,  label: "Edge over fee",       group: "Edge",    unit: "¢",  step: 0.005,min: 0,    max: 0.10, pct: true },
  NEAR_LOW_TOL:  { v: 0.01,  label: "Near-low tolerance",  group: "Edge",    unit: "¢",  step: 0.005,min: 0,    max: 0.10, pct: true },

  MIN_LIVE_MIN:  { v: 0,     label: "Wait after tip-off",  group: "Timing",  unit: "min",step: 1,    min: 0,   max: 120 },
  MAKER_MODE:    { v: true,  label: "Post maker orders",   group: "Timing",  bool: true },

  DCA_ENABLED:   { v: true,  label: "Second buy on dip",   group: "Manage",  bool: true },
  DCA_DROP_PCT:  { v: 0.15,  label: "Dip trigger",         group: "Manage",  unit: "%",  step: 0.01, min: 0.05, max: 0.60, pct: true },
  DCA_ADD_MULT:  { v: 0.50,  label: "Dip add size",        group: "Manage",  unit: "×",  step: 0.1,  min: 0.1,  max: 3 },
  TP_ENABLED:    { v: true,  label: "Take profit",         group: "Manage",  bool: true },
  TP_PRICE:      { v: 0.80,  label: "Sell at price",       group: "Manage",  unit: "¢",  step: 0.01, min: 0.50, max: 0.99, pct: true },

  KILL_ENABLED:  { v: false, label: "Circuit breaker",     group: "Safety",  bool: true },
  KILL_FLOOR:    { v: 120,   label: "Stop below",          group: "Safety",  unit: "$",  step: 10,   min: 0,   max: 100000 },
  PAUSED:        { v: false, label: "Pause new bets",      group: "Safety",  bool: true },
};

export const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.v]));

let _cache = { ...DEFAULTS };
let _ts = 0;
let _redisOk = REDIS_URL && REDIS_TOKEN ? null : false;  // null = untested
const TTL_MS = 5_000;

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json())?.result ?? null;
}

/** Current config. Cached briefly so a 3s scan loop doesn't hammer Redis. */
export async function getConfig({ force = false } = {}) {
  if (!force && Date.now() - _ts < TTL_MS) return _cache;
  try {
    const raw = await redis(["GET", KEY]);
    if (raw) {
      const stored = typeof raw === "string" ? JSON.parse(raw) : raw;
      _cache = { ...DEFAULTS, ...stored };
    }
    if (_redisOk === null) { _redisOk = true; console.log("⚙️ config: Redis connected — settings are hot-reloadable"); }
  } catch (err) {
    if (_redisOk !== false) { _redisOk = false; console.log(`⚙️ config: Redis unavailable (${err.message}) — using in-memory defaults`); }
  }
  _ts = Date.now();
  return _cache;
}

/** Merge a patch into config. Values are clamped to the schema. */
export async function setConfig(patch = {}) {
  const next = { ..._cache };
  const applied = {};
  for (const [k, raw] of Object.entries(patch)) {
    const s = SCHEMA[k];
    if (!s) continue;
    let v = raw;
    if (s.bool) v = !!v;
    else {
      v = Number(v);
      if (!Number.isFinite(v)) continue;
      if (s.min != null) v = Math.max(s.min, v);
      if (s.max != null) v = Math.min(s.max, v);
    }
    next[k] = v;
    applied[k] = v;
  }
  if (next.FAV_MAX < next.FAV_MIN) next.FAV_MAX = next.FAV_MIN;   // keep the band coherent
  _cache = next; _ts = Date.now();
  try { await redis(["SET", KEY, JSON.stringify(next)]); } catch { /* memory-only this session */ }
  console.log(`⚙️ config updated: ${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(" ") || "(no valid keys)"}`);
  return { config: _cache, applied, persisted: _redisOk === true };
}

export async function resetConfig() {
  _cache = { ...DEFAULTS }; _ts = Date.now();
  try { await redis(["SET", KEY, JSON.stringify(_cache)]); } catch {}
  return _cache;
}

export function configStatus() {
  return { persisted: _redisOk === true, keys: Object.keys(SCHEMA).length };
}

// ── Funnel telemetry ─────────────────────────────────────────────
// The bot publishes each scan's gate counts here; the dashboard reads them
// to draw the live pipeline. Kept in memory — it is a snapshot, not history.
let _funnel = { ts: 0, stages: [], entries: 0, version: "—", mode: "—" };
export function publishFunnel(f) { _funnel = { ...f, ts: Date.now() }; }
export function getFunnel() { return _funnel; }
