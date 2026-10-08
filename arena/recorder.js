/**
 * arena/recorder.js — records every live BTC "Up or Down" window (15-minute
 * and hourly) so strategies can be replayed against the same prices later.
 *
 * READ-ONLY. It never places, cancels or sells anything. It only reads:
 *   - the public crypto market listing (to find the live windows)
 *   - each live window's best bid/ask (YES = "Up" side)
 *   - BTC spot from Coinbase's public price endpoint
 *   - each finished window's settlement
 *
 * Off unless ARENA_RECORD=true. Tick interval: ARENA_TICK_MS (default 5000).
 */

import axios from "axios";
import * as pm from "../polymarket-us.js";
import { appendWindow } from "./tape.js";
import { saveJSON, loadJSON } from "./state.js";

const STATE_KEY = "arena:state:btc";
const SAVE_EVERY_MS = 60_000;

const GATEWAY = "https://gateway.polymarket.us";
const TICK_MS = Math.max(2000, Number(process.env.ARENA_TICK_MS || 5000));
const LISTING_MS = 0;                       // the listing IS the price source now: refresh it every tick
const BBO_BACKOFF_MS = 60_000;              // after a 429, skip per-market book requests for a minute
const SETTLE_POLL_MS = 30_000;
const SETTLE_GIVE_UP_MS = 6 * 60 * 60_000;  // stop chasing a settlement after 6h (outcome stays null)

const live = new Map();      // slug -> window record being filled
const pending = new Map();   // slug -> { rec, since, lastTry }
let listing = { ts: 0, markets: [] };
let closedCache = { ts: 0, rows: [] };
let bboBlockedUntil = 0;
let spot = { ts: 0, price: null };
let timer = null;
let stats = { started: 0, lastTickAt: 0, enabled: false, ticks: 0, windowsSaved: 0, bboErrors: 0, rateLimited: 0, quotes: {}, lastError: null, savedTo: null };
let warnedNoMarkets = false;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function windowBounds(m) {
  const apt = m.assetPriceTerms || {};
  const start = apt.windowStart ? Date.parse(apt.windowStart) : null;
  const end = apt.windowEnd ? Date.parse(apt.windowEnd) : null;
  return { start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null };
}

/** "btc15" | "btc60" | null — only BTC Up/Down windows, by real duration. */
export function familyOf(m) {
  const q = m?.question || "";
  if (!/\bbtc\b|bitcoin/i.test(q) || !/up\s*or\s*down/i.test(q)) return null;
  if (!m.assetPriceTerms) return null;
  const { start, end } = windowBounds(m);
  if (start == null || end == null) return null;
  const mins = (end - start) / 60_000;
  if (Math.abs(mins - 15) <= 2) return "btc15";
  if (Math.abs(mins - 60) <= 5) return "btc60";
  return null;
}

/**
 * YES bid/ask from the listing's two market sides. The listing carries a price
 * for each side (e.g. Yes 0.13, No 0.88). Whichever convention that price uses,
 * the YES quotes are the Yes price and 1 − No price: the lower is the bid, the
 * higher the ask. Returns nulls if either side is missing or the result is odd.
 */
export function quoteFromListing(m) {
  const sides = Array.isArray(m?.marketSides) ? m.marketSides : [];
  const yes = num(sides.find(s => s.long === true)?.price ?? sides.find(s => s.long === true)?.quote?.value);
  const no  = num(sides.find(s => s.long === false)?.price ?? sides.find(s => s.long === false)?.quote?.value);
  if (yes == null || no == null || !(yes > 0 && yes < 1 && no > 0 && no < 1)) return { bid: null, ask: null };
  const a = yes, b = +(1 - no).toFixed(4);
  const bid = Math.min(a, b), ask = Math.max(a, b);
  if (ask - bid > 0.2) return { bid: null, ask: null };   // implausibly wide: don't trust it
  return { bid, ask };
}

async function refreshListing(now) {
  if (now - listing.ts < LISTING_MS) return false;
  try {
    const res = await axios.get(`${GATEWAY}/v1/markets`, { params: { categories: "crypto", closed: false, limit: 500 }, timeout: 12_000 });
    const markets = Array.isArray(res.data) ? res.data : (res.data?.markets || []);
    listing = { ts: now, markets };
    return true;
  } catch (err) {
    stats.lastError = `listing: ${err.message}`;
    listing.ts = now;           // back off a full interval
    return false;
  }
}

