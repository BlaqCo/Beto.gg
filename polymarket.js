/**
 * polymarket.js v3 — REAL markets first, honest synthetic fallback
 *
 * 1. REAL MARKETS: Gamma API queried for markets expiring in the next 3h,
 *    sorted by end date (this is how Polymarket's hourly crypto markets
 *    surface). JSON-string fields (outcomePrices, outcomes, clobTokenIds)
 *    are properly parsed. When crypto markets get rejected, the 3 nearest
 *    are logged with raw dates so we can see exactly why.
 *
 * 2. HONEST SYNTHETIC FALLBACK — a live market maker, not frozen quotes:
 *    • Markets live in a registry with FIXED strikes; expired ones are
 *      pruned and replaced with fresh strikes from current spot
 *    • Every quote is repriced with Black-Scholes from live spot —
 *      the MM's vol estimate differs from the bot's by a per-market
 *      factor (0.85–1.25x), plus a 2¢ spread and ±1.5¢ noise
 *    • Quotes refresh every 30s (MM reaction lag — the bot's only
 *      systematic edge is being faster or having a better vol read,
 *      exactly like live trading)
 *    The bot can no longer farm stale prices. Any edge it finds now has
 *    to come from model disagreement + speed, after spread and fees.
 */

import axios from "axios";

let _botSettings = null;
async function getDryRun() {
  if (!_botSettings) {
    try { const m = await import("./bot.js"); _botSettings = m.botSettings; } catch {}
  }
  return _botSettings?.dryRun ?? (process.env.DRY_RUN !== "false");
}

// ── Crypto keywords for live-market filtering ──────────────────
const CRYPTO_KW = [
  "bitcoin","btc","ethereum","eth","solana","sol",
  "bnb","binance coin","xrp","ripple","dogecoin","doge",
];

function stableId(prefix, question) {
  let hash = 0;
  for (let i = 0; i < question.length; i++) {
    hash = ((hash << 5) - hash) + question.charCodeAt(i);
    hash |= 0;
  }
  return `${prefix}_${Math.abs(hash)}`;
}

function minutesLeft(m) {
  const d = m.endDateIso || m.endDate || m.end_date_iso;
  if (!d) return null;
  const ms = new Date(d) - Date.now();
  return Number.isFinite(ms) ? ms / 60000 : null;
}

/** Parse Gamma's JSON-string fields safely. */
function jparse(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return null;
}

function normalizeGammaMarket(m) {
  const outcomes = jparse(m.outcomes)      || ["Yes", "No"];
  const prices   = jparse(m.outcomePrices) || [];
  const tokenIds = jparse(m.clobTokenIds)  || [];
  const tokens = outcomes.map((o, i) => {
    let p = parseFloat(prices[i]);
    if (!Number.isFinite(p)) p = 0.5;
    if (p > 1) p = p / 100;
    return {
      tokenId: tokenIds[i] || `${m.conditionId || m.id}_${i}`,
      outcome: o,
      price: Math.min(0.97, Math.max(0.03, p)),
    };
  });
  return {
    conditionId: m.conditionId || m.id,
    question:    m.question || m.title || "",
    endDateIso:  m.endDateIso || m.endDate || m.end_date_iso,
    coin:        null, // scalper/bot derive coin from question text
    tokens,
    live: true,
  };
}

let _gammaCache = null, _gammaCacheTime = 0;

export async function fetchBTCMarkets() {
  // ── REAL MARKETS: Gamma, sorted by soonest expiry, next 3 hours ──
  if (Date.now() - _gammaCacheTime < 45000 && _gammaCache?.length > 0) {
    return _gammaCache;
  }
  try {
    const nowIso = new Date(Date.now() + 4 * 60000).toISOString();   // ≥4 min out
    const maxIso = new Date(Date.now() + 3 * 3600000).toISOString(); // ≤3 hours out
    const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
      params: {
        active: true, closed: false, limit: 300,
        order: "endDate", ascending: true,
        end_date_min: nowIso, end_date_max: maxIso,
      },
      timeout: 10000,
    });
    const all = Array.isArray(data) ? data : (data?.markets || []);
    const crypto = all.filter(m => {
      const q = (m.question || m.title || "").toLowerCase();
      return CRYPTO_KW.some(kw => q.includes(kw));
    });

    const valid = crypto
      .map(normalizeGammaMarket)
      .filter(m => {
        const mins = minutesLeft(m);
        return mins !== null && mins >= 4 && mins <= 180;
      });

    if (valid.length > 0) {
      console.log(`📊 Polymarket LIVE: ${valid.length} real crypto markets (next 3h) — paper trading REAL prices`);
      _gammaCache = valid; _gammaCacheTime = Date.now();
      return valid;
    }

    // Diagnostics: show why crypto markets were rejected
    if (crypto.length > 0) {
      console.log(`📊 Gamma: ${crypto.length} crypto markets found, 0 in 4-180min window. Nearest:`);
      crypto.slice(0, 3).forEach(m => {
        const mins = minutesLeft(m);
        console.log(`   · "${(m.question||"").slice(0,55)}" endDate=${m.endDate || m.endDateIso} (${mins === null ? "unparseable" : mins.toFixed(0) + " min"})`);
      });
    } else {
      console.log(`📊 Gamma: 0 crypto markets in next-3h window`);
    }
  } catch (err) {
    console.log("⚠️ Gamma API:", err.message);
  }

  console.log("⚠️  No live markets — using REPRICED synthetic markets (live MM sim)");
  return await getSyntheticMarkets();
}

