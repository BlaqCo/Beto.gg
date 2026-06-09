/**
 * polymarket.js
 *
 * Multi-crypto support: BTC, ETH, SOL, BNB, XRP, DOGE
 * Fetches live prices for each coin and generates synthetic markets.
 * CLOB/Gamma search expanded to all crypto keywords.
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

// ── Crypto keywords for CLOB/Gamma filtering ───────────────────────────────
const CRYPTO_KW = [
  // BTC
  "bitcoin","btc","will btc","will bitcoin",
  // ETH
  "ethereum","eth","will eth","will ethereum",
  // SOL
  "solana","sol","will sol","will solana",
  // BNB
  "bnb","binance coin","will bnb",
  // XRP
  "xrp","ripple","will xrp","will ripple",
  // DOGE
  "dogecoin","doge","will doge","will dogecoin",
];

function isValidScalpMarket(m) {
  if (!m.endDateIso && !m.endDate) return false;
  const minLeft = (new Date(m.endDateIso || m.endDate) - Date.now()) / 60000;
  return minLeft >= 4 && minLeft <= 1440;
}

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
    const crypto = all
      .filter(m => {
        const q = (m.question || m.title || "").toLowerCase();
        return CRYPTO_KW.some(kw => q.includes(kw));
      })
      .filter(isValidScalpMarket)
      .map(normalizeMarket);
    if (crypto.length > 0) {
      console.log(`📊 Polymarket CLOB: ${crypto.length} live crypto scalp markets`);
      return crypto;
    }
    console.log(`📊 Polymarket CLOB: found crypto markets but none with valid expiry — using synthetic`);
  } catch (err) {
    console.log("⚠️ Polymarket CLOB:", err.message);
  }

  // Try Gamma API (60s cache)
  if (Date.now() - _gammaCacheTime < 60000 && _gammaCache?.length > 0) {
    return _gammaCache;
  }
  try {
    const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
      params: { active: true, closed: false, limit: 100 }, timeout: 10000,
    });
    const all = Array.isArray(data) ? data : (data?.markets || []);
    const crypto = all
      .filter(m => {
        const q = (m.question || m.groupItemTitle || "").toLowerCase();
        return CRYPTO_KW.some(kw => q.includes(kw));
      })
      .filter(isValidScalpMarket)
      .map(normalizeMarket);
    _gammaCache = crypto; _gammaCacheTime = Date.now();
    if (crypto.length > 0) {
      console.log(`📊 Gamma API: ${crypto.length} live crypto scalp markets`);
      return crypto;
    }
  } catch (err) {
    console.log("⚠️ Gamma API:", err.message);
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

// ── Live price fetcher for all coins ──────────────────────────────────────
let _priceCache = {}, _priceCacheTime = 0;

async function getLivePrices() {
  if (Date.now() - _priceCacheTime < 30000 && Object.keys(_priceCache).length > 0) {
    return _priceCache;
  }

  const prices = {
    BTC: 105000, ETH: 3500, SOL: 180, BNB: 600, XRP: 0.60, DOGE: 0.18,
  };

  // Kraken for BTC + ETH
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", {
      params: { pair: "XBTUSD,ETHUSD" }, timeout: 5000,
    });
    const r = data.result || {};
    if (r.XXBTZUSD?.c?.[0]) prices.BTC = parseFloat(r.XXBTZUSD.c[0]);
    if (r.XETHZUSD?.c?.[0]) prices.ETH = parseFloat(r.XETHZUSD.c[0]);
  } catch {}

  // CoinGecko for SOL, BNB, XRP, DOGE
  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: { ids: "solana,binancecoin,ripple,dogecoin", vs_currencies: "usd" },
        timeout: 5000,
      }
    );
    if (data.solana?.usd)      prices.SOL  = data.solana.usd;
    if (data.binancecoin?.usd) prices.BNB  = data.binancecoin.usd;
    if (data.ripple?.usd)      prices.XRP  = data.ripple.usd;
    if (data.dogecoin?.usd)    prices.DOGE = data.dogecoin.usd;
  } catch {}

  _priceCache = prices;
  _priceCacheTime = Date.now();
  return prices;
}

// ── Synthetic market generator ─────────────────────────────────────────────
async function getSyntheticMarkets() {
  const prices = await getLivePrices();
  const now    = Date.now();
  const min    = n => new Date(now + n * 60000).toISOString();
  const ssMode = isSharpShooter();

  // Round price to nearest sensible increment per coin
  const round = (price, coin) => {
    const increments = { BTC: 100, ETH: 10, SOL: 1, BNB: 5, XRP: 0.01, DOGE: 0.001 };
    const inc = increments[coin] || 1;
    return Math.round(price / inc) * inc;
  };

  const fmt = (price, coin) => {
    if (coin === "XRP" || coin === "DOGE") return `$${price.toFixed(coin === "DOGE" ? 4 : 3)}`;
    return `$${round(price, coin).toLocaleString()}`;
  };

  // Percentage moves per coin (smaller coins move more)
  const moves = {
    BTC:  { sm: 0.003, md: 0.006, lg: 0.010 },
    ETH:  { sm: 0.004, md: 0.008, lg: 0.015 },
    SOL:  { sm: 0.005, md: 0.010, lg: 0.020 },
    BNB:  { sm: 0.004, md: 0.008, lg: 0.015 },
    XRP:  { sm: 0.005, md: 0.010, lg: 0.020 },
    DOGE: { sm: 0.006, md: 0.012, lg: 0.025 },
  };

  const mkts = [];

  for (const [coin, p] of Object.entries(prices)) {
    const mv = moves[coin];
    const up_sm = fmt(p * (1 + mv.sm), coin);
    const up_md = fmt(p * (1 + mv.md), coin);
    const up_lg = fmt(p * (1 + mv.lg), coin);
    const dn_sm = fmt(p * (1 - mv.sm), coin);
    const dn_md = fmt(p * (1 - mv.md), coin);
    const dn_lg = fmt(p * (1 - mv.lg), coin);
    const atm   = fmt(p, coin);

    if (ssMode) {
      // SS: 30-90 min markets per coin
      const questions = [
        { q: `Will ${coin} be above ${atm} in 30 minutes?`,          exp: min(30),  yp: 0.50, pfx: `ss_${coin}_30a` },
        { q: `Will ${coin} rise above ${up_sm} in 30 minutes?`,      exp: min(30),  yp: 0.40, pfx: `ss_${coin}_30b` },
        { q: `Will ${coin} drop below ${dn_sm} in 30 minutes?`,      exp: min(30),  yp: 0.40, pfx: `ss_${coin}_30c` },
        { q: `Will ${coin} be above ${atm} in 45 minutes?`,          exp: min(45),  yp: 0.50, pfx: `ss_${coin}_45a` },
        { q: `Will ${coin} reach ${up_md} in 45 minutes?`,           exp: min(45),  yp: 0.42, pfx: `ss_${coin}_45b` },
        { q: `Will ${coin} fall below ${dn_md} in 45 minutes?`,      exp: min(45),  yp: 0.42, pfx: `ss_${coin}_45c` },
        { q: `Will ${coin} be above ${atm} in 60 minutes?`,          exp: min(60),  yp: 0.50, pfx: `ss_${coin}_60a` },
        { q: `Will ${coin} hit ${up_lg} within 60 minutes?`,         exp: min(60),  yp: 0.38, pfx: `ss_${coin}_60b` },
        { q: `Will ${coin} drop below ${dn_lg} within 60 minutes?`,  exp: min(60),  yp: 0.38, pfx: `ss_${coin}_60c` },
        { q: `Will ${coin} reach ${up_lg} in 90 minutes?`,           exp: min(90),  yp: 0.35, pfx: `ss_${coin}_90b` },
      ];
      for (const { q, exp, yp, pfx } of questions) {
        const np = parseFloat((1 - yp).toFixed(2));
        mkts.push({
          conditionId: stableId(pfx, q),
          question: q,
          endDateIso: exp,
          coin,
          tokens: [
            { tokenId: stableId(pfx + "y", q), outcome: "Yes", price: yp },
            { tokenId: stableId(pfx + "n", q), outcome: "No",  price: np },
          ],
        });
      }
    } else {
      // Normal: 15-90 min markets per coin
      const questions = [
        { q: `Will ${coin} be above ${atm} in 15 minutes?`,        exp: min(15), yp: 0.49, pfx: `n_${coin}_15a` },
        { q: `Will ${coin} rise above ${up_sm} in 15 minutes?`,    exp: min(15), yp: 0.36, pfx: `n_${coin}_15b` },
        { q: `Will ${coin} drop below ${dn_sm} in 15 minutes?`,    exp: min(15), yp: 0.34, pfx: `n_${coin}_15c` },
        { q: `Will ${coin} close above ${up_md} in 1 hour?`,       exp: min(60), yp: 0.41, pfx: `n_${coin}_60a` },
        { q: `Will ${coin} be higher than now in 1 hour?`,         exp: min(60), yp: 0.52, pfx: `n_${coin}_60b` },
        { q: `Will ${coin} drop below ${dn_md} in 1 hour?`,        exp: min(60), yp: 0.38, pfx: `n_${coin}_60c` },
        { q: `Will ${coin} reach ${up_lg} in the next 90 minutes?`,exp: min(90), yp: 0.33, pfx: `n_${coin}_90a` },
      ];
      for (const { q, exp, yp, pfx } of questions) {
        const np = parseFloat((1 - yp).toFixed(2));
        mkts.push({
          conditionId: stableId(pfx, q),
          question: q,
          endDateIso: exp,
          coin,
          tokens: [
            { tokenId: stableId(pfx + "y", q), outcome: "Yes", price: yp },
            { tokenId: stableId(pfx + "n", q), outcome: "No",  price: np },
          ],
        });
      }
    }
  }

  const coinCount = Object.keys(prices).length;
  const mktCount  = mkts.length;
  console.log(`⚡ Synthetic: ${mktCount} markets across ${coinCount} coins (BTC/ETH/SOL/BNB/XRP/DOGE)`);
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
