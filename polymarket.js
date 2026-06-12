/**
 * polymarket.js v4 — REAL Polymarket markets, properly parsed
 *
 * v5 fixes (from live paper-trade forensics):
 * A. STRIKE FREEZE: Up/Down strikes are no longer back-derived from
 *    price history (±90s basis error during fast moves corrupted both
 *    entry edge and resolution). Now: a market's strike is frozen from
 *    the live feed within 20s of its interval OPEN, or the market is
 *    skipped entirely. Markets seen before their open wait ("pending
 *    open") and get frozen on the first scan after the bell.
 * B. FRESH FEEDS: SOL/XRP/DOGE moved from CoinGecko (minutes stale →
 *    fake dislocations) to Kraken (fresh). BNB has no fresh feed, so
 *    BNB is EXCLUDED from real-market trading (synthetic only).
 * C. Faster cadence: price cache 8s, Gamma quote refresh 20s, so
 *    entry prices are never more than ~20s stale.
 *
 * Fixes from v3 (found via Railway diagnostics):
 * 1. DATE BUG: Gamma returns endDateIso as date-only ("2026-06-11" →
 *    parses as midnight, always in the past) alongside endDate (full
 *    timestamp, correct). v3 preferred the broken field → every real
 *    market rejected as expired. v4 parses ALL date fields and uses
 *    the latest valid timestamp.
 * 2. UP/DOWN ENRICHMENT: Polymarket's short-term crypto markets are
 *    "Up or Down" style — no strike in the question, outcomes are
 *    Up/Down. v4 keeps a rolling spot-price history, derives each
 *    interval's open price as the strike, rewrites the question into
 *    the "Will X be above $Y" format the bot/scalper already parse,
 *    and maps Up→Yes / Down→No. Markets whose interval opened before
 *    price history exists are skipped (warmup ~1 interval after boot).
 *
 * Synthetic repriced-MM fallback unchanged (only used if zero real
 * markets qualify).
 */

import axios from "axios";

let _botSettings = null;
async function getDryRun() {
  if (!_botSettings) {
    try { const m = await import("./bot.js"); _botSettings = m.botSettings; } catch {}
  }
  return _botSettings?.dryRun ?? (process.env.DRY_RUN !== "false");
}

// ── Crypto detection ───────────────────────────────────────────
const CRYPTO_KW = [
  "bitcoin","btc","ethereum","eth","solana","sol",
  "bnb","binance coin","xrp","ripple","dogecoin","doge",
];

function coinFrom(qRaw) {
  const q = (qRaw || "").toLowerCase();
  if (/\bbtc\b|bitcoin/.test(q)) return "BTC";
  if (/\beth\b|ethereum/.test(q)) return "ETH";
  if (/\bsol\b|solana/.test(q))   return "SOL";
  if (/\bbnb\b|binance/.test(q))  return "BNB";
  if (/\bxrp\b|ripple/.test(q))   return "XRP";
  if (/doge/.test(q))             return "DOGE";
  return null;
}

function stableId(prefix, question) {
  let hash = 0;
  for (let i = 0; i < question.length; i++) {
    hash = ((hash << 5) - hash) + question.charCodeAt(i);
    hash |= 0;
  }
  return `${prefix}_${Math.abs(hash)}`;
}

