/**
 * tracker.js — BETO.GG trade ledger + edge analytics
 *
 * Every bet the bot places is recorded here with the full context that
 * decides whether it was a good bet: league, entry price, spread, book
 * depth, discount from high-water, live vs pre-game, maker vs taker, hour
 * of day. When it settles, the outcome is joined on.
 *
 * The point is persistence. The in-memory calibration ledger reset on every
 * deploy, which is why months of betting never produced a usable answer.
 * This writes to Upstash Redis, so the sample survives restarts and keeps
 * accumulating until it can actually say something.
 *
 * Break-even is computed exactly, not approximated:
 *   fee per contract = 3% × min(p, 1−p)
 *   break-even win rate = p + 0.03 × min(p, 1−p)
 * A segment only counts as an edge if its realised win rate beats that.
 */

import { breakEven as feeBreakEven } from "./fees.js";

const URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL   || null;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || null;
const KEY_TRADES = "beto:trades";     // list of settled trades (JSON)
const KEY_OPEN   = "beto:open";       // hash slug → entry context
const MAX_TRADES = 5000;

let memTrades = [];                   // fallback when Redis is unavailable
let memOpen = new Map();
let redisOk = URL && TOKEN ? null : false;
let cache = { rows: null, ts: 0 };
const TTL = 20_000;

// REAL FIX for the 10-16s scan slowdown: every other network call in this
// codebase has an explicit timeout (axios calls use 8-12s). This one never
// did. tracker.claimMarket() is called once per surviving candidate with NO
// caching — a single slow/hanging Upstash response, multiplied across a
// handful of sequential calls per scan, is exactly how a scan goes from
// under a second to 10+. A hard timeout bounds the worst case per call
// instead of leaving it open-ended, and falls back to the existing
// in-memory path exactly like any other Redis failure already does.
const REDIS_TIMEOUT_MS = 2500;
let _redisTimeoutCount = 0;

