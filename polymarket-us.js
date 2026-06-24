/**
 * polymarket-us.js — polymarket.us integration (no SDK; raw signed REST)
 *
 * PUBLIC:  https://gateway.polymarket.us  (no auth)
 * TRADING: https://api.polymarket.us     (Ed25519-signed headers)
 *
 * Signing per https://docs.polymarket.us/api-reference/authentication:
 *   message  = `${timestampMs}${METHOD}${path}`
 *   signature = base64( ed25519_sign(message) )  using first 32 bytes of
 *               base64-decoded Secret Key as the private seed.
 * Headers: X-PM-Access-Key, X-PM-Timestamp, X-PM-Signature
 *
 * Env: POLYMARKET_API_KEY = Key ID (uuid) | POLYMARKET_PRIVATE_KEY = Secret Key (base64)
 */

import axios from "axios";
import crypto from "crypto";

const GATEWAY = "https://gateway.polymarket.us";
const API     = "https://api.polymarket.us";

// ── Credential handling ─────────────────────────────────────────
const looksUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const looksB64  = s => /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length >= 40;
const clean = s => (s || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");

let _creds = null;
function getCreds() {
  if (_creds) return _creds;
  let keyId  = clean(process.env.POLYMARKET_API_KEY);
  let secret = clean(process.env.POLYMARKET_PRIVATE_KEY);

  if (!keyId || !secret || keyId.startsWith("your_")) {
    throw new Error("Set POLYMARKET_API_KEY (Key ID) and POLYMARKET_PRIVATE_KEY (Secret Key)");
  }
  // Auto-fix swapped values
  if (looksB64(keyId) && looksUuid(secret)) {
    console.log("⚠️ Credentials appear swapped (Key ID ↔ Secret) — auto-correcting");
    [keyId, secret] = [secret, keyId];
  }
  console.log(`🔑 Key ID: ${keyId.length} chars ${looksUuid(keyId) ? "(uuid ✓)" : "(⚠️ not uuid-shaped)"} | Secret: ${secret.length} chars ${looksB64(secret) ? "(base64 ✓)" : "(⚠️ not base64 — re-copy from polymarket.us/developer)"}`);

  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 32 && raw.length !== 64) {
    throw new Error(`Secret decodes to ${raw.length} bytes; expected 32 or 64 — re-copy the Secret Key`);
  }
  const seed = raw.subarray(0, 32);
  // Wrap seed in PKCS8 DER for Node's Ed25519 key import
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), seed,
  ]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });

  _creds = { keyId, privateKey };
  return _creds;
}

