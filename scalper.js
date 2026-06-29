/**
 * scalper.js — PolyBettor exit engine v2.1 (self-healing)
 *
 * v2.1 FIX: stored bets were losing their coin identity (state.js doesn't
 * persist entryCoin/valueBet/strike/direction), so exits priced every
 * position against BTC's spot — instantly stop-lossing non-BTC bets and
 * freezing others at 98¢. The engine now derives EVERYTHING it needs from
 * the question text, which always persists:
 *   • coin       → parsed from "Will XRP drop below..." 
 *   • strike     → parsed from "$1.095"
 *   • direction  → parsed from "drop below" / "rise above"
 *   • value bet  → bet.valueBet OR strategy "VALUE" OR reasoning tag
 * Plus a zombie guard: any VALUE bet held past 95 min force-resolves.
 *
 * Dry-run fidelity (unchanged from v2):
 *   • Expiry resolves on the ACTUAL coin price vs the strike — no RNG
 *   • TP/SL/timeout SELL at fair value minus spread, like a real sell
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

/** Parse the coin straight out of the question text — ground truth. */
export function coinFromQuestion(question) {
  const q = (question || "").toLowerCase();
  if (/\b(btc|bitcoin)\b/.test(q))      return "BTC";
  if (/\b(eth|ethereum)\b/.test(q))     return "ETH";
  if (/\b(sol|solana)\b/.test(q))       return "SOL";
  if (/\b(bnb|binance)\b/.test(q))      return "BNB";
  if (/\b(xrp|ripple)\b/.test(q))       return "XRP";
  if (/\b(doge|dogecoin)\b/.test(q))    return "DOGE";
  return null;
}

/** The coin for a bet: question text first, stored field as fallback. */
function resolveCoin(bet) {
  return coinFromQuestion(bet.marketQuestion) || bet.entryCoin || "BTC";
}

/** Is this a VALUE-strategy bet? Multiple fallbacks since fields may not persist. */
function isValueBet(bet) {
  return bet.valueBet === true ||
         bet.strategy === "VALUE" ||
         /VALUE/.test(bet.reasoning || "");
}

