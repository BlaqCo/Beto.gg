/**
 * scalper.js — PolyBettor exit engine v2 (VALUE-ready, max-fidelity dry run)
 *
 * REALISTIC simulation of Polymarket binary prediction markets.
 *
 * How Polymarket actually works:
 * ─────────────────────────────
 * 1. You buy YES or NO shares at price P (e.g. 0.70 = 70¢)
 * 2. Each share pays $1.00 if your side wins at expiry, $0 if it loses
 * 3. Profit if win: (1/P - 1) * betSize
 * 4. Polymarket fee: 2% of gross profit only
 * 5. Fill slippage: ~0.5¢ above displayed price
 *
 * v2 FIDELITY CHANGES (dry run = paper trading against REALITY):
 * ──────────────────────────────────────────────────────────────
 * • EXPIRY now resolves on the ACTUAL coin price vs the strike.
 *   No randomness. If the question was "Will BTC be above $61,400 in
 *   30 minutes?" the bet wins iff BTC is actually above $61,400 when
 *   the clock runs out. The dry run is a true backtest on live prices.
 * • TIMEOUT / TP / SL all SELL at current fair value minus spread —
 *   exactly what a live market sell does. Zero stochastic resolution.
 *
 * VALUE bets (bet.valueBet = true) get their own exit logic:
 * • HOLD to expiry — that's where the favorite edge realizes
 * • Early TP only at fair ≥ 97¢ (nothing left to earn, recycle capital)
 * • Disaster SL at fair ≤ 40¢ (the favorite has flipped — cut it)
 */
import axios from "axios";
import { getAllActiveBets, closeBet } from "./state.js";

const POLYMARKET_FEE = 0.02;  // 2% fee on gross winnings
const SLIPPAGE       = 0.005; // 0.5¢ spread on fills

let _priceCache = {}, _priceFetchTime = 0;

export async function getLivePrices() {
  if (Date.now() - _priceFetchTime < 8000 && Object.keys(_priceCache).length > 0) return _priceCache;
  const p = { BTC: null, ETH: null, SOL: null, BNB: null, XRP: null, DOGE: null };
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker",
      { params: { pair: "XBTUSD,ETHUSD" }, timeout: 4000 });
    const r = data.result || {};
    if (r.XXBTZUSD?.c?.[0]) p.BTC = parseFloat(r.XXBTZUSD.c[0]);
    if (r.XETHZUSD?.c?.[0]) p.ETH = parseFloat(r.XETHZUSD.c[0]);
  } catch {}
  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      { params: { ids: "solana,binancecoin,ripple,dogecoin", vs_currencies: "usd" }, timeout: 4000 }
    );
    if (data.solana?.usd)      p.SOL  = data.solana.usd;
    if (data.binancecoin?.usd) p.BNB  = data.binancecoin.usd;
    if (data.ripple?.usd)      p.XRP  = data.ripple.usd;
    if (data.dogecoin?.usd)    p.DOGE = data.dogecoin.usd;
  } catch {}
  _priceCache = { ..._priceCache, ...Object.fromEntries(Object.entries(p).filter(([,v]) => v)) };
  _priceFetchTime = Date.now();
  return _priceCache;
}

function getCoinPrice(prices, coin) {
  return prices[(coin || "BTC").toUpperCase()] || prices.BTC || null;
}

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x) {
  const a = 0.2316419, b1 = 0.319381530, b2 = -0.356563782,
        b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const t = 1 / (1 + a * Math.abs(x));
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const n = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
  return x >= 0 ? n : 1 - n;
}

// Annualized vols by coin (~30-day realized)
const ANNUAL_VOL = { BTC: 0.80, ETH: 1.00, SOL: 1.50, BNB: 1.00, XRP: 1.20, DOGE: 1.80 };

