/**
 * polymarket-us.js — Polymarket US API integration (raw signed REST)
 * Verified against official docs at docs.polymarket.us (June 2026)
 *
 * PUBLIC:  https://gateway.polymarket.us  (no auth required)
 * TRADING: https://api.polymarket.us      (Ed25519-signed headers)
 *
 * Auth headers per docs.polymarket.us/api-reference/authentication:
 *   X-PM-Access-Key  = Key ID (UUID)
 *   X-PM-Timestamp   = Unix ms timestamp (must be within 30s of server)
 *   X-PM-Signature   = base64( ed25519_sign( timestamp + METHOD + path ) )
 *
 * Env vars:
 *   POLYMARKET_API_KEY      = Key ID (UUID)
 *   POLYMARKET_PRIVATE_KEY  = Secret Key (base64-encoded Ed25519 seed)
 */

import axios from "axios";
import crypto from "crypto";

const GATEWAY = "https://gateway.polymarket.us";
const API     = "https://api.polymarket.us";

// ── Credential handling ──────────────────────────────────────────────────────
const looksUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const looksB64  = s => /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length >= 40;
const clean     = s => (s || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");

let _creds = null;

function getCreds() {
  if (_creds) return _creds;
  let keyId  = clean(process.env.POLYMARKET_API_KEY);
  let secret = clean(process.env.POLYMARKET_PRIVATE_KEY);

  if (!keyId || !secret || keyId.startsWith("your_"))
    throw new Error("Set POLYMARKET_API_KEY (Key ID UUID) and POLYMARKET_PRIVATE_KEY (Secret Key base64)");

  // Auto-fix swapped creds
  if (looksB64(keyId) && looksUuid(secret)) {
    console.log("⚠️  Credentials swapped — auto-correcting");
    [keyId, secret] = [secret, keyId];
  }

  console.log(`🔑 Key ID: ${keyId.length}c ${looksUuid(keyId) ? "(uuid ✓)" : "(⚠️ not uuid)"} | Secret: ${secret.length}c ${looksB64(secret) ? "(base64 ✓)" : "(⚠️ not base64)"}`);

  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 32 && raw.length !== 64)
    throw new Error(`Secret decodes to ${raw.length} bytes; expected 32 or 64 — re-copy from polymarket.us/developer`);

  const seed = raw.subarray(0, 32);
  const der  = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  _creds = { keyId, privateKey };
  return _creds;
}

function authHeaders(method, path) {
  const { keyId, privateKey } = getCreds();
  const timestamp = Date.now().toString();
  const sig = crypto.sign(null, Buffer.from(`${timestamp}${method}${path}`), privateKey).toString("base64");
  return {
    "X-PM-Access-Key": keyId,
    "X-PM-Timestamp":  timestamp,
    "X-PM-Signature":  sig,
    "Content-Type":    "application/json",
  };
}

async function signedGet(path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const full = qs ? `${path}?${qs}` : path;
  const headers = authHeaders("GET", full);
  const res = await axios.get(API + full, { headers, timeout: 15_000, validateStatus: () => true });
  if (res.status >= 200 && res.status < 300) return res.data;
  throw new Error(`${res.status}: ${res.data?.message || res.data?.error || JSON.stringify(res.data).slice(0, 120)}`);
}