// ── Live price fetcher ─────────────────────────────────────────
let _priceCache = {}, _priceCacheTime = 0;

async function getLivePrices() {
  if (Date.now() - _priceCacheTime < 15000 && Object.keys(_priceCache).length > 0) {
    return _priceCache;
  }
  const prices = { ..._priceCache };
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", {
      params: { pair: "XBTUSD,ETHUSD" }, timeout: 5000,
    });
    const r = data.result || {};
    if (r.XXBTZUSD?.c?.[0]) prices.BTC = parseFloat(r.XXBTZUSD.c[0]);
    if (r.XETHZUSD?.c?.[0]) prices.ETH = parseFloat(r.XETHZUSD.c[0]);
  } catch {}
  try {
    const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: { ids: "solana,binancecoin,ripple,dogecoin", vs_currencies: "usd" },
      timeout: 5000,
    });
    if (data.solana?.usd)      prices.SOL  = data.solana.usd;
    if (data.binancecoin?.usd) prices.BNB  = data.binancecoin.usd;
    if (data.ripple?.usd)      prices.XRP  = data.ripple.usd;
    if (data.dogecoin?.usd)    prices.DOGE = data.dogecoin.usd;
  } catch {}
  if (Object.keys(prices).length > 0) {
    _priceCache = prices;
    _priceCacheTime = Date.now();
  }
  return _priceCache;
}

// ── Black-Scholes pricing for the synthetic market maker ───────
function normalCDF(x) {
  const a = 0.2316419, b1 = 0.319381530, b2 = -0.356563782,
        b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const t = 1 / (1 + a * Math.abs(x));
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const n = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
  return x >= 0 ? n : 1 - n;
}
const BASE_VOL = { BTC: 0.80, ETH: 1.00, SOL: 1.50, BNB: 1.00, XRP: 1.20, DOGE: 1.80 };

function probAbove(spot, strike, msLeft, coin, volFactor) {
  if (!spot || !strike || msLeft <= 0) return 0.5;
  const T = Math.max(msLeft, 30000) / (365.25 * 24 * 3600 * 1000);
  const sigma = (BASE_VOL[coin] || 0.80) * volFactor;
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return normalCDF(d2);
}

// ── Synthetic market registry: fixed strikes, live repriced ────
const HALF_SPREAD = 0.01;   // 1¢ each side (2¢ book spread)
const QUOTE_NOISE = 0.015;  // ±1.5¢ retail noise
const QUOTE_TTL   = 30000;  // MM requotes every 30s (reaction lag)

const _book = new Map();    // conditionId → market def
const _quotes = new Map();  // conditionId → { yes, no, at }

const LADDER = [
  { mins: 15, kind: "atm" }, { mins: 15, kind: "up_sm" }, { mins: 15, kind: "dn_sm" },
  { mins: 30, kind: "atm" }, { mins: 30, kind: "up_sm" }, { mins: 30, kind: "dn_sm" },
  { mins: 45, kind: "up_md" }, { mins: 45, kind: "dn_md" },
  { mins: 60, kind: "atm" }, { mins: 60, kind: "up_md" }, { mins: 60, kind: "dn_md" },
  { mins: 75, kind: "up_lg" }, { mins: 75, kind: "dn_lg" },
  { mins: 90, kind: "up_lg" }, { mins: 90, kind: "dn_lg" },
];

const MOVES = {
  BTC:  { sm: 0.003, md: 0.006, lg: 0.010 },
  ETH:  { sm: 0.004, md: 0.008, lg: 0.015 },
  SOL:  { sm: 0.005, md: 0.010, lg: 0.020 },
  BNB:  { sm: 0.004, md: 0.008, lg: 0.015 },
  XRP:  { sm: 0.005, md: 0.010, lg: 0.020 },
  DOGE: { sm: 0.006, md: 0.012, lg: 0.025 },
};