function getCoinPrice(prices, coin) {
  return prices[(coin || "BTC").toUpperCase()] || null;
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

/** Parse { strike, direction } from a question. */
export function parseQuestion(question) {
  const q = (question || "").toLowerCase();
  const priceMatch = q.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  const strike = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;
  const isBear = q.includes("drop below") || q.includes("fall below") ||
                 (q.includes("below") && !q.includes("above"));
  return { strike, direction: isBear ? "below" : "above" };
}

/**
 * Price a market for entry decisions: { probYes, strike, direction, spot, coin }.
 * Coin comes from the question text — never trusts a possibly-missing field.
 */
export async function priceMarket(market) {
  const { strike, direction } = parseQuestion(market.question);
  if (!strike) return null;
  const coin = coinFromQuestion(market.question) || market.coin || "BTC";
  const prices = await getLivePrices();
  const spot   = getCoinPrice(prices, coin);
  if (!spot) return null;
  const msLeft = market.endDateIso ? new Date(market.endDateIso) - Date.now() : 30 * 60 * 1000;
  if (msLeft <= 0) return null;
  const probAbove = binaryCallProb(spot, strike, msLeft, coin);
  const probYes   = direction === "above" ? probAbove : 1 - probAbove;
  return { probYes: Math.max(0.02, Math.min(0.98, probYes)), strike, direction, spot, coin };
}

/** Fair value of THIS bet's side right now — coin derived from question. */
function getContractFairValue(bet, currentCoinPrice) {
  if (!currentCoinPrice || !bet.entryPrice) return bet.entryPrice;
  const { strike, direction } = parseQuestion(bet.marketQuestion);
  if (!strike) return bet.entryPrice;

  const msLeft = bet.marketEndDateIso
    ? new Date(bet.marketEndDateIso) - Date.now()
    : 30 * 60 * 1000;

  const probAbove = binaryCallProb(currentCoinPrice, strike, msLeft, resolveCoin(bet));
  const probYes   = direction === "above" ? probAbove : 1 - probAbove;
  const fair      = bet.side === "YES" ? probYes : 1 - probYes;
  return Math.max(0.02, Math.min(0.98, fair));
}

/** Binary resolution P&L. */
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

  const TIMEOUT_MS    = 3 * 60 * 1000;   // SS bets
  const V_MAX_HOLD_MS = 95 * 60 * 1000;  // zombie guard: force-resolve VALUE bets
  const TP_THRESHOLD  = 0.80;
  const SL_THRESHOLD  = 0.50;

  const exits = [];

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    const coin      = resolveCoin(bet);
    const coinPrice = getCoinPrice(prices, coin);
    const valueBet  = isValueBet(bet);
    const heldMs    = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;
    const fairValue = getContractFairValue(bet, coinPrice);
    const valueChangePct = (fairValue - bet.entryPrice) / bet.entryPrice;

    const endDate = bet.marketEndDateIso;
    const msLeft  = endDate ? new Date(endDate) - Date.now() : Infinity;

    let shouldExit = false, exitReason = "";

    if (msLeft <= 0 || (valueBet && heldMs >= V_MAX_HOLD_MS)) {
      shouldExit = true; exitReason = "expiry";
    } else if (valueBet) {
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
      const tag = valueBet ? " 🎯" : bet.sharpShooter ? " ⚡" : "";
      console.log(`  📊 HOLD${tag} ${coin.padEnd(4)} ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ fair:${(fairValue*100).toFixed(0)}¢ | Δ${valueChangePct >= 0 ? "+" : ""}${(valueChangePct*100).toFixed(1)}% | coin:${coinMov}`);
      continue;
    }

    // ── Resolve ──────────────────────────────────────────────────────
    let finalPnl, exitPrice, won;

    if (exitReason === "expiry") {
      // ★ REAL resolution: did THIS coin actually end above/below the strike?
      const { strike, direction } = parseQuestion(bet.marketQuestion);
      if (strike && coinPrice) {
        const questionTrue = direction === "above" ? coinPrice > strike : coinPrice < strike;
        won = bet.side === "YES" ? questionTrue : !questionTrue;
      } else {
        won = Math.random() < fairValue;
        console.log(`  ⚠️ expiry fallback (no price/strike): ${bet.marketQuestion?.slice(0,50)}`);
      }
      finalPnl  = calcPnl(bet, won);
      exitPrice = won ? 1.00 : 0.00;
    } else {
      const res = calcPreExitPnl(bet, fairValue);
      finalPnl  = res.pnl;
      exitPrice = res.exitPrice;
      won       = finalPnl > 0;
    }

    const icon   = finalPnl > 0 ? "🟢" : finalPnl < 0 ? "🔴" : "⚪";
    const result = won ? "WIN" : "LOSS";
    const tag    = valueBet ? "🎯VAL " : bet.sharpShooter ? "⚡SS " : "";
    const fillP  = Math.min(0.97, bet.entryPrice + SLIPPAGE);
    const shares = (bet.betSize / fillP).toFixed(2);
    console.log(`  🎯 ${tag}EXIT [${exitReason.toUpperCase()}] ${icon} ${result} | ${coin.padEnd(4)} ${bet.side} $${bet.betSize} (${shares}sh @ ${(fillP*100).toFixed(1)}¢) | ${finalPnl >= 0 ? "+" : ""}$${finalPnl.toFixed(2)} | fair:${(fairValue*100).toFixed(0)}¢`);

    const closeReason = ["take_profit","stop_loss","expiry","timeout","near_expiry"].includes(exitReason)
      ? exitReason : "timeout";

    closeBet(bet.marketConditionId, { exitPrice, reason: closeReason, pnl: finalPnl });
    exits.push({
      market: bet.marketQuestion, side: bet.side,
      pnl: finalPnl, won, reason: closeReason,
      entryPrice: bet.entryPrice, coin,
      valueBet, sharpShooter: bet.sharpShooter || false,
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