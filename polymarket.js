/**
 * polymarket.js
 * Fetches live BTC markets from Polymarket.
 * Falls back to price-aware synthetic markets if none found with valid expiry.
 */

import axios from "axios";

let _botSettings = null;
async function getDryRun() {
  if (!_botSettings) {
    try { const m = await import("./bot.js"); _botSettings = m.botSettings; } catch {}
  }
  return _botSettings?.dryRun ?? (process.env.DRY_RUN !== "false");
}

const BTC_KW = [
  "bitcoin", "btc", "will btc", "will bitcoin",
  "btc above", "btc below", "bitcoin above", "bitcoin below",
  "btc price", "bitcoin price", "btc hit", "bitcoin hit",
  "btc end", "bitcoin end", "btc close", "bitcoin close",
  "btc reach", "bitcoin reach",
];

function isValidScalpMarket(m) {
  if (!m.endDateIso && !m.endDate) return false;
  const end = new Date(m.endDateIso || m.endDate);
  const msLeft = end - Date.now();
  const minLeft = msLeft / 60000;
  return minLeft >= 4 && minLeft <= 180; // 4 min to 3 hours
}

export async function fetchBTCMarkets() {
  // Try real Polymarket CLOB
  try {
    const { data } = await axios.get("https://clob.polymarket.com/markets", {
      params: { active: true, closed: false, limit: 200 },
      timeout: 10000,
      headers: { "Accept": "application/json" },
    });
    const all = data?.data || data || [];
    const btc = all
      .filter(m => {
        const q = (m.question || m.title || "").toLowerCase();
        return BTC_KW.some(kw => q.includes(kw));
      })
      .filter(isValidScalpMarket)
      .map(normalizeMarket);

    if (btc.length > 0) {
      console.log(`📊 Polymarket CLOB: ${btc.length} live BTC scalp markets`);
      return btc;
    }
    console.log(`📊 Polymarket CLOB: found BTC markets but none with valid expiry — using synthetic`);
  } catch (err) {
    console.log("⚠️  Polymarket CLOB:", err.message);
  }

  // Try Gamma API
  try {
    const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
      params: { active: true, closed: false, limit: 100 },
      timeout: 10000,
    });
    const all = Array.isArray(data) ? data : (data?.markets || []);
    const btc = all
      .filter(m => {
        const q = (m.question || m.groupItemTitle || "").toLowerCase();
        return BTC_KW.some(kw => q.includes(kw));
      })
      .filter(isValidScalpMarket)
      .map(normalizeMarket);

    if (btc.length > 0) {
      console.log(`📊 Gamma API: ${btc.length} live BTC scalp markets`);
      return btc;
    }
  } catch (err) {
    console.log("⚠️  Gamma API:", err.message);
  }

  // Synthetic markets — price-aware, correct expiry, no BS
  console.log("⚠️  No live markets found — using price-aware synthetic markets");
  return await getSyntheticMarkets();
}

function normalizeMarket(m) {
  if (!m.tokens && m.outcomes) {
    m.tokens = m.outcomes.map((o, i) => ({
      tokenId: m.clobTokenIds?.[i] || `${m.conditionId}_${i}`,
      outcome: o,
      price: m.outcomePrices?.[i]
        ? Math.min(0.97, Math.max(0.03, parseFloat(m.outcomePrices[i]) / (parseFloat(m.outcomePrices[i]) > 1 ? 100 : 1)))
        : 0.5,
    }));
  }
  if (m.tokens) {
    m.tokens = m.tokens.map(t => ({
      ...t,
      price: t.price > 1 ? Math.min(0.97, t.price / 100) : Math.min(0.97, Math.max(0.03, t.price)),
    }));
  }
  return m;
}

