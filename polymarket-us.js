/**
 * polymarket-us.js — Official polymarket.us SDK wrapper
 *
 * Auth:   POLYMARKET_API_KEY (Key ID) + POLYMARKET_PRIVATE_KEY (Secret Key)
 * Public: markets/sports data needs no auth.
 * Docs:   https://docs.polymarket.us
 */

import { PolymarketUS } from "polymarket-us";

let _public = null, _auth = null;

function publicClient() {
  if (!_public) _public = new PolymarketUS();
  return _public;
}

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

// Sub-period winners can slip through MONEYLINE filters; exclude them.
const SUB_PERIOD = /first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter/i;

export async function fetchSportsMoneylines() {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;

  const res = await publicClient().markets.list({
    active: true,
    sportsMarketTypes: ["MONEYLINE"],
    limit: 250,
  });
  const raw = res?.markets || res || [];

  const out = [];
  for (const m of raw) {
    if (!m.slug || !m.question) continue;
    if (m.active === false) continue;
    if (SUB_PERIOD.test(m.question)) continue;

    const ask = Number(m.bestAsk);
    const bid = Number(m.bestBid);
    const last = Number(m.lastTradePrice);
    out.push({
      slug: m.slug,
      question: m.question,
      ask: Number.isFinite(ask) && ask > 0 ? ask : null,
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
      last: Number.isFinite(last) && last > 0 ? last : null,
      volume: Number(m.volume) || 0,
      liquidity: Number(m.liquidity) || 0,
      gameStartIso: m.gameStartTime || m.eventStartTime || null,
      endIso: m.endDate || m.endDateIso || null,
    });
  }
  _cache = out; _cacheTime = Date.now();
  return out;
}

// Lightweight live quote for one market (exit pricing)
export async function getBBO(slug) {
  try {
    const r = await publicClient().markets.bbo(slug);
    const d = r?.marketData || r || {};
    return {
      bid: d.bestBid?.value != null ? Number(d.bestBid.value) : null,
      ask: d.bestAsk?.value != null ? Number(d.bestAsk.value) : null,
      last: d.lastTradePx?.value != null ? Number(d.lastTradePx.value) : null,
    };
  } catch { return null; }
}

// Settlement check: returns 1, 0, or null (not settled / unknown)
export async function getSettlement(slug) {
  try {
    const r = await publicClient().markets.settlement(slug);
    const v = Number(r?.settlement);
    if (v >= 0.99) return 1;
    if (v <= 0.01) return 0;
    return null;
  } catch { return null; }
}

// ── Authenticated ───────────────────────────────────────────────
export async function getBuyingPower() {
  const b = await authClient().account.balances();
  return {
    buyingPower: Number(b.buyingPower) || 0,
    currentBalance: Number(b.currentBalance) || 0,
  };
}

/**
 * Live BUY: fill-or-kill limit at ask + 1¢ buffer.
 * Whole contracts only (always valid regardless of minimumTradeQty).
 * Returns { filled, qty, fillPrice, cost, orderId } or { filled:false, error }.
 */
export async function buyYesFOK({ slug, sizeUsd, ask }) {
  const client = authClient();
  const limit = Math.min(0.99, Math.round((ask + 0.01) * 100) / 100);
  const qty = Math.floor(sizeUsd / limit);
  if (qty < 1) return { filled: false, error: `size $${sizeUsd} < 1 contract @ ${limit}` };

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
    // FOK resolves fast; confirm if still pending
    if (state === "ORDER_STATE_PENDING_NEW") {
      await new Promise(r => setTimeout(r, 1200));
      try { state = (await client.orders.retrieve(order.id)).state; } catch {}
    }

    if (state === "ORDER_STATE_FILLED") {
      return { filled: true, qty, fillPrice: limit, cost: qty * limit, orderId: order.id };
    }
    return { filled: false, error: `order ${state}`, orderId: order.id };
  } catch (err) {
    return { filled: false, error: err.message };
  }
}

/**
 * Live full exit at market (used for TP/SL and manual closes).
 */
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
  try {
    authClient();
    msgs.push("✅ API credentials present");
  } catch (e) {
    msgs.push("❌ " + e.message);
    return { ok: false, messages: msgs };
  }
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