async function signedPost(path, body) {
  const headers = authHeaders("POST", path);
  const res = await axios.post(API + path, body, { headers, timeout: 20_000, validateStatus: () => true });
  if (res.status >= 200 && res.status < 300) return res.data;
  throw new Error(`${res.status}: ${res.data?.message || res.data?.error || JSON.stringify(res.data).slice(0, 120)}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const num      = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const amtVal   = x => x == null ? null : (typeof x === "object" ? num(x.value ?? x.amount) : num(x));
const parseArr = v => { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };

// Exclude period/prop markets — moneyline full-game only
const SUB_PERIOD = /first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter|first period|2nd half|halftime/i;

// ── Market fetch: paginated, all sports moneylines ────────────────────────────
// Docs: GET /v1/markets?categories=sports&sportsMarketTypes=SPORTS_MARKET_TYPE_MONEYLINE&active=true
// NO closed=false — live in-play markets don't always have that field set correctly.
// We filter on our side.

let _cache = null, _cacheTs = 0;
const CACHE_TTL = 25_000; // 25s cache — balances rate limit (60 req/min public)

export async function fetchSportsMoneylines() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  const all   = [];
  let offset  = 0;
  const limit = 100;

  for (let page = 0; page < 15; page++) { // up to 1500 markets
    let data;
    try {
      const res = await axios.get(`${GATEWAY}/v1/markets`, {
        params: {
          categories:        "sports",
          sportsMarketTypes: "SPORTS_MARKET_TYPE_MONEYLINE",
          active:            "true",
          limit:             String(limit),
          offset:            String(offset),
          liquidityNumMin:   "50", // ignore ghost markets with no real liquidity
        },
        timeout: 12_000,
      });
      data = res.data;
    } catch (err) {
      console.error(`[polymarket-us] page ${page} error: ${err.message}`);
      break;
    }

    const batch = data?.markets || [];
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  console.log(`[polymarket-us] raw: ${all.length} markets fetched`);

  const now  = Date.now();
  const out  = [];

  for (const m of all) {
    if (!m.slug) continue;
    if (m.active === false || m.closed === true || m.archived === true) continue;

    const q = (m.question || m.title || "").trim();
    if (!q) continue;
    if (SUB_PERIOD.test(q)) continue;

    // Timing
    const startMs = m.gameStartTime ? new Date(m.gameStartTime).getTime() : null;
    const endMs   = m.endDate       ? new Date(m.endDate).getTime()       : null;
    if (endMs && endMs <= now) continue; // already ended

    const isLive   = startMs != null && startMs <= now;
    const upcoming = startMs != null && startMs > now;

    // Price: docs confirm bestBid/bestAsk exist on list endpoint for active markets.
    // Fallback chain: bestAsk → marketSides long price → outcomePrices → lastTradePrice
    let ask = num(m.bestAsk);
    let bid = num(m.bestBid);
    let est = ask;

    if (est == null) {
      const sides    = Array.isArray(m.marketSides) ? m.marketSides : [];
      const longSide = sides.find(s => s.long === true);
      if (longSide) est = num(longSide.price);
    }
    if (est == null) {
      const outcomes = parseArr(m.outcomes);
      const prices   = parseArr(m.outcomePrices).map(Number);
      if (prices.length) {
        let yi = outcomes.findIndex(o => /yes/i.test(String(o)));
        if (yi < 0) yi = 0;
        est = num(prices[yi]);
      }
    }
    if (est == null) est = num(m.lastTradePrice);

    // League from tags
    let league = null;
    const tags = Array.isArray(m.tags) ? m.tags : [];
    for (const t of tags) {
      league = t?.league?.abbreviation || t?.league?.name || league;
      if (!league && t?.sport?.name) league = t.sport.name;
    }
    if (!league) league = m.category || m.subcategory || null;

    // Volume / liquidity from docs-confirmed fields
    const vol24h = num(m.volume24hr) ?? num(m.volumeNum) ?? 0;
    const liq    = num(m.liquidityNum) ?? 0;
    const spread = num(m.spread) ?? (ask && bid ? ask - bid : null);

    out.push({
      slug:         m.slug,
      question:     q,
      subtitle:     m.subtitle || null,
      league:       league ? String(league).toUpperCase().slice(0, 12) : "SPORT",
      ask,
      bid,
      est,
      spread,
      volume24h:    vol24h,
      liquidity:    liq,
      openInterest: num(m.openInterest) ?? 0,
      oneDayChg:    num(m.oneDayPriceChange) ?? null,
      tick:         num(m.orderPriceMinTickSize) || 0.01,
      minQty:       num(m.minimumTradeQty)       || 1,
      gameStartIso: m.gameStartTime || null,
      endIso:       m.endDate       || null,
      gameId:       m.gameId        || null,
      isLive,
      upcoming,
      startMs,
      marketId:     m.id            || null,
    });
  }

  // Sort: LIVE (by most recently started) → UPCOMING (by soonest start)
  out.sort((a, b) => {
    if (a.isLive  && !b.isLive)  return -1;
    if (!a.isLive && b.isLive)   return 1;
    if (a.isLive  && b.isLive)   return (b.startMs || 0) - (a.startMs || 0);
    return (a.startMs || Infinity) - (b.startMs || Infinity);
  });

  const liveCount     = out.filter(x => x.isLive).length;
  const upcomingCount = out.filter(x => x.upcoming).length;
  console.log(`[polymarket-us] ✅ ${out.length} markets | 🔴 ${liveCount} LIVE | ⏰ ${upcomingCount} upcoming`);

  if (!_sampleLogged && out.length === 0 && all.length > 0) {
    _sampleLogged = true;
    console.log("🔍 Sample (no usable markets):", JSON.stringify(all[0]).slice(0, 600));
  }

  _cache  = out;
  _cacheTs = Date.now();
  return out;
}

let _sampleLogged = false;

/**
 * BBO fetch — returns { bid, ask, last, currentPx, bidDepth, askDepth, openInterest }
 * Docs: GET /v1/markets/{slug}/bbo
 * Response shape: { marketData: { bestBid: {value,currency}, bestAsk: {...}, currentPx, lastTradePx, ... } }
 */
export async function getBBO(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/bbo`,
      { timeout: 8_000 }
    );
    const d = data?.marketData || {};
    return {
      bid:         amtVal(d.bestBid),
      ask:         amtVal(d.bestAsk),
      currentPx:   amtVal(d.currentPx),
      last:        amtVal(d.lastTradePx),
      bidDepth:    d.bidDepth   ?? null,
      askDepth:    d.askDepth   ?? null,
      openInterest: num(d.openInterest) ?? null,
    };
  } catch { return null; }
}

