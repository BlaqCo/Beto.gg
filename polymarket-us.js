/**
 * polymarket-us.js — polymarket.us integration
 *
 * PUBLIC data:  direct calls to https://gateway.polymarket.us (no auth)
 * TRADING:      official polymarket-us SDK (handles Ed25519 signing)
 *
 * Env: POLYMARKET_API_KEY (Key ID) + POLYMARKET_PRIVATE_KEY (Secret Key)
 * Docs: https://docs.polymarket.us
 */

import axios from "axios";
import { PolymarketUS } from "polymarket-us";

const GATEWAY = "https://gateway.polymarket.us";

// ── Authenticated SDK client (trading only) ─────────────────────
let _auth = null;
export function authClient() {
  if (_auth) return _auth;
  const keyId     = process.env.POLYMARKET_API_KEY;
  const secretKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!keyId || !secretKey || keyId.startsWith("your_")) {
    throw new Error("POLYMARKET_API_KEY (Key ID) + POLYMARKET_PRIVATE_KEY (Secret Key) required");
  }
  _auth = new PolymarketUS({ keyId, secretKey, timeout: 15000 });
  return _auth;
}

// ── Public: sports moneyline markets ────────────────────────────
let _cache = null, _cacheTime = 0;
const TTL = 20_000;
const SUB_PERIOD = /first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter/i;

const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

export async function fetchSportsMoneylines() {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;

  // gRPC-gateway repeated params: key=v (not key[]=v) — build manually
  const qs = [
    "active=true",
    "closed=false",
    "limit=100",
    "sportsMarketTypes=SPORTS_MARKET_TYPE_MONEYLINE",
  ].join("&");

  const { data } = await axios.get(`${GATEWAY}/v1/markets?${qs}`, { timeout: 10_000 });
  const raw = data?.markets || [];

  const out = [];
  for (const m of raw) {
    if (!m.slug || m.active === false || m.closed === true) continue;
    const q = m.question || m.title || "";
    if (SUB_PERIOD.test(q)) continue;

    out.push({
      slug: m.slug,
      question: q,
      ask: num(m.bestAsk),
      bid: num(m.bestBid),
      tick: num(m.orderPriceMinTickSize) || 0.01,
      minQty: num(m.minimumTradeQty) || 1,
      gameStartIso: m.gameStartTime || null,
      endIso: m.endDate || null,
      category: m.category || "",
    });
  }
  _cache = out; _cacheTime = Date.now();
  return out;
}

// Lightweight live quote for one market (exit pricing)
export async function getBBO(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/bbo`, { timeout: 8_000 });
    const d = data?.marketData || data || {};
    const val = x => (x && x.value != null) ? Number(x.value) : num(x);
    return {
      bid:  val(d.bestBid),
      ask:  val(d.bestAsk),
      last: val(d.lastTradePx) ?? val(d.lastTradePrice),
    };
  } catch { return null; }
}

// Settlement: 1, 0, or null (not settled / unknown)
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

// ── Authenticated (SDK) ─────────────────────────────────────────
export async function getBuyingPower() {
  const b = await authClient().account.balances();
  return {
    buyingPower: Number(b.buyingPower) || 0,
    currentBalance: Number(b.currentBalance) || 0,
  };
}

/**
 * Live BUY: fill-or-kill limit at ask + 1 tick.
 * Whole contracts (always ≥ minimumTradeQty).
 */
export async function buyYesFOK({ slug, sizeUsd, ask, tick = 0.01 }) {
  const client = authClient();
  const limit = Math.min(0.99, Math.round((ask + tick) / tick) * tick);
  const qty = Math.floor(sizeUsd / limit);
  if (qty < 1) return { filled: false, error: `size $${sizeUsd} < 1 contract @ ${limit.toFixed(2)}` };

  try {
    const order = await client.orders.create({
      marketSlug: slug,
      intent: "ORDER_INTENT_BUY_LONG",
      type: "ORDER_TYPE_LIMIT",
      price: { value: limit.toFixed(2), currency: "USD" },
      quantity: qty,
      tif: "TIME_IN_FORCE_FILL_OR_KILL",
    });

    let state = order.state;
    if (state === "ORDER_STATE_PENDING_NEW") {
      await new Promise(r => setTimeout(r, 1200));
      try { state = (await client.orders.retrieve(order.id)).state; } catch {}
    }

    if (state === "ORDER_STATE_FILLED") {
      return { filled: true, qty, fillPrice: limit, cost: +(qty * limit).toFixed(2), orderId: order.id };
    }
    return { filled: false, error: `order ${state}`, orderId: order.id };
  } catch (err) {
    return { filled: false, error: err.message };
  }
}

/** Live full exit at market (TP/SL/manual). */
export async function closePositionLive(slug) {
  try {
    await authClient().orders.closePosition({ marketSlug: slug });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Preflight ───────────────────────────────────────────────────
export async function preflightUS() {
  const msgs = [];
  try { authClient(); msgs.push("✅ API credentials present"); }
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
    return { ok: false, messages: msgs };
  }
  return { ok: true, messages: msgs };
}