async function getSpot(now) {
  if (spot.price != null && now - spot.ts < 4000) return spot.price;
  try {
    const { data } = await axios.get("https://api.coinbase.com/v2/prices/BTC-USD/spot", { timeout: 4000 });
    const p = num(data?.data?.amount);
    if (p != null) spot = { ts: now, price: p };
  } catch { /* keep the last value; a stale spot is recorded with its own tick time */ }
  return spot.ts && now - spot.ts < 30_000 ? spot.price : null;
}

async function tick() {
  const now = Date.now();
  stats.ticks++;
  stats.lastTickAt = now;
  const fresh = await refreshListing(now);

  // Which windows are live right now?
  const current = [];
  for (const m of listing.markets) {
    const family = familyOf(m);
    if (!family) continue;
    const { start, end } = windowBounds(m);
    if (start <= now && now < end) current.push({ m, family, start, end });
  }
  if (!current.length && !warnedNoMarkets && listing.markets.length) {
    warnedNoMarkets = true;
    const sample = listing.markets.filter(m => /btc|bitcoin/i.test(m.question || "")).slice(0, 4).map(m => JSON.stringify(m.question));
    console.log(`  ⚠️ [arena] no live BTC Up/Down window matched among ${listing.markets.length} crypto markets. Sample: ${sample.join(" | ") || "(no BTC markets)"}`);
  }

  const px = await getSpot(now);
  for (const { m, family, start, end } of current) {
    let rec = live.get(m.slug);
    if (!rec) {
      rec = { v: 1, family, slug: m.slug, start, end,
              strike: pm.extractSettlementNum(m.assetPriceTerms?.priceToBeat), outcome: null, ticks: [] };
      live.set(m.slug, rec);
    }
    if (rec.strike == null) rec.strike = pm.extractSettlementNum(m.assetPriceTerms?.priceToBeat);
    // Prices come from the listing (one request for every market). Fall back to the
    // per-market book only when the listing has no prices and we're not rate-limited.
    let { bid, ask } = fresh ? quoteFromListing(m) : { bid: null, ask: null };
    let src = bid != null ? "L" : null;
    if (bid == null && now >= bboBlockedUntil) {
      try {
        const bbo = await pm.getBBO(m.slug);
        bid = num(bbo?.bid); ask = num(bbo?.ask); src = bid != null ? "B" : null;
        if (bbo == null) stats.bboErrors++;
      } catch (err) {
        if (/429/.test(err.message || "")) { stats.rateLimited++; bboBlockedUntil = now + BBO_BACKOFF_MS; } else stats.bboErrors++;
      }
    }
    if (src) stats.quotes[src] = (stats.quotes[src] || 0) + 1; else stats.quotes.none = (stats.quotes.none || 0) + 1;
    const listYes = fresh ? num(pm.extractYesPrice(m)) : null;
    rec.ticks.push([now, bid, ask, listYes, px, src]);
  }

  // Windows that ended move to the settlement queue.
  for (const [slug, rec] of live) {
    if (now >= rec.end) { live.delete(slug); pending.set(slug, { rec, since: now, lastTry: 0 }); }
  }
  await settlePending(now);
}

async function settlePending(now) {
  for (const [slug, p] of pending) {
    if (now - p.lastTry < SETTLE_POLL_MS) continue;
    p.lastTry = now;
    let outcome = null;
    try { outcome = await pm.getSettlement(slug); } catch { outcome = null; }
    if (outcome == null) {
      // Fallback used by the bots: the closed listing's settlementPrice vs priceToBeat.
      try {
        if (now - closedCache.ts > SETTLE_POLL_MS) {
          const res = await axios.get(`${GATEWAY}/v1/markets`, { params: { categories: "crypto", closed: true, limit: 500 }, timeout: 12_000 });
          closedCache = { ts: now, rows: Array.isArray(res.data) ? res.data : (res.data?.markets || []) };
        }
        const rows = closedCache.rows;
        const hit = rows.find(r => r.slug === slug);
        const s = pm.extractSettlementNum(hit?.assetPriceTerms?.settlementPrice);
        const b = pm.extractSettlementNum(hit?.assetPriceTerms?.priceToBeat);
        if (s != null && b != null && s > 0 && b > 0) outcome = s >= b ? 1 : 0;
        if (p.rec.strike == null && b) p.rec.strike = b;
      } catch { /* try again next poll */ }
    }
    const giveUp = now - p.since > SETTLE_GIVE_UP_MS;
    if (outcome != null || giveUp) {
      p.rec.outcome = outcome;
      pending.delete(slug);
      for (const fn of settledListeners) { try { fn(p.rec); } catch { /* a listener never breaks recording */ } }
      if (p.rec.ticks.length) {
        stats.savedTo = await appendWindow(p.rec);
        stats.windowsSaved++;
        console.log(`  🎞 [arena] saved ${p.rec.family} ${slug}: ${p.rec.ticks.length} ticks, outcome=${outcome == null ? "unknown" : outcome ? "Up" : "Down"}`);
      }
    }
  }
}