function authHeaders(method, path) {
  const { keyId, privateKey } = getCreds();
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${path}`;
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString("base64");
  return {
    "X-PM-Access-Key": keyId,
    "X-PM-Timestamp": timestamp,
    "X-PM-Signature": signature,
    "Content-Type": "application/json",
  };
}

async function signedRequest(method, path, body) {
  const headers = authHeaders(method, path);
  const res = await axios({
    method, url: API + path, headers,
    data: body ?? undefined, timeout: 15_000,
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  const msg = res.data?.message || res.data?.error || JSON.stringify(res.data)?.slice(0, 140) || `HTTP ${res.status}`;
  throw new Error(`${res.status}: ${msg}`);
}

// ── Public: sports moneyline markets ────────────────────────────
let _cache = null, _cacheTime = 0;
const TTL = 20_000;
const SUB_PERIOD = /first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter/i;
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// One-time raw shape logger — fires once after deploy so we can see V2 field names
let _rawShapeLogged = false;

// Moneyline detection: title/question/marketType all used by different API versions
const MONEYLINE = /moneyline|will .+ win|match winner|game winner|series winner/i;
const FULL_GAME = /first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter/i;

export async function fetchSportsMoneylines() {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;

  // ── V2 migration fix ──────────────────────────────────────────────────────
  // The old `sportsMarketTypes=SPORTS_MARKET_TYPE_MONEYLINE` filter was a V1
  // param that silently returns [] after the June 2026 migration. We now fetch
  // broadly and filter client-side, trying multiple endpoint shapes in order
  // until one returns data.
  let raw = [];
  const endpoints = [
    // 1) V1 sports category (most likely to work post-migration)
    `${GATEWAY}/v1/markets?active=true&closed=false&limit=200&category=sports`,
    // 2) V1 without the broken sportsMarketTypes param (plain active markets)
    `${GATEWAY}/v1/markets?active=true&closed=false&limit=200`,
    // 3) V2 path if they versioned the route
    `${GATEWAY}/v2/markets?active=true&closed=false&limit=200`,
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, { timeout: 10_000 });
      // Log raw response shape ONCE so we can diagnose V2 field changes
      if (!_rawShapeLogged) {
        _rawShapeLogged = true;
        const arr = data?.markets || data?.data || data?.results || (Array.isArray(data) ? data : []);
        console.log(`🔍 [sports API] endpoint: ${url}`);
        console.log(`🔍 [sports API] root keys: ${Object.keys(data || {}).join(", ")}`);
        console.log(`🔍 [sports API] array length: ${arr.length}`);
        if (arr[0]) console.log(`🔍 [sports API] first market keys: ${Object.keys(arr[0]).join(", ")}`);
        if (arr[0]) console.log(`🔍 [sports API] first market sample: ${JSON.stringify(arr[0]).slice(0, 600)}`);
      }
      const arr = data?.markets || data?.data || data?.results || (Array.isArray(data) ? data : []);
      if (arr.length > 0) { raw = arr; break; }
    } catch (e) {
      console.log(`🔍 [sports API] ${url} failed: ${e.message}`);
    }
  }

  if (raw.length === 0) {
    console.log("⚠️ [sports API] all endpoints returned empty — API may have changed");
    _cache = []; _cacheTime = Date.now();
    return [];
  }

  const parseArr = v => { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };

  // Client-side sports/moneyline filter
  // Accepts: marketType field, category field, tag-based sport detection,
  // or question text matching known moneyline patterns
  const isSportsMoneyline = m => {
    const q = (m.question || m.title || "").toLowerCase();
    const cat = (m.category || "").toLowerCase();
    const mtype = (m.marketType || m.market_type || m.type || "").toLowerCase();
    // Exclude sub-period markets regardless
    if (FULL_GAME.test(q)) return false;
    // Accept explicit marketType field
    if (mtype.includes("moneyline")) return true;
    // Accept sports category
    if (cat === "sports" || cat.includes("sport")) {
      // Within sports, prefer moneyline-shaped questions
      return MONEYLINE.test(q) || /vs\.?|at |@ /.test(q);
    }
    // Accept tag-based sport detection
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const hasSportTag = tags.some(t => t?.sport?.name || t?.league?.name || t?.category === "sports");
    if (hasSportTag) return MONEYLINE.test(q) || /vs\.?|at |@ /.test(q);
    return false;
  };

  const out = [];
  for (const m of raw) {
    // Accept id or slug as the unique key (V2 may use id instead of slug)
    const slug = m.slug || m.id || m.marketId;
    if (!slug) continue;
    if (m.active === false || m.closed === true || m.resolved === true) continue;
    if (!isSportsMoneyline(m)) continue;

    const q = m.question || m.title || "";

    // Price — try every known field name V1 and V2 use
    let est = null;
    const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
    const longSide = sides.find(s => s.long === true);
    if (longSide) est = num(longSide.price);
    if (est == null) {
      const outcomes = parseArr(m.outcomes);
      const prices = parseArr(m.outcomePrices || m.outcome_prices).map(Number);
      if (prices.length) {
        let yi = outcomes.findIndex(o => /yes/i.test(String(o)));
        if (yi < 0) yi = 0;
        est = num(prices[yi]);
      }
    }
    if (est == null) est = num(m.lastTradePrice ?? m.last_trade_price ?? m.price);

    // League from tags or category
    let league = null;
    const tags = Array.isArray(m.tags) ? m.tags : [];
    for (const t of tags) {
      league = t?.league?.abbreviation || t?.league?.name || league;
      if (!league && t?.sport?.name) league = t.sport.name;
    }
    if (!league) league = m.category || m.sport || null;

    // Game start time — V2 may rename this field
    const gameStart = m.gameStartTime || m.game_start_time || m.startTime || m.start_time || null;

    out.push({
      slug,
      question: q,
      subtitle: m.subtitle || null,
      league: league ? String(league).toUpperCase().slice(0, 12) : "SPORT",
      ask: num(m.bestAsk ?? m.best_ask),
      bid: num(m.bestBid ?? m.best_bid),
      est,
      tick: num(m.orderPriceMinTickSize ?? m.tick_size) || 0.01,
      minQty: num(m.minimumTradeQty ?? m.min_qty) || 1,
      gameStartIso: gameStart,
      endIso: m.endDate || m.end_date || m.endTime || null,
      category: m.category || "",
    });
  }

  console.log(`📊 [sports API] raw: ${raw.length} markets → ${out.length} sports moneylines after filter`);

  _cache = out; _cacheTime = Date.now();
  return out;
}

/**
 * Verify candidate markets with real top-of-book quotes.
 * Input: array of {slug,...}; returns same objects with live bid/ask attached,
 * keeping only two-sided books with spread <= maxSpread.
 */
export async function verifyCandidates(cands, { maxSpread = 0.06 } = {}) {
  const checks = await Promise.all(cands.map(async c => {
    const bbo = await getBBO(c.slug);
    if (!bbo?.bid || !bbo?.ask) return null;
    if (bbo.ask - bbo.bid > maxSpread) return null;
    return { ...c, ask: bbo.ask, bid: bbo.bid };
  }));
  return checks.filter(Boolean);
}

export async function getBBO(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/bbo`, { timeout: 8_000 });
    const d = data?.marketData || data || {};
    const val = x => (x && x.value != null) ? Number(x.value) : num(x);
    return { bid: val(d.bestBid), ask: val(d.bestAsk),
             last: val(d.lastTradePx) ?? val(d.lastTradePrice) };
  } catch { return null; }
}