async function redis(cmd) {
  if (!URL || !TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REDIS_TIMEOUT_MS);
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`redis ${res.status}`);
    return (await res.json())?.result ?? null;
  } catch (err) {
    if (err.name === "AbortError") {
      _redisTimeoutCount++;
      if (_redisTimeoutCount === 1 || _redisTimeoutCount % 20 === 0) {
        console.log(`⏱ Redis call timed out after ${REDIS_TIMEOUT_MS}ms (${_redisTimeoutCount} total) — falling back to memory for this call`);
      }
      throw new Error(`redis timeout after ${REDIS_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Correct model (docs.polymarket.us/fees): Θ × p × (1−p), taker 0.06,
// maker −0.0125. Maker fills need a LOWER win rate because of the rebate.
export const breakEven = (px, isMaker = false) => feeBreakEven(px, isMaker);

/** Called the moment a bet fills. */
export async function recordEntry(ctx) {
  const row = {
    slug: ctx.slug,
    question: ctx.question || "",
    league: (ctx.league || "OTHER").toUpperCase(),
    entry: +Number(ctx.entry || 0).toFixed(4),
    size: +Number(ctx.size || 0).toFixed(2),
    spread: ctx.spread != null ? +Number(ctx.spread).toFixed(4) : null,
    depth: ctx.depth != null ? Math.round(ctx.depth) : null,
    discount: ctx.discount != null ? +Number(ctx.discount).toFixed(4) : null,
    live: !!ctx.live,
    minsIn: ctx.minsIn != null ? Math.round(ctx.minsIn) : null,
    fill: ctx.maker ? "maker" : "taker",
    hour: new Date().getUTCHours(),
    at: new Date().toISOString(),
  };
  try {
    if (URL && TOKEN) { await redis(["HSET", KEY_OPEN, row.slug, JSON.stringify(row)]); redisOk = true; }
    else memOpen.set(row.slug, row);
  } catch { memOpen.set(row.slug, row); redisOk = false; }
  return row;
}

/** Called when the bet settles (or is sold). */
export async function recordSettle(slug, { won, pnl, exitPrice, reason = "expiry", fallback = null } = {}) {
  let entry = null;
  try {
    if (URL && TOKEN) {
      const raw = await redis(["HGET", KEY_OPEN, slug]);
      if (raw) entry = typeof raw === "string" ? JSON.parse(raw) : raw;
      await redis(["HDEL", KEY_OPEN, slug]);
    }
  } catch { /* fall through to memory */ }
  if (!entry) { entry = memOpen.get(slug) || null; memOpen.delete(slug); }
  if (!entry && fallback) {
    // Bet predates the tracker (or the entry record was lost). Record it with
    // the context we do have rather than dropping the result entirely.
    entry = {
      slug, question: fallback.question || "", league: (fallback.league || "OTHER").toUpperCase(),
      entry: +Number(fallback.entry || 0).toFixed(4), size: +Number(fallback.size || 0).toFixed(2),
      spread: null, depth: null, discount: null, live: null, minsIn: null,
      fill: "unknown", hour: new Date().getUTCHours(),
      at: fallback.at || new Date().toISOString(), partial: true,
    };
  }
  if (!entry || !(entry.entry > 0)) return null;   // no usable context

  const row = {
    ...entry,
    won: !!won,
    pnl: +Number(pnl || 0).toFixed(2),
    exit: exitPrice != null ? +Number(exitPrice).toFixed(4) : (won ? 1 : 0),
    reason,
    heldMin: +(((Date.now() - new Date(entry.at).getTime()) / 60000)).toFixed(1),
    settledAt: new Date().toISOString(),
  };
  try {
    if (URL && TOKEN) {
      await redis(["RPUSH", KEY_TRADES, JSON.stringify(row)]);
      await redis(["LTRIM", KEY_TRADES, -MAX_TRADES, -1]);
      redisOk = true;
    } else memTrades.push(row);
  } catch { memTrades.push(row); redisOk = false; }
  cache.ts = 0;
  try { await releaseMarket(slug); } catch {}
  return row;
}

// ── RESTART-PROOF BET LOCK ───────────────────────────────────────
// everBet lives in memory and dies on every deploy, which is how the same
// market got bought twice. This lock lives in Redis: once a market is
// claimed it stays claimed until it settles, across restarts.
const KEY_LOCK = "beto:betlock";
const lockMem = new Map();
const LOCK_TTL_MS = 36 * 3600_000;

let _stackWarned = false;
function warnIfMemoryOnly() {
  if (_stackWarned || (URL && TOKEN)) return;
  _stackWarned = true;
  console.error("🛑🛑 ANTI-STACKING IS MEMORY-ONLY — UPSTASH_REDIS_REST_URL / _TOKEN are not set.");
  console.error("🛑 Every restart wipes the market lock, so the same market CAN be re-bought after");
  console.error("🛑 a redeploy. Add Upstash Redis in Railway → Variables to make this durable.");
}

export async function claimMarket(slug) {
  warnIfMemoryOnly();
  const now = Date.now();
  try {
    if (URL && TOKEN) {
      // HSETNX returns 1 only if the field did not already exist.
      const got = await redis(["HSETNX", KEY_LOCK, slug, String(now)]);
      if (got === 0 || got === "0") {
        const raw = await redis(["HGET", KEY_LOCK, slug]);
        const ts = Number(raw) || 0;
        if (now - ts < LOCK_TTL_MS) return false;      // still locked
        await redis(["HSET", KEY_LOCK, slug, String(now)]);   // stale, reclaim
      }
      return true;
    }
  } catch { /* fall through to memory */ }
  const prev = lockMem.get(slug);
  if (prev && now - prev < LOCK_TTL_MS) return false;
  lockMem.set(slug, now);
  return true;
}

export async function releaseMarket(slug) {
  try { if (URL && TOKEN) await redis(["HDEL", KEY_LOCK, slug]); } catch {}
  lockMem.delete(slug);
}

export async function getTrades({ force = false } = {}) {
  if (!force && cache.rows && Date.now() - cache.ts < TTL) return cache.rows;
  let rows = [];
  try {
    if (URL && TOKEN) {
      const raw = await redis(["LRANGE", KEY_TRADES, 0, -1]);
      rows = (raw || []).map(x => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
      redisOk = true;
    } else rows = memTrades;
  } catch { rows = memTrades; redisOk = false; }
  cache = { rows, ts: Date.now() };
  return rows;
}

// ── aggregation ──────────────────────────────────────────────────
function segment(rows, keyFn, label) {
  const g = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    (g[k] ||= { key: String(k), n: 0, w: 0, pnl: 0, staked: 0, beSum: 0 });
    g[k].n++; if (r.won) g[k].w++;
    g[k].pnl += r.pnl; g[k].staked += r.size;
    g[k].beSum += breakEven(r.entry, r.fill === "maker");
  }
  return Object.values(g).map(x => {
    const rate = x.w / x.n;
    const be = x.beSum / x.n;
    return {
      dimension: label, key: x.key, n: x.n, w: x.w, l: x.n - x.w,
      winRate: +(rate * 100).toFixed(1),
      breakEven: +(be * 100).toFixed(1),
      edge: +((rate - be) * 100).toFixed(1),
      pnl: +x.pnl.toFixed(2),
      roi: x.staked ? +((x.pnl / x.staked) * 100).toFixed(1) : 0,
    };
  }).sort((a, b) => b.edge - a.edge);
}

const bucketOf = px => { const lo = Math.floor(px * 100 / 3) * 3; return `${lo}-${lo + 2}¢`; };

// ── SELF-LEARNING GATE ───────────────────────────────────────────
// The bot consults its own settled results before betting. A league or
// price bucket that has enough history AND is losing by a clear margin
// gets skipped. This is the difference between a bot that repeats a
// mistake and one that stops making it.
let verdictCache = { map: null, ts: 0 };
const VERDICT_TTL = 60_000;

// "Proven winner" requires a materially positive edge, not just a hair above
// zero — this is what earns a league priority ranking and a relaxed model
// bar. Kept distinct from "not proven losing" (edge > 0), which is a much
// weaker bar only used to avoid unfairly blocking a league via a shared
// price bucket.
const BUILD_MIN_EDGE = 3;

export async function segmentVerdicts({ minN = 12, cutoff = -4, buildEdge = BUILD_MIN_EDGE } = {}) {
  if (verdictCache.map && Date.now() - verdictCache.ts < VERDICT_TTL) return verdictCache.map;
  const map = { leagues: {}, buckets: {}, goodLeagues: {}, provenLeagues: {} };
  try {
    const a = await analytics({ minN });
    for (const x of a.byLeague) {
      if (x.n >= minN && x.edge <= cutoff) map.leagues[x.key] = x;
      else if (x.n >= minN && x.edge > 0)  map.goodLeagues[x.key] = x;   // not proven losing
      if (x.n >= minN && x.edge >= buildEdge) map.provenLeagues[x.key] = x;   // proven WINNER
    }
    for (const x of a.byBucket) if (x.n >= minN && x.edge <= cutoff) map.buckets[x.key] = x;
  } catch {}
  verdictCache = { map, ts: Date.now() };
  return map;
}

/** Leagues with enough settled bets AND a real, positive edge over break-even. */
export async function provenWinners(opts = {}) {
  const v = await segmentVerdicts(opts);
  return v.provenLeagues;
}

/** Should this candidate be skipped based on our own results? */
export async function shouldSkip(league, entryPx, opts = {}) {
  const v = await segmentVerdicts(opts);
  const lg = (league || "OTHER").toUpperCase();
  if (v.leagues[lg]) {
    const x = v.leagues[lg];
    return { skip: true, why: `${lg} is ${x.edge} pts below break-even over ${x.n} bets` };
  }
  // A league with a proven positive record isn't blocked by a price bucket
  // that other leagues dragged down — otherwise one bad sport poisons a
  // price range for every sport.
  if (v.goodLeagues[lg]) return { skip: false };
  const lo = Math.floor(entryPx * 100 / 3) * 3;
  const key = `${lo}-${lo + 2}¢`;
  if (v.buckets[key]) {
    const x = v.buckets[key];
    return { skip: true, why: `${key} bucket is ${x.edge} pts below break-even over ${x.n} bets` };
  }
  return { skip: false };
}

/** Wipe stored trade history (and optionally the bet locks). */
const KEY_CUTOFF = "beto:history-cutoff";
let cutoffMem = 0;

/** Bet history is hidden from the dashboard if it closed before this time.
 * This is what actually lets CLEAR hide entries that live in state.js's own
 * memory or in Polymarket's own permanent activity ledger — neither of
 * which this file can reach into or erase. A cutoff timestamp achieves the
 * same visible result (an empty log going forward) without needing to. */
export async function getHistoryCutoff() {
  try {
    if (URL && TOKEN) { const v = await redis(["GET", KEY_CUTOFF]); return Number(v) || 0; }
  } catch {}
  return cutoffMem;
}
async function setHistoryCutoff(ts) {
  try { if (URL && TOKEN) await redis(["SET", KEY_CUTOFF, String(ts)]); } catch {}
  cutoffMem = ts;
}

// ── NEAR-MISS TRACKING ────────────────────────────────────────────
// Every prior tuning round in this project has been: export a log, eyeball
// a handful of rejection lines, guess a new threshold. This replaces the
// guessing with an accumulating record: every candidate that was in-band
// but rejected by a NAMED gate gets logged with exactly how far it missed
// by. Ask BetoBot "what's costing me the most bets?" and get a real answer
// instead of another manual log read.
const KEY_MISSES = "beto:nearmiss";
const MAX_MISSES = 2000;

export async function recordNearMiss({ gate, gapCents, league, question }) {
  const row = { gate, gapCents: +Number(gapCents).toFixed(1), league: (league || "OTHER").toUpperCase(),
                question: String(question || "").slice(0, 60), at: new Date().toISOString() };
  try {
    if (URL && TOKEN) {
      await redis(["RPUSH", KEY_MISSES, JSON.stringify(row)]);
      await redis(["LTRIM", KEY_MISSES, -MAX_MISSES, -1]);
    }
  } catch {}
}

export async function nearMissSummary({ hours = 24 } = {}) {
  let rows = [];
  try {
    if (URL && TOKEN) {
      const raw = await redis(["LRANGE", KEY_MISSES, 0, -1]);
      rows = (raw || []).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    }
  } catch {}
  const cutoff = Date.now() - hours * 3600_000;
  rows = rows.filter(r => new Date(r.at).getTime() > cutoff);

  const byGate = {};
  for (const r of rows) {
    (byGate[r.gate] ||= { gate: r.gate, n: 0, avgGap: 0, sumGap: 0, examples: [] });
    byGate[r.gate].n++;
    byGate[r.gate].sumGap += Math.abs(r.gapCents);
    if (byGate[r.gate].examples.length < 3) byGate[r.gate].examples.push(r);
  }
  const gates = Object.values(byGate).map(g => ({ ...g, avgGap: +(g.sumGap / g.n).toFixed(1) }))
    .sort((a, b) => b.n - a.n);

  return {
    windowHours: hours, total: rows.length, gates,
    verdict: gates.length
      ? `Biggest blocker: ${gates[0].gate} (${gates[0].n} near-misses, averaging ${gates[0].avgGap}¢ short). That's the highest-value single lever to loosen if you want more volume.`
      : `No near-misses recorded in the last ${hours}h — either nothing is close, or volume is too low to say yet.`,
  };
}

export async function clearHistory({ alsoLocks = false } = {}) {
  const before = (await getTrades({ force: true })).length;
  try { if (URL && TOKEN) await redis(["DEL", KEY_TRADES]); } catch {}
  memTrades = [];
  cache = { rows: [], ts: Date.now() };
  verdictCache = { map: null, ts: 0 };
  await setHistoryCutoff(Date.now());   // hide everything up to right now, from EVERY source
  if (alsoLocks) {
    try { if (URL && TOKEN) await redis(["DEL", KEY_LOCK]); } catch {}
    lockMem.clear();
  }
  console.log(`🗑 Cleared ${before} stored trades and hid all bet history before now${alsoLocks ? "; also cleared bet locks" : ""}`);
  return { cleared: before };
}

export async function analytics({ minN = 5 } = {}) {
  const rows = await getTrades();
  const n = rows.length;
  const wins = rows.filter(r => r.won).length;
  const pnl = rows.reduce((a, r) => a + r.pnl, 0);
  const staked = rows.reduce((a, r) => a + r.size, 0);
  const avgBe = n ? rows.reduce((a, r) => a + breakEven(r.entry, r.fill === "maker"), 0) / n : null;

  const byLeague = segment(rows, r => r.league, "league");
  const byBucket = segment(rows, r => bucketOf(r.entry), "price");
  const byFill   = segment(rows, r => r.fill, "fill");
  const byTiming = segment(rows, r => (r.live ? "live" : "pre-game"), "timing");
  const byHour   = segment(rows, r => `${String(r.hour).padStart(2, "0")}:00 UTC`, "hour");
  const bySpread = segment(rows, r => r.spread == null ? null
                     : r.spread <= 0.02 ? "tight ≤2¢" : r.spread <= 0.04 ? "mid 3-4¢" : "wide 5¢+", "spread");

  const green = [...byLeague, ...byBucket, ...byTiming, ...byFill, ...bySpread]
    .filter(x => x.n >= minN && x.edge > 0);
  const red = [...byLeague, ...byBucket, ...byTiming, ...byFill, ...bySpread]
    .filter(x => x.n >= minN && x.edge < -2);

  return {
    persisted: redisOk === true,
    settled: n, wins, losses: n - wins,
    winRate: n ? +((wins / n) * 100).toFixed(1) : null,
    breakEvenAvg: avgBe ? +(avgBe * 100).toFixed(1) : null,
    edge: n && avgBe ? +(((wins / n) - avgBe) * 100).toFixed(1) : null,
    pnl: +pnl.toFixed(2),
    staked: +staked.toFixed(2),
    roi: staked ? +((pnl / staked) * 100).toFixed(1) : null,
    minN,
    byLeague, byBucket, byTiming, byFill, bySpread, byHour,
    green: green.sort((a, b) => b.edge - a.edge).slice(0, 6),
    red: red.sort((a, b) => a.edge - b.edge).slice(0, 6),
    verdict: (() => {
      if (n < 20) return `Collecting — ${n} settled bets. Around 30 gives the first real read, 100 makes it solid.`;
      const e = ((wins / n) - avgBe) * 100;
      if (e > 2)  return `Beating break-even by ${e.toFixed(1)} points over ${n} bets. The edge looks real — concentrate on the green segments.`;
      if (e > -2) return `Within ${Math.abs(e).toFixed(1)} points of break-even over ${n} bets. No clear edge overall; the segment table is where any edge would show.`;
      return `Running ${Math.abs(e).toFixed(1)} points BELOW break-even over ${n} bets. Overall this configuration is losing — cut the red segments.`;
    })(),
    recent: rows.slice(-15).reverse(),
  };
}
