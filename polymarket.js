/**
 * polymarket.js
 *
 * FIXES:
 * 1. Synthetic market conditionIds are now STABLE per session (no _${now} suffix)
 *    so hasActiveBet() correctly blocks duplicate entries on the same market.
 * 2. SharpShooter-aware market set: when SS mode is on, generates 30-60 min
 *    markets so TP has time to fire before expiry.
 * 3. Gamma API cache to prevent 429s.
 */

import axios from "axios";

let _botSettings = null;
async function getDryRun() {
  if (!_botSettings) {
    try { const m = await import("./bot.js"); _botSettings = m.botSettings; } catch {}
  }
  return _botSettings?.dryRun ?? (process.env.DRY_RUN !== "false");
}
function isSharpShooter() { return _botSettings?.sharpShooter ?? false; }

const BTC_KW = [
  "bitcoin","btc","will btc","will bitcoin",
  "btc above","btc below","bitcoin above","bitcoin below",
  "btc price","bitcoin price","btc hit","bitcoin hit",
  "btc end","bitcoin end","btc close","bitcoin close",
  "btc reach","bitcoin reach",
];

function isValidScalpMarket(m) {
  if (!m.endDateIso && !m.endDate) return false;
  const msLeft = new Date(m.endDateIso || m.endDate) - Date.now();
  const minLeft = msLeft / 60000;
  return minLeft >= 4 && minLeft <= 1440;
}

// Stable conditionId: based on question content, not timestamp
// This is the KEY fix — same question = same ID every scan
function stableId(prefix, question) {
  let hash = 0;
  for (let i = 0; i < question.length; i++) {
    hash = ((hash << 5) - hash) + question.charCodeAt(i);
    hash |= 0;
  }
  return `${prefix}_${Math.abs(hash)}`;
}

let _gammaCache = null, _gammaCacheTime = 0;