export async function getSettlement(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/settlement`, { timeout: 8_000 });
    const v = Number(data?.settlement);
    if (!Number.isFinite(v)) return null;
    if (v >= 0.99) return 1;
    if (v <= 0.01) return 0;
    return null;
  } catch { return null; }
}

// ── Authenticated ───────────────────────────────────────────────
// Money values may arrive as 70, "70.00", or {value:"70.00",currency:"USD"}
const money = x => {
  if (x == null) return null;
  if (typeof x === "object") return money(x.value ?? x.amount ?? x.units);
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

let _balShapeLogged = false;
export async function getBuyingPower() {
  const b = await signedRequest("GET", "/v1/account/balances");

  // balances may come back as an ARRAY of accounts:
  //   { "balances": [ { "currentBalance": 70, "buyingPower": 70, ... } ] }
  // — unwrap to the first entry before reading fields.
  let root = b?.balances ?? b ?? {};
  if (Array.isArray(root)) root = root[0] || {};

  const buyingPower =
    money(root.buyingPower) ?? money(root.buying_power) ?? null;
  const currentBalance =
    money(root.currentBalance) ?? money(root.current_balance) ??
    money(root.cashBalance) ?? null;

  if ((buyingPower == null || buyingPower === 0) && !_balShapeLogged) {
    _balShapeLogged = true;
    console.log("🔍 balances raw shape:", JSON.stringify(b).slice(0, 300));
  }
  return { buyingPower: buyingPower ?? 0, currentBalance: currentBalance ?? buyingPower ?? 0 };
}

/** Live BUY: fill-or-kill limit at ask + 1 tick. Whole contracts. */
export async function buyYesFOK({ slug, sizeUsd, ask, tick = 0.01 }) {
  const limit = Math.min(0.99, Math.round((ask + tick) / tick) * tick);
  const qty = Math.floor(sizeUsd / limit);
  if (qty < 1) return { filled: false, error: `size $${sizeUsd} < 1 contract @ ${limit.toFixed(2)}` };

  try {
    const order = await signedRequest("POST", "/v1/orders", {
      marketSlug: slug,
      intent: "ORDER_INTENT_BUY_LONG",
      type: "ORDER_TYPE_LIMIT",
      price: { value: limit.toFixed(2), currency: "USD" },
      quantity: qty,
      tif: "TIME_IN_FORCE_FILL_OR_KILL",
    });

    let state = order?.state, id = order?.id;
    if (state === "ORDER_STATE_PENDING_NEW" && id) {
      await new Promise(r => setTimeout(r, 1200));
      try { state = (await signedRequest("GET", `/v1/order/${id}`))?.state; } catch {}
    }
    if (state === "ORDER_STATE_FILLED") {
      return { filled: true, qty, fillPrice: limit, cost: +(qty * limit).toFixed(2), orderId: id };
    }
    return { filled: false, error: `order ${state || "unknown"}`, orderId: id };
  } catch (err) {
    return { filled: false, error: err.message };
  }
}

/** Live full exit at market (TP/SL/manual). */
export async function closePositionLive(slug) {
  try {
    await signedRequest("POST", "/v1/order/close-position", { marketSlug: slug });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Ground-truth check against the REAL Polymarket account: returns a map of
 * { [marketSlug]: { qtyBought, netPosition } } for every market ever traded
 * on this account. Used to prevent duplicate entries into a market that the
 * account already holds, regardless of local state/persistence — survives
 * restarts, redeploys, anything, because it's read directly from Polymarket.
 *
 * Returns null on error so callers can fail safe (don't block trading on a
 * transient API hiccup, but log it).
 */
export async function getOpenPositions() {
  try {
    const data = await signedRequest("GET", "/v1/portfolio/positions");
    const positions = data?.positions || {};
    const out = {};
    for (const [slug, p] of Object.entries(positions)) {
      out[slug] = {
        qtyBought: Number(p?.qtyBought ?? 0),
        netPosition: Number(p?.netPosition ?? 0),
      };
    }
    return out;
  } catch (err) {
    console.error("⚠️ getOpenPositions failed:", err.message);
    return null;
  }
}

// ── Preflight ───────────────────────────────────────────────────
export async function preflightUS() {
  const msgs = [];
  let keyId;
  try { keyId = getCreds().keyId; msgs.push("✅ API credentials parsed (Ed25519 key loaded)"); }
  catch (e) { msgs.push("❌ " + e.message); return { ok: false, messages: msgs }; }
  try {
    const { buyingPower, currentBalance } = await getBuyingPower();
    msgs.push(`✅ Auth works | balance $${currentBalance.toFixed(2)} | buying power $${buyingPower.toFixed(2)}`);
    if (buyingPower <= 0) {
      msgs.push("❌ Buying power is $0 — deposit funds in the Polymarket app");
      return { ok: false, messages: msgs };
    }
  } catch (e) {
    msgs.push("❌ Auth/balance check failed: " + e.message);
    msgs.push(`🔎 Sending Key ID: ${keyId.slice(0, 13)}… (${keyId.length} chars, ${looksUuid(keyId) ? "uuid ✓" : "⚠️ NOT uuid"}) — compare to polymarket.us/developer`);
    if (/not found/i.test(e.message)) {
      msgs.push("👉 Key doesn't exist server-side: revoked, truncated copy, or different account. Create a fresh key (sign in with Apple, same as the app), use the COPY buttons for both values, update both Railway vars.");
    }
    return { ok: false, messages: msgs };
  }
  return { ok: true, messages: msgs };
}