async function getSyntheticMarkets() {
  let btcPrice = 105000;
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", {
      params: { pair: "XBTUSD" }, timeout: 5000,
    });
    btcPrice = parseFloat(data.result?.XXBTZUSD?.c?.[0] || btcPrice);
  } catch {}

  const now = Date.now();
  const min = n => new Date(now + n * 60000).toISOString();

  // Strike prices relative to current
  const p = btcPrice;
  const r = (pct) => Math.round((p * (1 + pct)) / 100) * 100;

  // YES price reflects real probability — near-ATM ~0.47-0.53
  // Slightly OTM ~0.30-0.40, far OTM ~0.15-0.25
  return [
    {
      conditionId: `syn_15m_atm_${now}`,
      question: `Will BTC be above $${r(0).toLocaleString()} in 15 minutes?`,
      endDateIso: min(15),
      tokens: [
        { tokenId: `syn_y1_${now}`, outcome: "Yes", price: 0.49 },
        { tokenId: `syn_n1_${now}`, outcome: "No",  price: 0.51 },
      ],
    },
    {
      conditionId: `syn_15m_bull_${now}`,
      question: `Will BTC rise above $${r(0.005).toLocaleString()} in the next 15 minutes?`,
      endDateIso: min(15),
      tokens: [
        { tokenId: `syn_y2_${now}`, outcome: "Yes", price: 0.36 },
        { tokenId: `syn_n2_${now}`, outcome: "No",  price: 0.64 },
      ],
    },
    {
      conditionId: `syn_15m_bear_${now}`,
      question: `Will BTC drop below $${r(-0.005).toLocaleString()} in the next 15 minutes?`,
      endDateIso: min(15),
      tokens: [
        { tokenId: `syn_y3_${now}`, outcome: "Yes", price: 0.34 },
        { tokenId: `syn_n3_${now}`, outcome: "No",  price: 0.66 },
      ],
    },
    {
      conditionId: `syn_1h_bull_${now}`,
      question: `Will BTC close above $${r(0.01).toLocaleString()} in 1 hour?`,
      endDateIso: min(60),
      tokens: [
        { tokenId: `syn_y4_${now}`, outcome: "Yes", price: 0.41 },
        { tokenId: `syn_n4_${now}`, outcome: "No",  price: 0.59 },
      ],
    },
    {
      conditionId: `syn_1h_atm_${now}`,
      question: `Will BTC be higher than current price in 1 hour?`,
      endDateIso: min(60),
      tokens: [
        { tokenId: `syn_y5_${now}`, outcome: "Yes", price: 0.52 },
        { tokenId: `syn_n5_${now}`, outcome: "No",  price: 0.48 },
      ],
    },
    {
      conditionId: `syn_1h_bear_${now}`,
      question: `Will BTC drop below $${r(-0.01).toLocaleString()} in 1 hour?`,
      endDateIso: min(60),
      tokens: [
        { tokenId: `syn_y6_${now}`, outcome: "Yes", price: 0.38 },
        { tokenId: `syn_n6_${now}`, outcome: "No",  price: 0.62 },
      ],
    },
    {
      conditionId: `syn_90m_bull_${now}`,
      question: `Will BTC reach $${r(0.015).toLocaleString()} in the next 90 minutes?`,
      endDateIso: min(90),
      tokens: [
        { tokenId: `syn_y7_${now}`, outcome: "Yes", price: 0.33 },
        { tokenId: `syn_n7_${now}`, outcome: "No",  price: 0.67 },
      ],
    },
  ];
}

export async function placeOrder({ tokenId, side, size, price, marketQuestion }) {
  const dryRun = await getDryRun();

  if (dryRun) {
    const payout = parseFloat((size / price).toFixed(2));
    const profit = parseFloat((payout - size).toFixed(2));
    const order = {
      orderId: `dry_${side}_${Date.now()}`,
      tokenId, side,
      size: parseFloat(size.toFixed(2)),
      price: parseFloat(price.toFixed(4)),
      potentialPayout: payout,
      potentialProfit: profit,
      marketQuestion,
      status: "dry_filled",
      timestamp: new Date().toISOString(),
    };
    console.log(
      `    📋 DRY ${side} $${size.toFixed(2)} @ ${(price*100).toFixed(1)}¢` +
      ` | win → $${payout} (+$${profit})`
    );
    return order;
  }

  // LIVE
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const apiKey = process.env.POLYMARKET_API_KEY;
  if (!pk || pk.startsWith("your_") || !apiKey || apiKey.startsWith("your_")) {
    throw new Error("Live mode requires POLYMARKET_PRIVATE_KEY + POLYMARKET_API_KEY");
  }
  try {
    const { ClobClient, Side } = await import("@polymarket/clob-client");
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
    const client = new ClobClient("https://clob.polymarket.com", 137, wallet, {
      key: apiKey, secret: process.env.POLYMARKET_API_SECRET,
      passphrase: process.env.POLYMARKET_API_PASSPHRASE,
    });
    const order = await client.createAndPostOrder({
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      size: size.toString(), price: price.toString(),
    });
    console.log(`    ✅ LIVE ORDER: ${order.orderID} | ${side} $${size} @ ${price}`);
    return order;
  } catch (err) {
    throw new Error("CLOB order failed: " + err.message);
  }
}

export async function getBalance() {
  const dryRun = await getDryRun();
  if (dryRun) {
    try {
      const { getDryBalance } = await import("./state.js");
      return getDryBalance();
    } catch { return parseFloat(process.env.BANKROLL || "40"); }
  }
  // Live: would query Polymarket wallet — for now use env var
  return parseFloat(process.env.BANKROLL || "40");
}