export async function fetchBTCMarkets() {
  // Try real CLOB
  try {
    const { data } = await axios.get("https://clob.polymarket.com/markets", {
      params: { active: true, closed: false, limit: 200 },
      timeout: 10000,
      headers: { "Accept": "application/json" },
    });
    const all = data?.data || data || [];
    const btc = all
      .filter(m => { const q = (m.question||m.title||"").toLowerCase(); return BTC_KW.some(kw => q.includes(kw)); })
      .filter(isValidScalpMarket)
      .map(normalizeMarket);
    if (btc.length > 0) {
      console.log(`📊 Polymarket CLOB: ${btc.length} live BTC scalp markets`);
      return btc;
    }
    console.log(`📊 Polymarket CLOB: found BTC markets but none with valid expiry — using synthetic`);
  } catch (err) {
    console.log("⚠️ Polymarket CLOB:", err.message);
  }

  // Try Gamma API (60s cache)
  if (Date.now() - _gammaCacheTime < 60000 && _gammaCache) {
    if (_gammaCache.length > 0) return _gammaCache;
  } else {
    try {
      const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
        params: { active: true, closed: false, limit: 100 }, timeout: 10000,
      });
      const all = Array.isArray(data) ? data : (data?.markets || []);
      const btc = all
        .filter(m => { const q = (m.question||m.groupItemTitle||"").toLowerCase(); return BTC_KW.some(kw => q.includes(kw)); })
        .filter(isValidScalpMarket)
        .map(normalizeMarket);
      _gammaCache = btc; _gammaCacheTime = Date.now();
      if (btc.length > 0) {
        console.log(`📊 Gamma API: ${btc.length} live BTC scalp markets`);
        return btc;
      }
    } catch (err) {
      console.log("⚠️ Gamma API:", err.message);
    }
  }

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

  const now  = Date.now();
  const min  = n => new Date(now + n * 60000).toISOString();
  const p    = btcPrice;
  const r    = (pct) => Math.round((p * (1 + pct)) / 100) * 100;

  const ssMode = isSharpShooter();

  // STABLE IDs: use question string hash, not timestamp
  // This means the same market is identifiable across scans —
  // hasActiveBet() will correctly block re-entry until the bet resolves.
  const mkts = [];

  if (ssMode) {
    // SharpShooter markets: 30-60 min so 3-5% TP has time to fire
    // ATM markets near 50/50 — best for SS since either side can win
    const q30atm  = `Will BTC be above $${r(0).toLocaleString()} in 30 minutes?`;
    const q30bull = `Will BTC rise above $${r(0.003).toLocaleString()} in 30 minutes?`;
    const q30bear = `Will BTC drop below $${r(-0.003).toLocaleString()} in 30 minutes?`;
    const q45atm  = `Will BTC be above $${r(0).toLocaleString()} in 45 minutes?`;
    const q45bull = `Will BTC reach $${r(0.005).toLocaleString()} in 45 minutes?`;
    const q45bear = `Will BTC fall below $${r(-0.005).toLocaleString()} in 45 minutes?`;
    const q60atm  = `Will BTC be above $${r(0).toLocaleString()} in 60 minutes?`;
    const q60bull = `Will BTC hit $${r(0.008).toLocaleString()} within 60 minutes?`;
    const q60bear = `Will BTC drop below $${r(-0.008).toLocaleString()} within 60 minutes?`;
    const q90bull = `Will BTC reach $${r(0.012).toLocaleString()} in 90 minutes?`;

    mkts.push(
      { conditionId: stableId("ss30a", q30atm),  question: q30atm,  endDateIso: min(30), tokens: [{ tokenId: stableId("ss30ay", q30atm),  outcome:"Yes", price:0.50 }, { tokenId: stableId("ss30an", q30atm),  outcome:"No", price:0.50 }] },
      { conditionId: stableId("ss30b", q30bull),  question: q30bull, endDateIso: min(30), tokens: [{ tokenId: stableId("ss30by", q30bull),  outcome:"Yes", price:0.40 }, { tokenId: stableId("ss30bn", q30bull),  outcome:"No", price:0.60 }] },
      { conditionId: stableId("ss30c", q30bear),  question: q30bear, endDateIso: min(30), tokens: [{ tokenId: stableId("ss30cy", q30bear),  outcome:"Yes", price:0.40 }, { tokenId: stableId("ss30cn", q30bear),  outcome:"No", price:0.60 }] },
      { conditionId: stableId("ss45a", q45atm),   question: q45atm,  endDateIso: min(45), tokens: [{ tokenId: stableId("ss45ay", q45atm),   outcome:"Yes", price:0.50 }, { tokenId: stableId("ss45an", q45atm),   outcome:"No", price:0.50 }] },
      { conditionId: stableId("ss45b", q45bull),  question: q45bull, endDateIso: min(45), tokens: [{ tokenId: stableId("ss45by", q45bull),  outcome:"Yes", price:0.42 }, { tokenId: stableId("ss45bn", q45bull),  outcome:"No", price:0.58 }] },
      { conditionId: stableId("ss45c", q45bear),  question: q45bear, endDateIso: min(45), tokens: [{ tokenId: stableId("ss45cy", q45bear),  outcome:"Yes", price:0.42 }, { tokenId: stableId("ss45cn", q45bear),  outcome:"No", price:0.58 }] },
      { conditionId: stableId("ss60a", q60atm),   question: q60atm,  endDateIso: min(60), tokens: [{ tokenId: stableId("ss60ay", q60atm),   outcome:"Yes", price:0.50 }, { tokenId: stableId("ss60an", q60atm),   outcome:"No", price:0.50 }] },
      { conditionId: stableId("ss60b", q60bull),  question: q60bull, endDateIso: min(60), tokens: [{ tokenId: stableId("ss60by", q60bull),  outcome:"Yes", price:0.38 }, { tokenId: stableId("ss60bn", q60bull),  outcome:"No", price:0.62 }] },
      { conditionId: stableId("ss60c", q60bear),  question: q60bear, endDateIso: min(60), tokens: [{ tokenId: stableId("ss60cy", q60bear),  outcome:"Yes", price:0.38 }, { tokenId: stableId("ss60cn", q60bear),  outcome:"No", price:0.62 }] },
      { conditionId: stableId("ss90b", q90bull),  question: q90bull, endDateIso: min(90), tokens: [{ tokenId: stableId("ss90by", q90bull),  outcome:"Yes", price:0.35 }, { tokenId: stableId("ss90bn", q90bull),  outcome:"No", price:0.65 }] },
    );
  } else {
    // Normal mode: 15 min + 1h markets
    const q15atm  = `Will BTC be above $${r(0).toLocaleString()} in 15 minutes?`;
    const q15bull = `Will BTC rise above $${r(0.005).toLocaleString()} in the next 15 minutes?`;
    const q15bear = `Will BTC drop below $${r(-0.005).toLocaleString()} in the next 15 minutes?`;
    const q60bull = `Will BTC close above $${r(0.01).toLocaleString()} in 1 hour?`;
    const q60atm  = `Will BTC be higher than current price in 1 hour?`;
    const q60bear = `Will BTC drop below $${r(-0.01).toLocaleString()} in 1 hour?`;
    const q90bull = `Will BTC reach $${r(0.015).toLocaleString()} in the next 90 minutes?`;

    mkts.push(
      { conditionId: stableId("n15a", q15atm),  question: q15atm,  endDateIso: min(15), tokens: [{ tokenId: stableId("n15ay", q15atm),  outcome:"Yes", price:0.49 }, { tokenId: stableId("n15an", q15atm),  outcome:"No", price:0.51 }] },
      { conditionId: stableId("n15b", q15bull), question: q15bull, endDateIso: min(15), tokens: [{ tokenId: stableId("n15by", q15bull), outcome:"Yes", price:0.36 }, { tokenId: stableId("n15bn", q15bull), outcome:"No", price:0.64 }] },
      { conditionId: stableId("n15c", q15bear), question: q15bear, endDateIso: min(15), tokens: [{ tokenId: stableId("n15cy", q15bear), outcome:"Yes", price:0.34 }, { tokenId: stableId("n15cn", q15bear), outcome:"No", price:0.66 }] },
      { conditionId: stableId("n60a", q60bull), question: q60bull, endDateIso: min(60), tokens: [{ tokenId: stableId("n60ay", q60bull), outcome:"Yes", price:0.41 }, { tokenId: stableId("n60an", q60bull), outcome:"No", price:0.59 }] },
      { conditionId: stableId("n60b", q60atm),  question: q60atm,  endDateIso: min(60), tokens: [{ tokenId: stableId("n60by", q60atm),  outcome:"Yes", price:0.52 }, { tokenId: stableId("n60bn", q60atm),  outcome:"No", price:0.48 }] },
      { conditionId: stableId("n60c", q60bear), question: q60bear, endDateIso: min(60), tokens: [{ tokenId: stableId("n60cy", q60bear), outcome:"Yes", price:0.38 }, { tokenId: stableId("n60cn", q60bear), outcome:"No", price:0.62 }] },
      { conditionId: stableId("n90a", q90bull), question: q90bull, endDateIso: min(90), tokens: [{ tokenId: stableId("n90ay", q90bull), outcome:"Yes", price:0.33 }, { tokenId: stableId("n90an", q90bull), outcome:"No", price:0.67 }] },
    );
  }

  return mkts;
}