/** Latest valid timestamp among Gamma's inconsistent date fields. */
function parseEndMs(m) {
  let best = null;
  for (const c of [m.endDate, m.endDateIso, m.end_date_iso]) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

function jparse(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return null;
}

// ── Live prices + rolling history (feeds Up/Down strikes) ─────
let _priceCache = {}, _priceCacheTime = 0;
const _hist = {};  // coin → [{t, p}]

function recordHistory(prices) {
  const now = Date.now();
  for (const [c, p] of Object.entries(prices)) {
    if (!p) continue;
    (_hist[c] ||= []).push({ t: now, p });
  }
  for (const c of Object.keys(_hist)) {
    _hist[c] = _hist[c].filter(s => now - s.t < 3.5 * 3600000);
  }
}

function spotAt(coin, tMs, tolMs = 90000) {
  let best = null, bd = Infinity;
  for (const s of (_hist[coin] || [])) {
    const d = Math.abs(s.t - tMs);
    if (d < bd) { bd = d; best = s; }
  }
  return best && bd <= tolMs ? best.p : null;
}

const PRICE_TTL = 8000; // fresh enough to freeze strikes at interval opens

async function getLivePrices() {
  if (Date.now() - _priceCacheTime < PRICE_TTL && Object.keys(_priceCache).length > 0) {
    return _priceCache;
  }
  const prices = { ..._priceCache };
  try {
    // Kraken: fresh quotes for everything it lists
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", {
      params: { pair: "XBTUSD,ETHUSD,SOLUSD,XRPUSD,XDGUSD" }, timeout: 5000,
    });
    const r = data.result || {};
    if (r.XXBTZUSD?.c?.[0]) prices.BTC  = parseFloat(r.XXBTZUSD.c[0]);
    if (r.XETHZUSD?.c?.[0]) prices.ETH  = parseFloat(r.XETHZUSD.c[0]);
    if (r.SOLUSD?.c?.[0])   prices.SOL  = parseFloat(r.SOLUSD.c[0]);
    if (r.XXRPZUSD?.c?.[0]) prices.XRP  = parseFloat(r.XXRPZUSD.c[0]);
    if (r.XDGUSD?.c?.[0])   prices.DOGE = parseFloat(r.XDGUSD.c[0]);
  } catch {}
  try {
    // CoinGecko (slow/stale): BNB only — used for synthetic, never real trades
    const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: { ids: "binancecoin", vs_currencies: "usd" },
      timeout: 5000,
    });
    if (data.binancecoin?.usd) prices.BNB = data.binancecoin.usd;
  } catch {}
  if (Object.keys(prices).length > 0) {
    _priceCache = prices;
    _priceCacheTime = Date.now();
    recordHistory(prices);
  }
  return _priceCache;
}

// ── Normalize + enrich real Gamma markets ──────────────────────
const STRIKE_DECIMALS = { BTC: 2, ETH: 2, BNB: 2, SOL: 3, XRP: 4, DOGE: 5 };

function normalizeGammaMarket(m) {
  const outcomes = jparse(m.outcomes)      || ["Yes", "No"];
  const prices   = jparse(m.outcomePrices) || [];
  const tokenIds = jparse(m.clobTokenIds)  || [];
  const endMs    = parseEndMs(m);
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
    endDateIso:  endMs ? new Date(endMs).toISOString() : null,
    endMs,
    coin:        coinFrom(m.question || m.title),
    tokens,
    live: true,
  };
}

/** Parse interval length in minutes from "9:00AM-9:15AM ET" style text. */
function intervalMinutes(q) {
  const r = q.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (r) {
    const t = (h, mm, ap) => ((parseInt(h) % 12) * 60 + parseInt(mm || "0") + (/pm/i.test(ap) ? 720 : 0));
    let diff = t(r[4], r[5], r[6]) - t(r[1], r[2], r[3]);
    if (diff <= 0) diff += 720;
    return diff;
  }
  if (/\d{1,2}(:\d{2})?\s*(AM|PM)/i.test(q)) return 60; // hourly "10AM ET" style
  return null;
}

const REAL_TRADE_COINS = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE"]); // fresh Kraken feeds only
const FREEZE_WINDOW_MS = 20000; // strike must be captured within 20s of the open
const _strikes = new Map();     // conditionId → { strike, endMs }

/**
 * Make a real market priceable by the bot.
 * Returns a NEW market object, "pending" (interval hasn't opened /
 * just opened — strike will freeze on a coming scan), or null (skip:
 * we missed the open, or coin has no fresh feed).
 */