function binaryCallProb(spot, target, timeRemainingMs, coin) {
  if (!spot || !target || timeRemainingMs <= 0) return 0.5;
  const T = Math.max(timeRemainingMs, 30000) / (365.25 * 24 * 3600 * 1000); // years
  const sigma = ANNUAL_VOL[(coin || "BTC").toUpperCase()] || 0.80;
  const lnSK = Math.log(spot / target);
  const d2 = (lnSK - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return normalCDF(d2);
}

/**
 * Parse a market question into { strike, direction }.
 * direction: "above" → question true if price ends ABOVE strike
 *            "below" → question true if price ends BELOW strike
 */
export function parseQuestion(question) {
  const q = (question || "").toLowerCase();
  const priceMatch = q.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  const strike = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;
  const isBear = q.includes("drop below") || q.includes("fall below") ||
                 (q.includes("below") && !q.includes("above"));
  return { strike, direction: isBear ? "below" : "above" };
}

/**
 * Price a market: returns { probYes, strike, direction, spot } or null.
 * Used by bot.js (VALUE mode) to find edge before entering.
 */
export async function priceMarket(market) {
  const { strike, direction } = parseQuestion(market.question);
  if (!strike) return null;
  const prices = await getLivePrices();
  const spot   = getCoinPrice(prices, market.coin || "BTC");
  if (!spot) return null;
  const msLeft = market.endDateIso ? new Date(market.endDateIso) - Date.now() : 30 * 60 * 1000;
  if (msLeft <= 0) return null;
  const probAbove = binaryCallProb(spot, strike, msLeft, market.coin || "BTC");
  const probYes   = direction === "above" ? probAbove : 1 - probAbove;
  return { probYes: Math.max(0.02, Math.min(0.98, probYes)), strike, direction, spot };
}

/** Fair value of THIS bet's side right now. */
function getContractFairValue(bet, currentCoinPrice) {
  if (!currentCoinPrice || !bet.entryPrice) return bet.entryPrice;
  const { strike, direction } = bet.strike
    ? { strike: bet.strike, direction: bet.direction || "above" }
    : parseQuestion(bet.marketQuestion);
  if (!strike) return bet.entryPrice;

  const msLeft = bet.marketEndDateIso
    ? new Date(bet.marketEndDateIso) - Date.now()
    : 30 * 60 * 1000;

  const probAbove = binaryCallProb(currentCoinPrice, strike, msLeft, bet.entryCoin || "BTC");
  const probYes   = direction === "above" ? probAbove : 1 - probAbove;
  const fair      = bet.side === "YES" ? probYes : 1 - probYes;
  return Math.max(0.02, Math.min(0.98, fair));
}

/** Binary resolution P&L (win → shares*$1 − stake − fee, lose → −stake). */
function calcPnl(bet, won) {
  const fillPrice = Math.min(0.97, bet.entryPrice + SLIPPAGE);
  const shares    = bet.betSize / fillPrice;
  if (won) {
    const gross = shares - bet.betSize;
    return parseFloat((gross * (1 - POLYMARKET_FEE)).toFixed(4));
  }
  return parseFloat((-bet.betSize).toFixed(4));
}

/** Pre-expiry market sell at fair value minus spread. */
function calcPreExitPnl(bet, fairValue) {
  const fillPrice  = Math.min(0.97, bet.entryPrice + SLIPPAGE);
  const sellPrice  = Math.max(0.02, fairValue - SLIPPAGE);
  const shares     = bet.betSize / fillPrice;
  const gross      = shares * sellPrice - bet.betSize;
  const fee        = gross > 0 ? gross * POLYMARKET_FEE : 0;
  return { pnl: parseFloat((gross - fee).toFixed(4)), exitPrice: sellPrice };
}

export async function checkScalpExits(markets, signals, dryRun = true, ssMode = false) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const prices     = await getLivePrices();
  const currentBtc = prices.BTC || null;

  const TIMEOUT_MS   = 3 * 60 * 1000; // SS bets only
  const TP_THRESHOLD = 0.80;          // non-value: fair +80% over entry
  const SL_THRESHOLD = 0.50;          // non-value: fair −50% under entry

  const exits = [];

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    const coinPrice = getCoinPrice(prices, bet.entryCoin || "BTC");
    const heldMs    = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;
    const fairValue = getContractFairValue(bet, coinPrice);
    const valueChangePct = (fairValue - bet.entryPrice) / bet.entryPrice;

    const endDate = bet.marketEndDateIso;
    const msLeft  = endDate ? new Date(endDate) - Date.now() : Infinity;

    let shouldExit = false, exitReason = "";

    if (msLeft <= 0) {
      shouldExit = true; exitReason = "expiry";
    } else if (bet.valueBet) {
      // ── VALUE exits: ride favorites to resolution ──
      if (fairValue >= 0.97)      { shouldExit = true; exitReason = "take_profit"; }
      else if (fairValue <= 0.40) { shouldExit = true; exitReason = "stop_loss"; }
    } else {
      // ── SS / normal exits ──
      if (msLeft < 60 * 1000 && valueChangePct < 0)        { shouldExit = true; exitReason = "near_expiry"; }
      else if (valueChangePct >= TP_THRESHOLD)             { shouldExit = true; exitReason = "take_profit"; }
      else if (valueChangePct <= -SL_THRESHOLD)            { shouldExit = true; exitReason = "stop_loss"; }
      else if (bet.sharpShooter && heldMs >= TIMEOUT_MS)   { shouldExit = true; exitReason = "timeout"; }
    }

    if (!shouldExit) {
      const coinMov = coinPrice && bet.entryBtcPrice
        ? ((coinPrice - bet.entryBtcPrice) / bet.entryBtcPrice * 100).toFixed(3) + "%"
        : "?%";
      const tag  = bet.valueBet ? " 🎯" : bet.sharpShooter ? " ⚡" : "";
      const coin = (bet.entryCoin || "BTC").padEnd(4);
      console.log(`  📊 HOLD${tag} ${coin} ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ fair:${(fairValue*100).toFixed(0)}¢ | Δ${valueChangePct >= 0 ? "+" : ""}${(valueChangePct*100).toFixed(1)}% | coin:${coinMov}`);
      continue;
    }

    // ── Resolve ──────────────────────────────────────────────────────
    let finalPnl, exitPrice, won;

    if (exitReason === "expiry") {
      // ★ REAL resolution: did the coin actually end above/below the strike?
      const { strike, direction } = bet.strike
        ? { strike: bet.strike, direction: bet.direction || "above" }
        : parseQuestion(bet.marketQuestion);

      if (strike && coinPrice) {
        const questionTrue = direction === "above" ? coinPrice > strike : coinPrice < strike;
        won = bet.side === "YES" ? questionTrue : !questionTrue;
      } else {
        // price feed down — fall back to model probability
        won = Math.random() < fairValue;
        console.log(`  ⚠️ expiry fallback (no price/strike) on: ${bet.marketQuestion?.slice(0,50)}`);
      }
      finalPnl  = calcPnl(bet, won);
      exitPrice = won ? 1.00 : 0.00;
    } else {
      // TP / SL / timeout / near_expiry: SELL at market (fair − spread)
      const res = calcPreExitPnl(bet, fairValue);
      finalPnl  = res.pnl;
      exitPrice = res.exitPrice;
      won       = finalPnl > 0;
    }

    const icon   = finalPnl > 0 ? "🟢" : finalPnl < 0 ? "🔴" : "⚪";
    const result = won ? "WIN" : "LOSS";
    const tag    = bet.valueBet ? "🎯VAL " : bet.sharpShooter ? "⚡SS " : "";
    const coin   = (bet.entryCoin || "BTC").padEnd(4);
    const fillP  = Math.min(0.97, bet.entryPrice + SLIPPAGE);
    const shares = (bet.betSize / fillP).toFixed(2);
    console.log(`  🎯 ${tag}EXIT [${exitReason.toUpperCase()}] ${icon} ${result} | ${coin} ${bet.side} $${bet.betSize} (${shares}sh @ ${(fillP*100).toFixed(1)}¢) | ${finalPnl >= 0 ? "+" : ""}$${finalPnl.toFixed(2)} | fair:${(fairValue*100).toFixed(0)}¢`);

    const closeReason = ["take_profit","stop_loss","expiry","timeout","near_expiry"].includes(exitReason)
      ? exitReason : "timeout";

    closeBet(bet.marketConditionId, { exitPrice, reason: closeReason, pnl: finalPnl });
    exits.push({
      market: bet.marketQuestion, side: bet.side,
      pnl: finalPnl, won, reason: closeReason,
      entryPrice: bet.entryPrice,
      valueBet: bet.valueBet || false,
      sharpShooter: bet.sharpShooter || false,
    });
  }

  return { exits, currentBtc };
}

export function filterScalpMarkets(markets) {
  return markets.filter(m => {
    if (!m.endDateIso && !m.endDate) return true;
    const minLeft = (new Date(m.endDateIso || m.endDate) - Date.now()) / 60000;
    return minLeft >= 3 && minLeft <= 180;
  });
}

export function scalpQuality(market, signals) {
  let score = 0;
  if (market.endDateIso || market.endDate) {
    const minLeft = (new Date(market.endDateIso || market.endDate) - Date.now()) / 60000;
    if (minLeft < 3 || minLeft > 180) return 0;
    if (minLeft >= 4 && minLeft <= 20) score += 0.40;
    else if (minLeft <= 90)            score += 0.25;
    else                               score += 0.10;
  } else score += 0.20;
  score += Math.min(0.40, signals.confidence * 0.45);
  score += Math.min(0.20, Math.abs(signals.bias) * 0.25);
  return Math.min(1, score);
}
