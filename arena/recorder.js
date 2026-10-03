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

const GATEWAY = "https://gateway.polymarket.us";
const TICK_MS = Math.max(2000, Number(process.env.ARENA_TICK_MS || 5000));
const LISTING_MS = 30_000;                  // refresh the market list this often
const SETTLE_POLL_MS = 30_000;
const SETTLE_GIVE_UP_MS = 6 * 60 * 60_000;  // stop chasing a settlement after 6h (outcome stays null)

const live = new Map();      // slug -> window record being filled
const pending = new Map();   // slug -> { rec, since, lastTry }
let listing = { ts: 0, markets: [] };
let closedCache = { ts: 0, rows: [] };
let spot = { ts: 0, price: null };
let timer = null;
let stats = { started: 0, lastTickAt: 0, enabled: false, ticks: 0, windowsSaved: 0, bboErrors: 0, rateLimited: 0, lastError: null, savedTo: null };
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
    let bid = null, ask = null;
    try {
      const bbo = await pm.getBBO(m.slug);
      bid = num(bbo?.bid); ask = num(bbo?.ask);
      if (bbo == null) stats.bboErrors++;
    } catch (err) {
      if (/429/.test(err.message || "")) stats.rateLimited++; else stats.bboErrors++;
    }
    const listYes = fresh ? num(pm.extractYesPrice(m)) : null;
    rec.ticks.push([now, bid, ask, listYes, px]);
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
      if (p.rec.ticks.length) {
        stats.savedTo = await appendWindow(p.rec);
        stats.windowsSaved++;
        console.log(`  🎞 [arena] saved ${p.rec.family} ${slug}: ${p.rec.ticks.length} ticks, outcome=${outcome == null ? "unknown" : outcome ? "Up" : "Down"}`);
      }
    }
  }
}

export function startArenaRecorder() {
  if (process.env.ARENA_RECORD !== "true") { console.log("🎞 Arena recorder off (set ARENA_RECORD=true to record BTC Up/Down prices)"); return; }
  if (timer) return;
  stats.started = Date.now();
  stats.enabled = true;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;           // never overlap ticks
    busy = true;
    try { await tick(); } catch (err) { stats.lastError = err.message; }
    finally { busy = false; }
  }, TICK_MS);
  console.log(`🎞 Arena recorder on — BTC15 + BTC60 quotes every ${TICK_MS / 1000}s (read-only, places no orders)`);
}

export function recorderStatus() {
  return { ...stats, tickMs: TICK_MS, liveWindows: [...live.values()].map(r => ({ slug: r.slug, family: r.family, ticks: r.ticks.length })), awaitingSettlement: pending.size };
}