function enrich(m, prices) {
  if (!m.endMs || !m.coin) return null;

  const isUpDown = /up or down/i.test(m.question);

  if (isUpDown) {
    if (!REAL_TRADE_COINS.has(m.coin)) return null; // no fresh feed → never trade it
    const dur = intervalMinutes(m.question);
    if (!dur) return null;
    const startMs = m.endMs - dur * 60000;
    const now = Date.now();

    let frozen = _strikes.get(m.conditionId);
    if (!frozen) {
      if (startMs > now) return "pending"; // listed early — freeze at the bell
      if (now - startMs > FREEZE_WINDOW_MS) return null; // missed the open — untradeable
      const spot = prices[m.coin];
      if (!spot) return "pending";
      frozen = { strike: spot, endMs: m.endMs };
      _strikes.set(m.conditionId, frozen);
    }

    const dec = STRIKE_DECIMALS[m.coin] ?? 2;
    const endLabel = new Date(m.endMs).toISOString().slice(11, 16);
    return {
      ...m,
      question: `Will ${m.coin} be above $${frozen.strike.toFixed(dec)} at ${endLabel} UTC? (UpDown${dur})`,
      tokens: m.tokens.map(t => ({
        ...t,
        outcome: /^up$/i.test(t.outcome) ? "Yes" : /^down$/i.test(t.outcome) ? "No" : t.outcome,
      })),
    };
  }

  // Non-UpDown: keep only markets the bot can actually price
  // (needs a $ strike and a direction word in the question)
  const hasStrike = /\$[\d,]+(\.\d+)?/.test(m.question);
  const hasDir    = /above|below|reach|hit|higher|lower|rise|drop|fall/i.test(m.question);
  if (!hasStrike || !hasDir) return null;
  const hasYesNo = m.tokens.some(t => /^(yes|no)$/i.test(t.outcome));
  return hasYesNo ? m : null;
}

let _gammaRaw = null, _gammaRawTime = 0;
const GAMMA_TTL = 20000; // refetch real quotes every 20s so entry prices stay fresh

