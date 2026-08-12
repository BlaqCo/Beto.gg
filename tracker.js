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

async function redis(cmd) {
  if (!URL || !TOKEN) return null;
  const res = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json())?.result ?? null;
}

export const breakEven = px => px + 0.03 * Math.min(px, 1 - px);

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
export async function recordSettle(slug, { won, pnl, exitPrice, reason = "expiry" } = {}) {
  let entry = null;
  try {
    if (URL && TOKEN) {
      const raw = await redis(["HGET", KEY_OPEN, slug]);
      if (raw) entry = typeof raw === "string" ? JSON.parse(raw) : raw;
      await redis(["HDEL", KEY_OPEN, slug]);
    }
  } catch { /* fall through to memory */ }
  if (!entry) { entry = memOpen.get(slug) || null; memOpen.delete(slug); }
  if (!entry) return null;                     // never tracked — nothing to join

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
  return row;
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
    g[k].beSum += breakEven(r.entry);
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

export async function analytics({ minN = 5 } = {}) {
  const rows = await getTrades();
  const n = rows.length;
  const wins = rows.filter(r => r.won).length;
  const pnl = rows.reduce((a, r) => a + r.pnl, 0);
  const staked = rows.reduce((a, r) => a + r.size, 0);
  const avgBe = n ? rows.reduce((a, r) => a + breakEven(r.entry), 0) / n : null;

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