export async function placeOrder({ tokenId, side, size, price, marketQuestion }) {
  const dryRun = await getDryRun();

  if (dryRun) {
    const payout = parseFloat((size / price).toFixed(2));
    const profit = parseFloat((payout - size).toFixed(2));
    const order = {
      orderID: `dry_${side}_${Date.now()}`,
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
      `    📋 DRY BUY $${size.toFixed(2)} @ ${(price*100).toFixed(1)}¢` +
      ` | win → $${payout} (+$${profit})`
    );
    return order;
  }

  // LIVE
  const pk     = process.env.POLYMARKET_PRIVATE_KEY;
  const apiKey = process.env.POLYMARKET_API_KEY;
  if (!pk || pk.startsWith("your_") || !apiKey || apiKey.startsWith("your_")) {
    throw new Error("Live mode requires POLYMARKET_PRIVATE_KEY + POLYMARKET_API_KEY");
  }

  try {
    const { ClobClient, Side } = await import("@polymarket/clob-client");
    const { ethers }           = await import("ethers");
    const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
    const client = new ClobClient("https://clob.polymarket.com", 137, wallet, {
      key: apiKey, secret: process.env.POLYMARKET_API_SECRET,
      passphrase: process.env.POLYMARKET_API_PASSPHRASE,
    });
    const order = await client.createAndPostOrder({
      tokenID: tokenId,
      side:    side === "BUY" ? Side.BUY : Side.SELL,
      size:    size.toString(), price: price.toString(),
    });
    console.log(` ✅ LIVE ORDER: ${order.orderID} | ${side} $${size} @ ${price}`);
    return order;
  } catch (err) {
    throw new Error("CLOB order failed: " + err.message);
  }
}

export async function getBalance() {
  const dryRun = await getDryRun();
  if (dryRun) {
    try { const { getDryBalance } = await import("./state.js"); return getDryBalance(); }
    catch { return parseFloat(process.env.BANKROLL || "40"); }
  }
  return parseFloat(process.env.BANKROLL || "40");
}