/**
 * Full order book — returns top bid/ask + stats
 * Docs: GET /v1/markets/{slug}/book
 */
export async function getBook(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`,
      { timeout: 8_000 }
    );
    const d     = data?.marketData || {};
    const bids  = (d.bids   || []).map(b => ({ px: amtVal(b.px), qty: Number(b.qty) })).filter(b => b.px);
    const asks  = (d.offers || []).map(o => ({ px: amtVal(o.px), qty: Number(o.qty) })).filter(o => o.px);
    const stats = d.stats || {};
    return {
      bids,
      asks,
      bestBid:    bids[0]?.px ?? null,
      bestAsk:    asks[0]?.px ?? null,
      last:       amtVal(stats.lastTradePx),
      high:       amtVal(stats.highPx),
      low:        amtVal(stats.lowPx),
      openInt:    num(stats.openInterest) ?? null,
      state:      d.state || null,
    };
  } catch { return null; }
}

/**
 * Verify candidates with live BBO — parallel for snipe speed.
 * Keeps only two-sided books within maxSpread where ask is in [favMin, favMax].
 */
export async function verifyCandidates(cands, { maxSpread = 0.08, favMin = 0.60, favMax = 0.72 } = {}) {
  const checks = await Promise.all(cands.map(async c => {
    const bbo = await getBBO(c.slug);
    if (!bbo) return null;
    const ask = bbo.ask ?? bbo.currentPx;
    const bid = bbo.bid;
    if (!ask) return null;
    if (ask < favMin || ask > favMax) return null;
    if (bid && ask - bid > maxSpread) return null;
    return { ...c, ask, bid: bid ?? null, liveSpread: bid ? ask - bid : null };
  }));
  return checks.filter(Boolean);
}

// Settlement check throttle — only hit the endpoint every 60s per market
// to stay within the 60 req/min public rate limit.
const _settlementCache = new Map(); // slug → { value, ts }
const SETTLE_TTL = 60_000;

export async function getSettlement(slug) {
  const cached = _settlementCache.get(slug);
  if (cached && Date.now() - cached.ts < SETTLE_TTL) return cached.value;
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/settlement`,
      { timeout: 8_000 }
    );
    const v = Number(data?.settlement);
    let result = null;
    if (Number.isFinite(v)) {
      if (v >= 0.99) result = 1;
      else if (v <= 0.01) result = 0;
    }
    _settlementCache.set(slug, { value: result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}

// ── Authenticated endpoints ───────────────────────────────────────────────────

/**
 * Account balances — docs: GET /v1/account/balances
 * Returns: { balances: [ { currentBalance, buyingPower, assetNotional, currency, ... } ] }
 * Note: balances is an ARRAY, not an object.
 */
let _balShapeLogged = false;
export async function getBuyingPower() {
  const data = await signedGet("/v1/account/balances");
  const arr  = Array.isArray(data?.balances) ? data.balances : [];
  // Find USD balance entry (or first entry if only one)
  const usd  = arr.find(b => b.currency === "USD") || arr[0] || {};
  const buyingPower    = num(usd.buyingPower)    ?? 0;
  const currentBalance = num(usd.currentBalance) ?? buyingPower;
  const assetNotional  = num(usd.assetNotional)  ?? 0;

  if (buyingPower === 0 && !_balShapeLogged) {
    _balShapeLogged = true;
    console.log("🔍 balances raw:", JSON.stringify(data).slice(0, 400));
  }
  return { buyingPower, currentBalance, assetNotional };
}

/**
 * Open positions — docs: GET /v1/portfolio/positions
 * Returns: { positions: { [slug]: UserPosition } } where UserPosition has
 * netPosition, qtyBought, cost{value,currency}, realized{...}, cashValue{...}, marketMetadata
 */
export async function getOpenPositions() {
  try {
    const data  = await signedGet("/v1/portfolio/positions", { limit: "200" });
    const posMap = data?.positions || {};
    const result = {};
    for (const [slug, p] of Object.entries(posMap)) {
      const net = Number(p.netPosition || 0);
      if (net === 0) continue; // no active position
      result[slug] = {
        netPosition:  net,
        qtyBought:    Number(p.qtyBought  || 0),
        qtySold:      Number(p.qtySold    || 0),
        cost:         amtVal(p.cost)       ?? 0,
        realized:     amtVal(p.realized)   ?? 0,
        cashValue:    amtVal(p.cashValue)  ?? 0, // unrealized PnL value
        title:        p.marketMetadata?.title   || slug,
        outcome:      p.marketMetadata?.outcome || "YES",
        eventSlug:    p.marketMetadata?.eventSlug || null,
        icon:         p.marketMetadata?.icon      || null,
      };
    }
    return result;
  } catch (err) {
    console.error("[positions] fetch error:", err.message);
    return null;
  }
}

/**
 * Place a BUY YES order (FOK) using synchronousExecution for instant fill confirmation.
 * Docs: POST /v1/orders with synchronousExecution:true so we get executions[] back
 * without needing to poll /v1/orders/{id}.
 *
 * Uses cashOrderQty (dollar amount) for ORDER_TYPE_MARKET to let the exchange
 * figure out quantity — simpler and avoids minimumTradeQty math errors.
 *
 * Falls back to limit FOK if market order fails.
 */
export async function buyYesFOK({ slug, sizeUsd, ask, tick = 0.01 }) {
  // First try: market order with cash qty (cleanest, no qty calc needed)
  try {
    const body = {
      marketSlug:          slug,
      type:                "ORDER_TYPE_MARKET",
      intent:              "ORDER_INTENT_BUY_LONG",
      cashOrderQty:        { value: sizeUsd.toFixed(2), currency: "USD" },
      tif:                 "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
      synchronousExecution: true,
      maxBlockTime:        "5",
    };

    const resp = await signedPost("/v1/orders", body);
    const execs = resp?.executions || [];
    const fill  = execs.find(e => e.type === "EXECUTION_TYPE_FILL" || e.type === "EXECUTION_TYPE_PARTIAL_FILL");

    if (fill) {
      const fillPx  = amtVal(fill.lastPx) ?? ask;
      const fillQty = Number(fill.lastShares || 0);
      if (fillQty <= 0) {
        // Exchange acknowledged fill but reported 0 shares — treat as not filled, try limit
        console.log(`[order] market fill reported 0 shares — falling through to limit FOK`);
      } else {
        const cost = fillQty * fillPx;
        return { filled: true, fillPrice: fillPx, qty: fillQty, cost: +cost.toFixed(2), orderId: resp.id };
      }
    }

    // If market order didn't fill, check state
    const rej = execs.find(e => e.type === "EXECUTION_TYPE_REJECTED" || e.type === "EXECUTION_TYPE_CANCELED");
    if (rej) {
      // Fall through to limit order
      console.log(`[order] market IOC rejected (${rej.orderRejectReason}) — trying limit FOK`);
    }
  } catch (err) {
    console.log(`[order] market order error: ${err.message} — trying limit FOK`);
  }

  // Fallback: limit FOK at ask + 1 tick
  const tick2  = tick || 0.01;
  const limit  = Math.min(0.99, Math.round((ask + tick2) / tick2) * tick2);
  // Format price to correct decimal places for this tick size
  const tickDp = tick2 < 0.01 ? 3 : 2;
  const qty    = Math.floor(sizeUsd / limit);
  if (qty < 1) return { filled: false, error: `$${sizeUsd} too small for 1 contract @ ${limit.toFixed(tickDp)}` };

  try {
    const body = {
      marketSlug:          slug,
      type:                "ORDER_TYPE_LIMIT",
      intent:              "ORDER_INTENT_BUY_LONG",
      price:               { value: limit.toFixed(tickDp), currency: "USD" },
      quantity:            qty,
      tif:                 "TIME_IN_FORCE_FILL_OR_KILL",
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
      synchronousExecution: true,
      maxBlockTime:        "5",
    };

    const resp  = await signedPost("/v1/orders", body);
    const execs = resp?.executions || [];
    const fill  = execs.find(e => e.type === "EXECUTION_TYPE_FILL");

    if (fill) {
      const fillPx  = amtVal(fill.lastPx) ?? limit;
      const fillQty = Number(fill.lastShares || qty);
      return { filled: true, fillPrice: fillPx, qty: fillQty, cost: +(fillQty * fillPx).toFixed(2), orderId: resp.id };
    }

    const state = resp?.executions?.[0]?.order?.state || "unknown";
    return { filled: false, error: `limit FOK not filled (${state})`, orderId: resp.id };
  } catch (err) {
    return { filled: false, error: err.message };
  }
}

/**
 * Close position — docs: POST /v1/orders with SELL_LONG intent
 * Sells all contracts held.
 */
export async function closePositionLive(slug) {
  try {
    const resp = await signedPost("/v1/orders", {
      marketSlug:          slug,
      type:                "ORDER_TYPE_MARKET",
      intent:              "ORDER_INTENT_SELL_LONG",
      tif:                 "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
      synchronousExecution: true,
      maxBlockTime:        "5",
    });
    return { ok: true, orderId: resp.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Preflight ─────────────────────────────────────────────────────────────────
export async function preflightUS() {
  const msgs = [];
  let keyId;
  try {
    keyId = getCreds().keyId;
    msgs.push("✅ Ed25519 key loaded");
  } catch (e) {
    msgs.push("❌ " + e.message);
    return { ok: false, messages: msgs };
  }

  try {
    const { buyingPower, currentBalance, assetNotional } = await getBuyingPower();
    msgs.push(`✅ Auth OK | cash $${currentBalance.toFixed(2)} | buying power $${buyingPower.toFixed(2)} | positions $${assetNotional.toFixed(2)}`);
    if (buyingPower <= 0 && assetNotional <= 0) {
      msgs.push("❌ $0 buying power — deposit funds in the Polymarket app");
      return { ok: false, messages: msgs };
    }
  } catch (e) {
    msgs.push("❌ Auth/balance failed: " + e.message);
    if (/not found/i.test(e.message))
      msgs.push("👉 Key not found server-side — re-generate at polymarket.us/developer");
    return { ok: false, messages: msgs };
  }

  return { ok: true, messages: msgs };
}