export async function fetchBTCMarkets() {
  const prices = await getLivePrices(); // fresh spot — feeds strike freezing

  try {
    if (!_gammaRaw || Date.now() - _gammaRawTime > GAMMA_TTL) {
      const nowIso = new Date(Date.now() + 4 * 60000).toISOString();
      const maxIso = new Date(Date.now() + 3 * 3600000).toISOString();
      const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
        params: {
          active: true, closed: false, limit: 300,
          order: "endDate", ascending: true,
          end_date_min: nowIso, end_date_max: maxIso,
        },
        timeout: 10000,
      });
      const all = Array.isArray(data) ? data : (data?.markets || []);
      _gammaRaw = all.filter(m => {
        const q = (m.question || m.title || "").toLowerCase();
        return CRYPTO_KW.some(kw => q.includes(kw));
      });
      _gammaRawTime = Date.now();
      // prune frozen strikes for expired markets
      for (const [id, f] of _strikes) {
        if (f.endMs < Date.now() - 60000) _strikes.delete(id);
      }
    }

    const inWindow = _gammaRaw
      .map(normalizeGammaMarket)
      .filter(m => {
        if (!m.endMs) return false;
        const mins = (m.endMs - Date.now()) / 60000;
        return mins >= 4 && mins <= 180;
      });

    // Enrich EVERY call (cheap, no network) so strikes freeze within
    // one 8s scan of each interval's open.
    let pending = 0;
    const ready = [];
    for (const m of inWindow) {
      const r = enrich(m, prices);
      if (r === "pending") pending++;
      else if (r) ready.push(r);
    }

    if (ready.length > 0) {
      console.log(
        `📊 Polymarket LIVE: ${ready.length} real mkts, strikes frozen at open` +
        (pending ? ` | ${pending} pending open` : "") +
        ` — paper trading REAL prices`
      );
      return ready;
    }

    if (inWindow.length > 0) {
      console.log(`📊 Gamma: ${inWindow.length} crypto markets in window, 0 tradeable (${pending} pending open). Nearest:`);
      inWindow.slice(0, 3).forEach(m => {
        const mins = ((m.endMs - Date.now()) / 60000).toFixed(0);
        console.log(`   · "${m.question.slice(0, 55)}" (${mins} min)`);
      });
    } else if (_gammaRaw.length > 0) {
      const crypto = _gammaRaw;
      console.log(`📊 Gamma: ${crypto.length} crypto markets found, 0 in 4-180min window. Nearest:`);
      crypto.slice(0, 3).forEach(m => {
        const ms = parseEndMs(m);
        const mins = ms === null ? "unparseable" : ((ms - Date.now()) / 60000).toFixed(0) + " min";
        console.log(`   · "${(m.question || "").slice(0, 55)}" end=${ms ? new Date(ms).toISOString() : "?"} (${mins})`);
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

// ── Black-Scholes for synthetic MM ─────────────────────────────
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

// ── Synthetic market registry (fallback only) ──────────────────
const HALF_SPREAD = 0.01;
const QUOTE_NOISE = 0.015;
const QUOTE_TTL   = 30000;

const _book = new Map();
const _quotes = new Map();

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
    volFactor:   0.85 + Math.random() * 0.40,
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

  for (const [id, def] of _book) {
    if (new Date(def.endDateIso) - Date.now() < 60000) {
      _book.delete(id);
      _quotes.delete(id);
    }
  }

  const filled = new Set([..._book.values()].map(d => d.slotKey));
  for (const coin of coins) {
    for (const slot of LADDER) {
      const key = `${coin}_${slot.mins}_${slot.kind}`;
      if (!filled.has(key)) spawnMarket(coin, prices[coin], slot);
    }
  }

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

  // LIVE MODE — polymarket.us Ed25519 signing + fill tracking
  const pk     = process.env.POLYMARKET_PRIVATE_KEY;
  const apiKey = process.env.POLYMARKET_API_KEY;
  if (!pk || pk.startsWith("your_") || !apiKey || apiKey.startsWith("your_")) {
    throw new Error("Live mode requires POLYMARKET_PRIVATE_KEY + POLYMARKET_API_KEY env vars");
  }

  try {
    const { postAndPollOrder, roundToTick } = await import("./live-clob.js");
    const result = await postAndPollOrder(
      tokenId,
      side,
      size,
      price,
      apiKey,
      pk,
      marketQuestion
    );

    if (result.error) {
      console.log(`    ⚠️  Order failed: ${result.error} | ${side} $${size} @ ${(price*100).toFixed(1)}¢`);
      throw new Error(result.error);
    }

    if (result.filled) {
      const payout = parseFloat((size / result.fillPrice).toFixed(2));
      const profit = parseFloat((payout - size).toFixed(2));
      const slippage = result.fillPrice - price;
      console.log(
        `    ✅ FILLED ${side} $${size} @ ${(result.fillPrice*100).toFixed(1)}¢` +
        (Math.abs(slippage) > 0.001 ? ` (vs ${(price*100).toFixed(1)}¢, slip: ${(slippage*100).toFixed(1)}¢)` : "") +
        ` | win → $${payout} (+$${profit})`
      );
      return {
        orderID: result.orderId,
        tokenId,
        side,
        size: result.size,
        price: result.fillPrice,
        potentialPayout: payout,
        potentialProfit: profit,
        marketQuestion,
        status: "live_filled",
        timestamp: new Date().toISOString(),
      };
    } else {
      console.log(`    ⚠️  Order ${result.orderId} did not fill in 10s, cancelled`);
      throw new Error("Order timeout");
    }
  } catch (err) {
    throw new Error("Live order failed: " + err.message);
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