const settledListeners = new Set();
/** Call fn(rec) whenever a window settles (rec.outcome: 1 Up, 0 Down, null unknown). */
export function onWindowSettled(fn) { settledListeners.add(fn); return () => settledListeners.delete(fn); }

// Without the listed strike, BTC spot at the window's first tick (within 30s of the open) stands in.
const openSpot = rec => { const t = rec.ticks.find(x => x[4] != null); return t && t[0] - rec.start <= 30_000 ? t[4] : null; };

/**
 * The live US window of a family that ends at endMs (±60s), with its latest quote, the
 * window's strike, the latest BTC spot and the last ~10 minutes of spot ticks as [t, price].
 */
export function liveQuote(family, endMs) {
  for (const rec of live.values()) {
    if (rec.family !== family || Math.abs(rec.end - endMs) > 60_000) continue;
    const pxs = [];
    for (let i = Math.max(0, rec.ticks.length - 120); i < rec.ticks.length; i++) if (rec.ticks[i][4] != null) pxs.push([rec.ticks[i][0], rec.ticks[i][4]]);
    const base = { slug: rec.slug, start: rec.start, end: rec.end, strike: rec.strike ?? openSpot(rec), spot: pxs.length ? pxs[pxs.length - 1][1] : null, pxs };
    for (let i = rec.ticks.length - 1; i >= 0; i--) {
      const [t, bid, ask] = rec.ticks[i];
      if (bid != null && ask != null) return { ...base, t, bid, ask };
    }
    return { ...base, t: null, bid: null, ask: null };
  }
  return null;
}

/** In-progress windows as plain data (for saving across restarts). */
export function snapshotState() {
  return { savedAt: Date.now(), live: [...live.values()], pending: [...pending.values()].map(p => ({ rec: p.rec, since: p.since })) };
}

/** Put saved windows back. Live windows that already ended go to the settlement queue. */
export function restoreState(saved, now = Date.now()) {
  let restoredLive = 0, restoredPending = 0;
  for (const rec of saved?.live || []) {
    if (!rec?.slug || !Array.isArray(rec.ticks) || live.has(rec.slug) || pending.has(rec.slug)) continue;
    if (now >= rec.end) { pending.set(rec.slug, { rec, since: rec.end, lastTry: 0 }); restoredPending++; }
    else { live.set(rec.slug, rec); restoredLive++; }
  }
  for (const p of saved?.pending || []) {
    if (!p?.rec?.slug || pending.has(p.rec.slug)) continue;
    pending.set(p.rec.slug, { rec: p.rec, since: p.since || p.rec.end, lastTry: 0 }); restoredPending++;
  }
  return { restoredLive, restoredPending };
}

async function persist() {
  if (await saveJSON(STATE_KEY, snapshotState())) stats.lastSavedAt = Date.now();
}

export async function startArenaRecorder() {
  if (process.env.ARENA_RECORD !== "true") { console.log("🎞 Arena recorder off (set ARENA_RECORD=true to record BTC Up/Down prices)"); return; }
  if (timer) return;
  stats.started = Date.now();
  stats.enabled = true;
  const saved = await loadJSON(STATE_KEY);
  if (saved) {
    const r = restoreState(saved);
    stats.restored = r;
    console.log(`🎞 Arena recorder restored ${r.restoredLive} in-progress and ${r.restoredPending} unsettled window(s) from before the restart`);
  }
  let busy = false, lastSave = Date.now(), pendingCount = pending.size;
  timer = setInterval(async () => {
    if (busy) return;           // never overlap ticks
    busy = true;
    try {
      await tick();
      // Save every minute, and straight away when a window moves to settlement.
      if (Date.now() - lastSave >= SAVE_EVERY_MS || pending.size !== pendingCount) { lastSave = Date.now(); pendingCount = pending.size; await persist(); }
    } catch (err) { stats.lastError = err.message; }
    finally { busy = false; }
  }, TICK_MS);
  console.log(`🎞 Arena recorder on — BTC15 + BTC60 quotes every ${TICK_MS / 1000}s (read-only, places no orders)`);
}

export function recorderStatus() {
  return { ...stats, tickMs: TICK_MS, liveWindows: [...live.values()].map(r => ({ slug: r.slug, family: r.family, ticks: r.ticks.length })), awaitingSettlement: pending.size };
}
