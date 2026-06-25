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
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// Sub-period exclusion filter
const SUB_PERIOD = /first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter/i;

export async function fetchSportsMoneylines() {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;

  // ── V2 fix: sportsMarketTypeV2 filter + pagination + bestBidQuote/bestAskQuote ──
  // Diagnostic (previous deploy) revealed:
  //   - endpoint works: returns 200 markets correctly
  //   - field is `sportsMarketTypeV2` not `sportsMarketTypes` (V1 param)
  //   - bid/ask fields are `bestBidQuote` / `bestAskQuote` not `bestBid`/`bestAsk`
  //   - first 200 results are futures/championship markets; moneylines may be
  //     on later pages. Paginate up to 600 total, filter by sportsMarketTypeV2.

  const MONEYLINE_TYPES = new Set([
    "SPORTS_MARKET_TYPE_MONEYLINE",
    "moneyline",
    "MONEYLINE",
  ]);

  // Game market patterns — used to accept UNSPECIFIED markets that are
  // actually game moneylines (e.g. "Will Yankees beat Red Sox on June 25?")
  const GAME_PAT = /vs\.?|at|will .+ (beat|defeat|win)|winner|moneyline|ml/i;
  const NOT_FUTURE = /champion|pennant|world series|super bowl|stanley cup|nba finals|mvp|award|season wins|division|playoff/i;

  let raw = [];

  // Strategy: the category=sports filter only returns futures on Polymarket.us.
  // Live game moneylines appear to use sportsMarketType=SPORTS_MARKET_TYPE_MONEYLINE
  // as a direct query param — try that first, then fall back to broader fetches.
  const fetches = [
    // 1) Direct moneyline filter (V1 param still works for filtering even if list was broken)
    `${GATEWAY}/v1/markets?active=true&closed=false&limit=200&sportsMarketType=SPORTS_MARKET_TYPE_MONEYLINE`,
    // 2) No category filter — all active markets, paginated
    `${GATEWAY}/v1/markets?active=true&closed=false&limit=200&offset=0`,
    `${GATEWAY}/v1/markets?active=true&closed=false&limit=200&offset=200`,
    `${GATEWAY}/v1/markets?active=true&closed=false&limit=200&offset=400`,
  ];

  for (const url of fetches) {
    try {
      const { data } = await axios.get(url, { timeout: 12_000 });
      const arr = data?.markets || [];
      if (arr.length > 0) {
        // Add any markets not already in raw (dedup by slug/id)
        const seen = new Set(raw.map(m => m.slug || m.id));
        arr.forEach(m => { if (!seen.has(m.slug || m.id)) raw.push(m); });
      }
    } catch (e) {
      console.log(`⚠️ [sports API] ${url.slice(0,60)}... failed: ${e.message}`);
    }
  }

  if (raw.length === 0) {
    console.log("⚠️ [sports API] all pages empty — API may have changed");
    _cache = []; _cacheTime = Date.now();
    return [];
  }

  const parseArr = v => { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };

  // Filter: accept explicit moneyline types OR UNSPECIFIED game markets
  const isMoneyline = m => {
    const q = m.question || m.title || "";
    // Explicit moneyline type — always accept
    const v2type = (m.sportsMarketTypeV2 || "").toUpperCase();
    if (MONEYLINE_TYPES.has(v2type)) return true;
    const v1type = (m.sportsMarketType || "").toUpperCase();
    if (MONEYLINE_TYPES.has(v1type)) return true;
    const mtype = (m.marketType || "").toLowerCase();
    if (mtype.includes("moneyline")) return true;
    // UNSPECIFIED: accept if question looks like a game (not a season future)
    if (v2type === "SPORTS_MARKET_TYPE_UNSPECIFIED" || v2type === "") {
      if (GAME_PAT.test(q) && !NOT_FUTURE.test(q)) return true;
    }
    return false;
  };

  const out = [];
  for (const m of raw) {
    const slug = m.slug || m.id || m.marketId;
    if (!slug) continue;
    if (m.active === false || m.closed === true || m.resolved === true) continue;
    if (!isMoneyline(m)) continue;

    const q = m.question || m.title || "";
    if (SUB_PERIOD.test(q)) continue;

    // Price extraction — V2 uses bestBidQuote/bestAskQuote objects
    let est = null;
    // V2 quote objects: { price: "0.65", size: "100" }
    const bidQ = m.bestBidQuote ?? m.bestBid;
    const askQ = m.bestAskQuote ?? m.bestAsk;
    const bid = num(typeof bidQ === "object" ? bidQ?.price : bidQ);
    const ask = num(typeof askQ === "object" ? askQ?.price : askQ);

    // est from marketSides (long side)
    const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
    const longSide = sides.find(s => s.long === true);
    if (longSide) est = num(longSide.price);
    // est from outcomePrices
    if (est == null) {
      const outcomes = parseArr(m.outcomes);
      const prices = parseArr(m.outcomePrices).map(Number);
      if (prices.length) {
        let yi = outcomes.findIndex(o => /yes/i.test(String(o)));
        if (yi < 0) yi = 0;
        est = num(prices[yi]);
      }
    }
    if (est == null) est = ask ?? bid ?? num(m.lastTradePrice);

    // League from tags
    let league = null;
    const tags = Array.isArray(m.tags) ? m.tags : [];
    for (const t of tags) {
      league = t?.league?.abbreviation || t?.league?.name || league;
      if (!league && t?.sport?.name) league = t.sport.name;
    }
    if (!league) league = m.category || null;

    const gameStart = m.gameStartTime || m.game_start_time || m.startTime || null;

    out.push({
      slug,
      question: q,
      subtitle: m.subtitle || null,
      league: league ? String(league).toUpperCase().slice(0, 12) : "SPORT",
      ask, bid, est,
      tick: num(m.orderPriceMinTickSize) || 0.01,
      minQty: num(m.minimumTradeQty) || 1,
      gameStartIso: gameStart,
      endIso: m.endDate || null,
      category: m.category || "",
      sportsType: m.sportsMarketTypeV2 || m.sportsMarketType || "",
    });
  }

  console.log(`📊 [sports API] scanned ${raw.length} total mkts → ${out.length} moneylines`);
  if (out.length === 0 && raw.length > 0) {
    const types = {};
    raw.forEach(m => {
      const t = m.sportsMarketTypeV2 || m.sportsMarketType || m.marketType || "UNKNOWN";
      types[t] = (types[t] || 0) + 1;
    });
    console.log("🔍 [sports API] type breakdown:", JSON.stringify(types));
    // Log sample of non-future markets so we can see what game markets look like
    const nonFuture = raw.filter(m => !String(m.sportsMarketTypeV2||"").includes("FUTURE")).slice(0,3);
    if (nonFuture.length) console.log("🔍 [sports API] non-future samples:", JSON.stringify(nonFuture.map(m => ({
      slug: m.slug, q: (m.question||"").slice(0,60),
      v2type: m.sportsMarketTypeV2, v1type: m.sportsMarketType,
      mtype: m.marketType, cat: m.category, active: m.active
    }))));
  }

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