function fmtStrike(price, coin) {
  const inc = { BTC: 100, ETH: 10, SOL: 1, BNB: 5, XRP: 0.001, DOGE: 0.0001 }[coin] || 1;
  const r = Math.round(price / inc) * inc;
  if (coin === "XRP")  return { num: r, txt: `$${r.toFixed(3)}` };
  if (coin === "DOGE") return { num: r, txt: `$${r.toFixed(4)}` };
  return { num: r, txt: `$${r.toLocaleString()}` };
}

function spawnMarket(coin, spot, slot) {
  const mv = MOVES[coin];
  let pct = 0, dirWord = "be above";
  if (slot.kind === "up_sm") { pct = +mv.sm; dirWord = "rise above"; }
  if (slot.kind === "up_md") { pct = +mv.md; dirWord = "reach"; }
  if (slot.kind === "up_lg") { pct = +mv.lg; dirWord = "hit"; }
  if (slot.kind === "dn_sm") { pct = -mv.sm; dirWord = "drop below"; }
  if (slot.kind === "dn_md") { pct = -mv.md; dirWord = "fall below"; }
  if (slot.kind === "dn_lg") { pct = -mv.lg; dirWord = "drop below"; }

  const strike = fmtStrike(spot * (1 + pct), coin);
  const q = `Will ${coin} ${dirWord} ${strike.txt} in ${slot.mins} minutes?`;
  const id = stableId(`syn_${coin}_${slot.mins}_${slot.kind}_${Date.now()}`, q);
  const def = {
    conditionId: id,
    question:    q,
    coin,
    strike:      strike.num,
    direction:   pct < 0 ? "below" : "above",
    endDateIso:  new Date(Date.now() + slot.mins * 60000).toISOString(),
    slotKey:     `${coin}_${slot.mins}_${slot.kind}`,
    volFactor:   0.85 + Math.random() * 0.40,  // MM's vol disagrees with ours
  };
  _book.set(id, def);
  return def;
}

function quoteMarket(def, spot) {
  const cached = _quotes.get(def.conditionId);
  if (cached && Date.now() - cached.at < QUOTE_TTL) return cached;

  const msLeft = new Date(def.endDateIso) - Date.now();
  const pAbove = probAbove(spot, def.strike, msLeft, def.coin, def.volFactor);
  const pYes   = def.direction === "above" ? pAbove : 1 - pAbove;
  const noise  = () => (Math.random() * 2 - 1) * QUOTE_NOISE;

  const quote = {
    yes: Math.min(0.97, Math.max(0.03, pYes       + HALF_SPREAD + noise())),
    no:  Math.min(0.97, Math.max(0.03, (1 - pYes) + HALF_SPREAD + noise())),
    at:  Date.now(),
  };
  _quotes.set(def.conditionId, quote);
  return quote;
}

async function getSyntheticMarkets() {
  const prices = await getLivePrices();
  const coins  = Object.keys(prices).filter(c => prices[c]);
  if (coins.length === 0) return [];

  // Prune expired markets
  for (const [id, def] of _book) {
    if (new Date(def.endDateIso) - Date.now() < 60000) {
      _book.delete(id);
      _quotes.delete(id);
    }
  }

  // Ensure every coin × ladder slot has a live market (fixed strike per life)
  const filled = new Set([..._book.values()].map(d => d.slotKey));
  for (const coin of coins) {
    for (const slot of LADDER) {
      const key = `${coin}_${slot.mins}_${slot.kind}`;
      if (!filled.has(key)) spawnMarket(coin, prices[coin], slot);
    }
  }

  // Quote the whole book at current spot
  const mkts = [];
  for (const def of _book.values()) {
    const spot = prices[def.coin];
    if (!spot) continue;
    const qt = quoteMarket(def, spot);
    mkts.push({
      conditionId: def.conditionId,
      question:    def.question,
      endDateIso:  def.endDateIso,
      coin:        def.coin,
      tokens: [
        { tokenId: def.conditionId + "_y", outcome: "Yes", price: parseFloat(qt.yes.toFixed(3)) },
        { tokenId: def.conditionId + "_n", outcome: "No",  price: parseFloat(qt.no.toFixed(3)) },
      ],
    });
  }
  console.log(`⚡ Synthetic MM: ${mkts.length} repriced markets, ${coins.length} coins | spread 2¢ | requote ${QUOTE_TTL/1000}s`);
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
